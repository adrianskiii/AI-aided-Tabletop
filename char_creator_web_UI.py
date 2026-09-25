"""
Char Creator — API-based, non-AI character creator for tabletop sessions.

Modular architecture
--------------------
- Game systems   → `games/*.json`  (local profiles, editable, open-ended)
                   + remote systems fetched from the Dungeon Masters API
                   (https://api.dms.gg/systems) — D&D, Pathfinder,
                   Cyberpunk, etc. No API key required.
- Campaigns      → `campaigns.json` (locally authored campaigns)
                   + remote 5e adventures from 5etools.com
                   + a pure "AI-generated" campaign option.
  Both are merged server-side behind /api/games and /api/campaigns so the
  web UI (and any future AI narrator) consumes one stable interface.
  Remote sources are cached in `.cache/` and degrade gracefully offline.

Rules knowledge (what the sheet displays when you click "what is this?"):
  - `remote.py`     shared HTTP + 6 h cache for all remote sources
  - `fiveetools.py` 5e SRD data from api.5etools.co (skills, races, classes
                    incl. per-level features a.k.a. level-up buffs,
                    backgrounds, spells, conditions, damage, alignments)
  - exposed at GET /api/rules/<system> and GET /api/adventure/<id>.

Output: one JSON file per character (char_sheets/char_sheet_<id>.json):
  identity / abilities / background / details / public (group-known) /
  hidden (DM-only: hidden agendas, secrets, dm_notes) + campaign link.

Run:  python3 char_creator.py   →   http://127.0.0.1:5000
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory

import fiveetools
import pf2etools
from remote import cached_remote

# --------------------------------------------------------------------------- #
#  Config                                                                      #
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
SHEET_DIR = BASE_DIR / "char_sheets"
GAME_DIR = BASE_DIR / "games"
CAMPAIGNS_FILE = BASE_DIR / "campaigns.json"
for _d in (SHEET_DIR, GAME_DIR):
    _d.mkdir(exist_ok=True)

DMS_API_URL = "https://api.dms.gg/systems"
E5TTOOLS_ADVENTURES_URL = "https://www.5etools.com/api/adventures?per_page=100"

app = Flask(__name__)

STD_ABILITIES = ["strength", "dexterity", "constitution",
                 "intelligence", "wisdom", "charisma"]


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _want_remote() -> bool:
    return request.args.get("remote", "true").lower() != "false"


# --------------------------------------------------------------------------- #
#  Game profile registry (local JSON + remote systems)                         #
# --------------------------------------------------------------------------- #

def normalize_game(data: dict, source: str) -> dict:
    """Coerce any shape (local file, dms.gg row, …) into a game profile."""
    g = dict(data)
    g.setdefault("id", str(data.get("key") or data.get("slug")
                           or data.get("id") or "custom"))
    g.setdefault("label", data.get("name") or g["id"])
    g.setdefault("description", data.get("description", ""))
    g.setdefault("tldr", data.get("tldr") or g["description"])
    g.setdefault("links", {"rules": [], "wiki": None, "data_api": None})
    g.setdefault("genre", data.get("genre", ""))
    g.setdefault("source", source)

    fields = {}
    for key, src in (("race", "races"), ("class", "classes"),
                     ("alignment", "alignments")):
        f = data.get("fields", {}).get(key)
        fields[key] = dict(f) if isinstance(f, dict) else {"suggestions": []}
        fields[key].setdefault("label", key.title())
        fields[key].setdefault("suggestions", data.get(src, ["Custom..."]))
        if not isinstance(fields[key]["suggestions"], list):
            fields[key]["suggestions"] = ["Custom..."]
    g["fields"] = fields

    bg = data.get("backgrounds")
    g["backgrounds"] = (dict(bg) if isinstance(bg, dict)
                        else {"suggestions": bg if isinstance(bg, list)
                              else ["Custom..."]})
    g["backgrounds"].setdefault("label", "Background")
    g["backgrounds"].setdefault("suggestions", ["Custom..."])

    ab = data.get("abilities")
    g["abilities"] = dict(ab) if isinstance(ab, dict) else {}
    g["abilities"].setdefault("enabled", True)
    g["abilities"].setdefault("scores", list(STD_ABILITIES))
    g["abilities"].setdefault("min", 1)
    g["abilities"].setdefault("max", 30)
    g["abilities"].setdefault("default", 10)

    # Optional progression (xp → level). Empty dict → no xp tracking.
    prog = data.get("progression")
    g["progression"] = (dict(prog) if isinstance(prog, dict)
                        else {"xp_levels": []})
    g["progression"].setdefault("level_field", "identity.level")
    g["progression"].setdefault("xp_levels", [])
    return g


def local_games() -> dict:
    """All game profiles from games/*.json (source="local")."""
    out = {}
    for p in sorted(GAME_DIR.glob("*.json")):
        try:
            with open(p, encoding="utf-8") as f:
                out[p.stem] = normalize_game(json.load(f), "local")
        except (json.JSONDecodeError, OSError):
            continue
    return out


def remote_systems() -> list:
    """Playable systems from the Dungeon Masters API (dms.gg).

    Returns a list of game-profile dicts (source="remote").
    Offline or malformed responses yield [].
    """
    data = cached_remote(DMS_API_URL)
    if not data:
        return []
    rows = data.get("data", data) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    out, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("key") or row.get("slug") or row.get("id") or "")
        name = row.get("name") or row.get("label")
        if not slug or not name:
            continue
        g = normalize_game(row, "remote")
        g["id"] = "dms_" + g["id"].lower()
        if g["id"] in seen:
            continue
        seen.add(g["id"])
        out.append(g)
    return out


def all_games(include_remote: bool = True) -> dict:
    games = local_games()
    if include_remote:
        for g in remote_systems():
            games.setdefault(g["id"], g)  # local profiles win over remotes
    return games


# --------------------------------------------------------------------------- #
#  Campaigns (local file + 5etools adventures + AI-generated)                  #
# --------------------------------------------------------------------------- #

def load_local_campaigns() -> list:
    try:
        with open(CAMPAIGNS_FILE, encoding="utf-8") as f:
            return json.load(f).get("campaigns", [])
    except (OSError, json.JSONDecodeError):
        return []


def save_local_campaigns(campaigns: list):
    with open(CAMPAIGNS_FILE, "w", encoding="utf-8") as f:
        json.dump({"campaigns": campaigns}, f, indent=2, ensure_ascii=False)


def local_campaigns(for_system: str | None = None) -> list:
    out = []
    for c in load_local_campaigns():
        c = dict(c)
        c.setdefault("source", "local")
        c.setdefault("ai_generated", c.get("type") == "aigenerated")
        if for_system and c.get("system") not in (None, "any", for_system):
            continue
        out.append(c)
    return out


def remote_adventures() -> list:
    """5e adventures from 5etools — the big 5e campaign database."""
    data = cached_remote(E5TTOOLS_ADVENTURES_URL)
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not (row.get("isAdventure") or row.get("type") == "adventure"):
            continue
        book = row.get("book")
        out.append({
            "id": "5etools_" + str(row.get("slug") or row.get("id")),
            "title": row.get("name", ""),
            "system": "dnd5e",
            "type": "premade",
            "description": (row.get("blurb") or row.get("description")
                            or "")[:400],
            "setting": (book.get("name", "") if isinstance(book, dict)
                        else "") or "5e sourcebook",
            "page_count": row.get("pageCount"),
            "ai_generated": False,
            "source": "5etools",
            "url": row.get("page_url", ""),
        })
    return out


def ai_campaign_option(system: str | None) -> dict:
    return {
        "id": "ai-generated",
        "title": "✨ AI-generated campaign (fresh)",
        "system": system or "any",
        "type": "aigenerated",
        "description": "No premade story — the AI narrator invents the world "
                       "and plot around your party. Give it a seed and it "
                       "fills the setting + world_notes at first session.",
        "setting": "",
        "tone": "",
        "ai_generated": True,
        "source": "ai",
    }


def all_campaigns(for_system: str | None, include_remote: bool = True) -> list:
    """Merged campaign list; the first entry is the AI-generated option."""
    out = [ai_campaign_option(for_system)]
    out += sorted(local_campaigns(for_system), key=lambda c: c.get("title", ""))
    if include_remote and for_system in (None, "any", "dnd5e"):
        out += remote_adventures()
    return out


# --------------------------------------------------------------------------- #
#  Character storage                                                           #
# --------------------------------------------------------------------------- #

def new_sheet(system: str) -> dict:
    """Blank character sheet in the target JSON shape."""
    game = all_games().get(system, {})
    ab = game.get("abilities", {})
    scores = ab.get("scores") or list(STD_ABILITIES)
    default_val = ab.get("default", 10)
    return {
        "id": uuid.uuid4().hex[:12],
        "system": system,
        "system_label": game.get("label", "Custom System"),
        "campaign": {"id": None, "title": None, "ai_generated": False,
                     "seed": ""},
        "created_at": _now(),
        "updated_at": _now(),
        "visibility": {"hidden_revealed": False},
        "identity": {
            "name": "", "race": "", "class": "", "level": 1,
            "gender": "", "age": "", "appearance": "", "player_name": "",
        },
        "abilities": {**{s: default_val for s in scores}, "notes": ""},
        "background": {"seed": "", "summary": "", "details": ""},
        "details": {
            "personality": "", "goals": "", "fears_flaws": "", "traits": "",
            "alignment": "", "languages": "", "skills": "",
            "equipment": "", "spells": "", "custom": {},
        },
        # ---- Public: known to the group --------------------------------- #
        "public": {
            "known_identity": "",
            "known_backstory": "",
            "known_relationships": "",
            "known_items": "",
            "rumors": "",
        },
        # ---- Hidden: DM-only, not (yet) known to the group -------------- #
        "hidden": {
            "hidden_agendas": [],   # [{title, description, revealed}]
            "secrets": [],          # [{title, description, revealed}]
            "dm_notes": "",
            "messages": [],         # private DM→player notes (see below)
        },
        # ---- Progression / inventory (tracked at the table) ------------ #
        "progression": {
            "xp": 0,
            "level": 1,
        },
        "inventory": [],            # [{name, qty, weight?, notes?}]
        # ---- Build record: race/class picks + every level-up upgrade ---- #
        "build": {
            "race_traits": [],      # traits granted by the chosen race
            "race_skills": [],      # skill/tool proficiencies from the race
            "class_features_by_level": {},  # {level: [feature names]}
            "proficiencies": [],    # [{skill, level: base|expert}]
            "spells": [],           # [{name, level, acquired_at}]
            "cantrips": [],         # [{name, acquired_at}]
        },
    }


def new_message(text: str, from_name: str = "DM", kind: str = "note",
                to: str = "self") -> dict:
    """A hidden message this character alone can see.

    kinds: note (default) | hook | reveal | whisper | levelup.
    Stored under hidden.messages so it never leaks in ?view=public.
    `from`/`to` are display names; `to` marks the recipient when a player
    whispers another character (defaults to the owner, i.e. a DM note)."""
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
    """Recompute derived fields (D&D-style modifiers) in place.

    Only when the sheet scores are the standard six — so 7-score systems
    (Cyberpunk) don't get meaningless fantasy modifiers.
    """
    ab = sheet["abilities"]
    if set(STD_ABILITIES).issubset(set(ab)):
        sheet["abilities"]["modifiers"] = {
            k: _modify(ab[k]) for k in STD_ABILITIES
            if isinstance(ab.get(k), (int, float))
        }
    return sheet


def sheet_path(sheet_id: str) -> Path:
    return SHEET_DIR / f"char_sheet_{sheet_id}.json"


def load_sheet(sheet_id: str):
    path = sheet_path(sheet_id)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_sheet(sheet: dict) -> dict:
    sheet = derive(sheet)
    sheet["updated_at"] = _now()
    with open(sheet_path(sheet["id"]), "w", encoding="utf-8") as f:
        json.dump(sheet, f, indent=2, ensure_ascii=False)
    return sheet


def _merge(target: dict, payload: dict):
    """Deep-merge the client payload into the sheet, keeping known shape."""
    for key, value in payload.items():
        if key in ("id", "created_at", "updated_at"):
            continue
        if key == "system":
            if isinstance(value, str):
                target["system"] = value
                target["system_label"] = all_games().get(value, {}).get(
                    "label", value)
            continue
        if key == "abilities" and isinstance(value, dict):
            ab = target["abilities"]
            for ab_key, ab_val in value.items():
                if ab_key == "modifiers":
                    continue
                if isinstance(ab_val, str) and not ab_val.strip().isdigit():
                    ab[ab_key] = str(ab_val)  # free-form systems can use names
                    continue
                try:
                    ab[ab_key] = max(1, min(30, int(ab_val)))
                except (TypeError, ValueError):
                    continue
            continue
        if key in target and isinstance(target[key], dict) and \
                isinstance(value, dict):
            for sub_key, sub_value in value.items():
                if sub_key in target[key] or key in ("campaign",):
                    if isinstance(target[key].get(sub_key), dict) and \
                            isinstance(sub_value, dict):
                        target[key][sub_key].update(sub_value)
                    else:
                        target[key][sub_key] = sub_value
                elif key in ("details",) and sub_key == "custom" and \
                        isinstance(sub_value, dict):
                    target[key].setdefault("custom", {}).update(sub_value)
            continue
        if key in target and isinstance(target[key], list) and \
                isinstance(value, list):
            target[key] = [v for v in value if isinstance(v, (str, dict))]
            continue
        if key in target and isinstance(value, (str, int, float, bool)):
            target[key] = value


# --------------------------------------------------------------------------- #
#  REST API                                                                    #
# --------------------------------------------------------------------------- #

@app.get("/api/games")
def api_games():
    """All playable game systems: local profiles + remote (dms.gg)."""
    return jsonify(all_games(include_remote=_want_remote()))


@app.get("/api/games/<game_id>")
def api_game(game_id: str):
    game = all_games(include_remote=_want_remote()).get(game_id)
    if game is None:
        return jsonify({"error": "unknown game system"}), 404
    return jsonify(game)


# --------------------------------------------------------------------------- #
#  Rules knowledge (click-through: skills, class level features, race traits,  #
#  backgrounds, spells, conditions, damage — SRD data via 5etools.co)          #
# --------------------------------------------------------------------------- #

_RULE_KEYS = ("skills", "races", "classes", "backgrounds",
              "spells", "conditions", "damages", "alignments")


def _empty_rules() -> dict:
    """A fresh rules container with independent lists.

    IMPORTANT: never reuse list objects across calls. `_profile_rules` mutates
    these lists (append), and sharing them would accumulate race/class entries
    from every system on top of each other — the "options loaded multiple
    times" bug.
    """
    return {k: [] for k in _RULE_KEYS}


def _dedup_by_name(items: list) -> list:
    """Drop duplicate race/class entries; first occurrence (by name) wins."""
    out, seen = [], set()
    for it in items:
        if not isinstance(it, dict):
            continue
        key = str(it.get("name", "")).strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out



def _profile_rules(system: str) -> dict:
    """Normalize local profile data into the shared rules/rewards shape."""
    game = local_games().get(system) or {}
    out = {**_empty_rules(), "system": system, "source": "local-profile"}

    race_data = game.get("race_data") or {}
    for name, data in race_data.items():
        data = data if isinstance(data, dict) else {}
        out["races"].append({
            "name": name,
            "traits": [{"name": x if isinstance(x, str) else x.get("name", "Trait"),
                        "description": "" if isinstance(x, str) else x.get("description", "")}
                       for x in data.get("traits", [])],
            "skill_proficiencies": list(data.get("skill_proficiencies", [])),
            "ability_scores": data.get("ability_scores", {}),
            "subraces": [],
        })

    by_race = {r["name"]: r for r in out["races"]}
    for race_name, subs in (game.get("subrace_data") or {}).items():
        r = by_race.get(race_name)
        if not r or not isinstance(subs, dict):
            continue
        r["subraces"] = [{
            "name": sn,
            "traits": [{"name": x if isinstance(x, str) else x.get("name", "Trait"),
                        "description": "" if isinstance(x, str) else x.get("description", "")}
                       for x in (sd or {}).get("traits", [])],
            "ability_scores": (sd or {}).get("ability_scores", {}),
        } for sn, sd in subs.items()]

    class_data = game.get("class_data") or {}
    subclass_data = game.get("subclass_data") or {}
    for name, data in class_data.items():
        data = data if isinstance(data, dict) else {}
        features = {}
        for lvl, names in (data.get("features") or {}).items():
            seq = names if isinstance(names, list) else [names]
            features[str(lvl)] = [{
                "name": x if isinstance(x, str) else x.get("name", "Feature"),
                "description": "" if isinstance(x, str) else x.get("description", "")
            } for x in seq]
        norm_subs = []
        for sc in subclass_data.get(name, []) if isinstance(subclass_data.get(name, []), list) else []:
            if isinstance(sc, str):
                norm_subs.append({"name": sc, "description": "", "features": {}})
            else:
                norm_subs.append({
                    "name": sc.get("name", "Subclass"),
                    "description": sc.get("description", ""),
                    "features": sc.get("features") or sc.get("features_by_level")
                                or sc.get("level_rewards") or {},
                })
        out["classes"].append({
            "name": name,
            "skills": [{"name": x, "choice": None, "options": []} for x in data.get("skills", [])],
            "features": features,
            "starting_features": features.get("1", []),
            "is_spellcaster": bool(data.get("spellcaster")),
            "spellcasting_ability": data.get("spellcasting_ability", ""),
            "subclasses": norm_subs,
        })
    bg = game.get("backgrounds") or {}
    out["backgrounds"] = [{"name": x} for x in bg.get("suggestions", []) if x != "Custom..."]
    return out


def rules_payload(system: str) -> dict:
    """Return one stable rules/rewards format for every selectable system.

    Live sources win for systems that have them; local profile data fills gaps
    and is the fallback for BG/CP/custom and offline mode.
    """
    local = _profile_rules(system)
    base = dict(local)
    base["system"] = system
    base["offline"] = not _want_remote()
    if _want_remote():
        try:
            if system == "dnd5e":
                live = fiveetools.five_e()
            elif system == "pathfinder2e":
                live = pf2etools.pf2e()
            else:
                live = None
            if isinstance(live, dict):
                # Live rule data wins, but local profile-only rewards survive.
                for key, value in live.items():
                    if value not in (None, [], {}):
                        base[key] = value
                base["source"] = "live+local"
        except Exception:
            base["source"] = "local-profile"
    # Names are case/whitespace-insensitive; drop any duplicates so the grid
    # never shows the same race/class several times.
    base["races"] = _dedup_by_name(base.get("races", []))
    base["classes"] = _dedup_by_name(base.get("classes", []))
    return base


@app.get("/api/rules/<system>")
def api_rules(system: str):
    """Rules lookup data for a system (the "click to find out, no googling")."""
    return jsonify(rules_payload(system))


@app.get("/api/adventure/<adv_id>")
def api_adventure(adv_id: str):
    """Full 5etools adventure data (chapters, NPCs with stats, maps, items).
    adv_id may carry the '5etools_' prefix used in campaign ids."""
    if not _want_remote():
        return jsonify({"error": "adventure data only available with "
                                 "internet (or a fresh cache)"}), 404
    data = fiveetools.adventure(adv_id)
    if not data:
        return jsonify({"error": "adventure not found (offline or bad id)"}), 404
    return jsonify(data)


@app.get("/api/campaigns")
def api_campaigns():
    """Merged campaign list: AI-generated option ⊕ local ⊕ 5etools."""
    return jsonify(all_campaigns(
        for_system=request.args.get("system") or None,
        include_remote=_want_remote()))


@app.post("/api/campaigns")
def api_create_campaign():
    """Author a new campaign (type: premade | aigenerated)."""
    payload = request.get_json(silent=True) or {}
    campaign = {
        "id": "camp_" + uuid.uuid4().hex[:8],
        "title": payload.get("title", "Untitled Campaign"),
        "system": payload.get("system", "any"),
        "type": payload.get("type", "premade"),
        "description": payload.get("description", ""),
        "setting": payload.get("setting", ""),
        "tone": payload.get("tone", ""),
        "world_notes": payload.get("world_notes", ""),
        "ai_generated": payload.get("type", "premade") == "aigenerated",
        "created_at": _now(),
        "source": "local",
    }
    campaigns = load_local_campaigns()
    campaigns.append(campaign)
    save_local_campaigns(campaigns)
    return jsonify(campaign), 201


@app.get("/api/characters")
def api_list_characters():
    sheets = []
    for p in sorted(SHEET_DIR.glob("char_sheet_*.json")):
        try:
            with open(p, encoding="utf-8") as f:
                s = json.load(f)
            # list view: never leak hidden info
            sheets.append({
                "id": s["id"],
                "name": s.get("identity", {}).get("name", ""),
                "system_label": s.get("system_label", ""),
                "campaign": s.get("campaign", {}).get("title"),
                "player": s.get("identity", {}).get("player_name", ""),
                "created_at": s.get("created_at", ""),
            })
        except (json.JSONDecodeError, KeyError):
            continue
    return jsonify(sheets)


@app.get("/api/characters/<sheet_id>")
def api_get_character(sheet_id: str):
    """?view=public → only what the group knows (no hidden block)."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    if request.args.get("view") == "public":
        public_view = {k: v for k, v in sheet.items() if k != "hidden"}
        public_view["visibility"]["hidden_revealed"] = False
        return jsonify(public_view)
    return jsonify(sheet)


@app.post("/api/characters")
def api_create_character():
    payload = request.get_json(silent=True) or {}
    games = all_games()
    system = payload.get("system", "dnd5e")
    if system not in games:
        system = "custom" if "custom" in games else next(iter(games))
    sheet = new_sheet(system)

    # Optional: link to a campaign (local, 5etools, or AI-generated).
    camp_payload = payload.get("campaign")
    campaign_block = None
    if isinstance(camp_payload, dict) and camp_payload.get("id"):
        cid = camp_payload["id"]
        if cid == "ai-generated":
            camp = {
                "id": "camp_ai_" + uuid.uuid4().hex[:8],
                "title": camp_payload.get("title") or "AI Campaign " + _now()[:10],
                "system": system,
                "type": "aigenerated",
                "description": "AI-invented campaign, seeded by the "
                               "character creator.",
                "setting": camp_payload.get("setting", ""),
                "tone": camp_payload.get("tone", ""),
                "world_notes": "",   # filled by the AI narrator later
                "seed": camp_payload.get("seed", ""),
                "ai_generated": True,
                "created_at": _now(),
                "source": "ai",
            }
            save_local_campaigns(load_local_campaigns() + [camp])
            camp_payload = camp
        else:
            camp = next((c for c in all_campaigns(None) if c["id"] == cid),
                        {"id": cid, "title": camp_payload.get("title", cid)})
        campaign_block = {
            "id": camp.get("id"),
            "title": camp.get("title"),
            "ai_generated": camp.get("ai_generated", False),
            "seed": camp_payload.get("seed", ""),
        }

    _merge(sheet, payload)
    if campaign_block:
        sheet["campaign"] = campaign_block  # resolved block wins over payload
    return jsonify(save_sheet(sheet)), 201


@app.put("/api/characters/<sheet_id>")
def api_update_character(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    _merge(sheet, request.get_json(silent=True) or {})
    return jsonify(save_sheet(sheet))


@app.delete("/api/characters/<sheet_id>")
def api_delete_character(sheet_id: str):
    path = sheet_path(sheet_id)
    if not path.exists():
        return jsonify({"error": "character not found"}), 404
    path.unlink()
    return jsonify({"deleted": sheet_id})


@app.post("/api/characters/<sheet_id>/toggle-hidden")
def api_toggle_hidden(sheet_id: str):
    """Mark hidden data as revealed to the group (end of session, twists...)."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    sheet["visibility"]["hidden_revealed"] = (
        not sheet.get("visibility", {}).get("hidden_revealed", False))
    return jsonify(save_sheet(sheet))


# --------------------------------------------------------------------------- #
#  Progression / inventory / hidden messages (live-at-the-table endpoints)     #
# --------------------------------------------------------------------------- #

def _progression(sheet: dict) -> dict | None:
    """The xp→level table for the sheet's system, or None when unsupported."""
    game = all_games().get(sheet.get("system"))
    prog = (game or {}).get("progression") or {}
    table = prog.get("xp_levels") or []
    return table or None


def _level_for(xp: int, table: list) -> int:
    """Highest level whose xp threshold is ≤ xp (1-based)."""
    level = 1
    for i, threshold in enumerate(table, start=1):
        if xp >= threshold:
            level = i
    return level


@app.post("/api/characters/<sheet_id>/xp")
def api_award_xp(sheet_id: str):
    """Award XP. Body: {"amount": N}. Returns new xp/level + level-up flag.

    Sets both `progression.xp` and mirrors `identity.level` when a level-up
    occurs, so the UI and a future narrator agree on the PC's level."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    amount = int((request.get_json(silent=True) or {}).get("amount", 0))
    table = _progression(sheet)
    prog = sheet.setdefault("progression", {"xp": 0, "level": 1})
    old_level = int(prog.get("level") or sheet.get("identity", {}).get("level") or 1)
    prog["xp"] = int(prog.get("xp", 0)) + amount
    new_level = _level_for(prog["xp"], table) if table else old_level
    leveled_up = new_level > old_level
    prog["level"] = new_level
    if leveled_up:
        sheet.setdefault("identity", {})["level"] = new_level
        sheet.setdefault("hidden", {}).setdefault("messages", []).append(
            new_message(f"You leveled up to level {new_level}!",
                        kind="levelup"))
    save_sheet(sheet)
    return jsonify({
        "xp": prog["xp"], "level": new_level,
        "old_level": old_level, "leveled_up": leveled_up,
    })


@app.post("/api/characters/<sheet_id>/inventory")
def api_add_item(sheet_id: str):
    """Add an item to the inventory list.
    Body: {"name": "...", "qty": 1, "notes": "..."}."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    item = request.get_json(silent=True) or {}
    name = (item.get("name") or "").strip()
    if not name:
        return jsonify({"error": "item name required"}), 400
    inv = sheet.setdefault("inventory", [])
    # stack if a same-named item exists and allows qty
    qty = int(item.get("qty", 1)) or 1
    for existing in inv:
        if existing.get("name") == name:
            existing["qty"] = int(existing.get("qty", 1)) + qty
            save_sheet(sheet)
            return jsonify(existing), 200
    entry = {"name": name, "qty": qty, "notes": item.get("notes", "")}
    inv.append(entry)
    save_sheet(sheet)
    return jsonify(entry), 201


@app.delete("/api/characters/<sheet_id>/inventory/<int:index>")
def api_remove_item(sheet_id: str, index: int):
    """Remove an inventory entry by index (0-based as listed)."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    inv = sheet.setdefault("inventory", [])
    if not (0 <= index < len(inv)):
        return jsonify({"error": "bad inventory index"}), 404
    removed = inv.pop(index)
    save_sheet(sheet)
    return jsonify({"removed": removed})


@app.post("/api/characters/<sheet_id>/messages")
def api_send_message(sheet_id: str):
    """Add a hidden message only this character can see.
    Body: {"text": "...", "from": "DM", "kind": "note"}."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    payload = request.get_json(silent=True) or {}
    text = (payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "message text required"}), 400
    msg = new_message(text,
                      from_name=payload.get("from") or "DM",
                      kind=payload.get("kind") or "note")
    sheet.setdefault("hidden", {}).setdefault("messages", []).append(msg)
    save_sheet(sheet)
    return jsonify(msg), 201


@app.get("/api/characters/<sheet_id>/messages")
def api_list_messages(sheet_id: str):
    """List this character's hidden messages (DM-only in practice)."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    return jsonify(sheet.get("hidden", {}).get("messages", []))


@app.post("/api/characters/<sheet_id>/messages/<msg_id>/read")
def api_mark_read(sheet_id: str, msg_id: str):
    """Mark one hidden message as read."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    for m in sheet.get("hidden", {}).get("messages", []):
        if m.get("id") == msg_id:
            m["read"] = True
            save_sheet(sheet)
            return jsonify(m)
    return jsonify({"error": "message not found"}), 404


@app.get("/api/characters/<sheet_id>/party")
def api_party(sheet_id: str):
    """The other characters in the roster (for whispers / player interaction).

    Returns a compact list of every sheet except <sheet_id>, so a player can
    see who else is at the table without leaking their hidden data."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return jsonify({"error": "character not found"}), 404
    others = []
    for p in sorted(SHEET_DIR.glob("char_sheet_*.json")):
        if p.stem == sheet_path(sheet_id).stem:
            continue
        try:
            with open(p, encoding="utf-8") as f:
                s = json.load(f)
            others.append({
                "id": s["id"],
                "name": s.get("identity", {}).get("name", ""),
                "race": s.get("identity", {}).get("race", ""),
                "class": s.get("identity", {}).get("class", ""),
                "level": s.get("identity", {}).get("level", 1),
                "portrait": s.get("identity", {}).get("portrait", "🧑"),
                "player": s.get("identity", {}).get("player_name", ""),
            })
        except (json.JSONDecodeError, KeyError):
            continue
    return jsonify(others)


@app.post("/api/characters/<sheet_id>/whisper")
def api_whisper(sheet_id: str):
    """Send a hidden message from <sheet_id> to another character.

    Body: {"to": "<target_id>", "text": "...", "kind": "whisper"}.
    The note is stored on the *target's* hidden.messages (kind "whisper"),
    so only they see it — private player-to-player interaction."""
    sender = load_sheet(sheet_id)
    if sender is None:
        return jsonify({"error": "character not found"}), 404
    payload = request.get_json(silent=True) or {}
    target_id = payload.get("to")
    text = (payload.get("text") or "").strip()
    if not target_id:
        return jsonify({"error": "recipient 'to' required"}), 400
    if not text:
        return jsonify({"error": "message text required"}), 400
    target = load_sheet(target_id)
    if target is None:
        return jsonify({"error": "recipient not found"}), 404
    sender_name = sender.get("identity", {}).get("name") or "a character"
    msg = new_message(
        text,
        from_name=sender_name,
        kind="whisper",
        to=target.get("identity", {}).get("name") or target_id,
    )
    target.setdefault("hidden", {}).setdefault("messages", []).append(msg)
    save_sheet(target)
    return jsonify(msg), 201


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "local_games": [p.stem for p in sorted(GAME_DIR.glob("*.json"))],
        "sheets": [p.name for p in SHEET_DIR.glob("char_sheet_*.json")],
    })


# --------------------------------------------------------------------------- #
#  Web UI (standalone files: webui.html + webui.js, served from BASE_DIR)      #
# --------------------------------------------------------------------------- #


@app.get("/")
def index():
    """The BG3-style single-page UI (webui.html references webui.js)."""
    return send_from_directory(BASE_DIR, "webui.html")


@app.get("/webui.js")
def webui_js():
    return send_from_directory(BASE_DIR, "webui.js")


if __name__ == "__main__":
    print("Char Creator running at http://127.0.0.1:5000")
    print(f"  local games  : {sorted(p.stem for p in GAME_DIR.glob('*.json'))}")
    print(f"  remote games : {DMS_API_URL}")
    print(f"  campaigns    : {CAMPAIGNS_FILE.name} + {E5TTOOLS_ADVENTURES_URL}")
    try:
        _5 = fiveetools.five_e()
        _p2 = pf2etools.pf2e()
        print(f"  live rules   : 5e {len(_5.get('classes', []))} classes / "
              f"{len(_5.get('races', []))} races | PF2e "
              f"{len(_p2.get('classes', []))} classes / "
              f"{len(_p2.get('races', []))} races (offline if 0)")
    except Exception:
        print("  live rules   : offline/unavailable (local profiles remain)")
    app.run(host="127.0.0.1", port=5000, debug=True)
