"""
sheets.py — shared character-sheet storage, used by BOTH Flask apps:

  * char_creator.py  (port 5000) — build/creation/campaign API
  * play_server.py   (port 5001) — live-session/play API (new)

Both processes read and write the exact same files in char_sheets/, so a
character built in the creator is immediately playable in the play UI, and
changes made during play (hp, buffs, resources, inventory use, xp) show up
next time the creator loads that sheet. There is no locking — this is a
single-DM-machine tool, not a multi-writer database — so avoid editing the
same character in both UIs at literally the same instant.

This module owns:
  - the on-disk sheet format (sheet_path / load_sheet / save_sheet)
  - derived fields (ability modifiers)
  - the additive "state" block used for live play: hp, resources (spell
    slots, rage uses, ki, hero points, ... anything with a current/max),
    buffs/conditions, and a rolling action log.

The "state" block is additive and migrates old sheets automatically —
a character JSON created before this existed (like your `tav` sheet) just
gets sane defaults filled in the first time it's loaded here.
"""

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
SHEET_DIR = BASE_DIR / "char_sheets"
SHEET_DIR.mkdir(exist_ok=True)

STD_ABILITIES = [
    "strength",
    "dexterity",
    "constitution",
    "intelligence",
    "wisdom",
    "charisma",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_message(
    text: str,
    from_name: str = "DM",
    kind: str = "note",
    to: str = "self",
) -> dict:
    """Create a hidden message (used for level-up notices, DM whispers, ...)."""
    return {
        "id": uuid.uuid4().hex[:10],
        "from": from_name,
        "to": to,
        "kind": kind,
        "text": text,
        "created_at": _now(),
        "read": False,
    }


def _modify(score: int) -> int:
    return (int(score) - 10) // 2


def derive(sheet: dict) -> dict:
    """Recompute derived fields (currently: ability modifiers for the
    standard six-ability fantasy layout; other systems are left alone)."""
    ab = sheet.get("abilities", {})
    if set(STD_ABILITIES).issubset(set(ab)):
        sheet["abilities"]["modifiers"] = {
            k: _modify(ab[k])
            for k in STD_ABILITIES
            if isinstance(ab.get(k), (int, float))
        }
    return sheet


# --------------------------------------------------------------------------- #
# Live-play "state" block                                                     #
# --------------------------------------------------------------------------- #
#
#   "state": {
#     "hp":        {"current": 10, "max": 10, "temp": 0},
#     "stats":     {"ac": 15, "speed": 30, "initiative_bonus": 2},
#     "resources": {
#         "spell_slots_1": {"current": 4, "max": 4, "label": "1st-level slots"},
#         "rage":          {"current": 2, "max": 2,  "label": "Rages"}
#     },
#     "buffs": [
#         {"id": "...", "name": "Bless", "description": "...",
#          "source": "Cleric spell", "kind": "buff",
#          "duration_rounds": 10, "applied_at": "..."}
#     ],
#     "action_log": [
#         {"id": "...", "type": "attack", "description": "...", "at": "..."}
#     ]
#   }
#
# `resources` is a deliberately generic {key: {current, max, label}} pool so
# it covers spell slots, rages, ki points, ammo, ... for any game system —
# nothing here is D&D-specific. `buffs` doubles as conditions/debuffs
# (kind: "buff" | "debuff" | "condition"); duration_rounds is optional and
# decremented by the /buffs/tick endpoint.

def _default_state() -> dict:
    return {
        "hp": {"current": None, "max": None, "temp": 0},
        "stats": {},
        "resources": {},
        "buffs": [],
        "action_log": [],
    }


def ensure_state(sheet: dict) -> dict:
    """Additive migration: guarantee sheet['state'] exists and is well-formed,
    without touching anything else. Safe to call on every load."""
    state = sheet.get("state")
    if not isinstance(state, dict):
        state = {}
    defaults = _default_state()
    for key, default_val in defaults.items():
        if key not in state or type(state[key]) is not type(default_val):
            state[key] = default_val
    hp = state["hp"]
    for k, v in {"current": None, "max": None, "temp": 0}.items():
        hp.setdefault(k, v)
    sheet["state"] = state
    return sheet


def sheet_path(sheet_id: str) -> Path:
    return SHEET_DIR / f"char_sheet_{sheet_id}.json"


def load_sheet(sheet_id: str) -> dict | None:
    import json
    path = sheet_path(sheet_id)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            sheet = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    ensure_state(sheet)
    return sheet


def save_sheet(sheet: dict) -> dict:
    import json
    sheet = derive(sheet)
    ensure_state(sheet)
    sheet["updated_at"] = _now()
    with open(sheet_path(sheet["id"]), "w", encoding="utf-8") as f:
        json.dump(sheet, f, indent=2, ensure_ascii=False)
    return sheet


def list_sheet_ids() -> list[str]:
    return sorted(
        p.stem.replace("char_sheet_", "", 1)
        for p in SHEET_DIR.glob("char_sheet_*.json")
    )


def is_npc(sheet: dict) -> bool:
    """A character is an NPC if it carries a top-level `"npc": true` flag.
    Nothing else in the schema changes — set/unset it by hand, or via the
    DM dashboard's 'New NPC' action."""
    return bool(sheet.get("npc"))


# --------------------------------------------------------------------------- #
# Inventory transfer helpers (used by trading and by DM item grants)          #
# --------------------------------------------------------------------------- #

def take_items(inventory: list, items: list) -> list:
    """Remove `items` ([{name, qty}]) from `inventory` by name, case-
    insensitively. Raises ValueError (nothing is mutated) if any item isn't
    present in sufficient quantity. Returns the new inventory list."""
    inv = [dict(entry) for entry in inventory]  # work on a copy first
    for want in items:
        name = str(want.get("name", "")).strip()
        qty = int(want.get("qty", 1) or 1)
        idx = next(
            (i for i, e in enumerate(inv) if e.get("name", "").lower() == name.lower()),
            None,
        )
        have = int(inv[idx].get("qty", 1)) if idx is not None else 0
        if idx is None or have < qty:
            raise ValueError(f"not enough '{name}' (have {have}, need {qty})")
        if have == qty:
            inv.pop(idx)
        else:
            inv[idx]["qty"] = have - qty
    return inv


def give_items(inventory: list, items: list) -> list:
    """Add `items` ([{name, qty, notes?}]) to `inventory`, merging into an
    existing stack by name (case-insensitive) when one exists."""
    inv = [dict(entry) for entry in inventory]
    for got in items:
        name = str(got.get("name", "")).strip()
        if not name:
            continue
        qty = int(got.get("qty", 1) or 1)
        idx = next(
            (i for i, e in enumerate(inv) if e.get("name", "").lower() == name.lower()),
            None,
        )
        if idx is not None:
            inv[idx]["qty"] = int(inv[idx].get("qty", 1)) + qty
        else:
            inv.append({"name": name, "qty": qty, "notes": got.get("notes", "")})
    return inv


# --------------------------------------------------------------------------- #
# Action log                                                                   #
# --------------------------------------------------------------------------- #

MAX_ACTION_LOG = 200


def log_action(sheet: dict, entry_type: str, description: str, **extra) -> dict:
    """Append an entry to sheet['state']['action_log'] (auto-trimmed)."""
    import uuid
    ensure_state(sheet)
    log = sheet["state"]["action_log"]
    entry = {
        "id": uuid.uuid4().hex[:10],
        "type": entry_type,
        "description": description,
        "at": _now(),
        **extra,
    }
    log.append(entry)
    del log[:-MAX_ACTION_LOG]
    return entry
