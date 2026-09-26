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
  - `fiveetools.py` 5e SRD data from api.5etools.co
  - `pf2etools.py`  PF2e rules data
  - exposed at GET /api/rules/<system> and GET /api/adventure/<id>.

Generic class choices
---------------------
Game profiles can define arbitrary class-specific choices.

Examples:

    {
      "id": "subclass",
      "label": "Divine Domain",
      "type": "choice",
      "level": 1,
      "required": true,
      "options_source": "subclass_data.Cleric"
    }

    {
      "id": "deity",
      "label": "Deity",
      "type": "choice",
      "level": 1,
      "required": true,
      "options": [
        {"name": "Pelor", "description": "..."},
        {"name": "Tyr", "description": "..."}
      ]
    }

The backend does not care whether a choice is a subclass, deity, patron,
fighting style, doctrine, muse, bloodline, role specialization, or something
invented by a completely different game.

Character choices are stored as:

    "choices": {
        "subclass": "Life Domain",
        "deity": "Pelor"
    }

A class can have any number of choices.

Legacy compatibility
--------------------
Existing profiles using:

    subclass_level
    subclass_label
    subclass_data

continue to work. The backend automatically exposes that data as a generic
choice with id="subclass".

Output: one JSON file per character
(char_sheets/char_sheet_<id>.json).
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, request, jsonify, send_from_directory

import fiveetools
import pf2etools
from remote import cached_remote


# --------------------------------------------------------------------------- #
# Config                                                                       #
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
SHEET_DIR = BASE_DIR / ".." / "char_sheets"
GAME_DIR = BASE_DIR / "games"
CAMPAIGNS_FILE = BASE_DIR / "campaigns.json"

for _d in (SHEET_DIR, GAME_DIR):
    _d.mkdir(exist_ok=True)

DMS_API_URL = "https://api.dms.gg/systems"

E5TTOOLS_ADVENTURES_URL = (
    "https://www.5etools.com/api/adventures?per_page=100"
)

app = Flask(__name__)

STD_ABILITIES = [
    "strength",
    "dexterity",
    "constitution",
    "intelligence",
    "wisdom",
    "charisma",
]


# --------------------------------------------------------------------------- #
# General helpers                                                              #
# --------------------------------------------------------------------------- #

def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _want_remote() -> bool:
    return request.args.get(
        "remote",
        "true",
    ).lower() != "false"


def _as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _as_list(value) -> list:
    return value if isinstance(value, list) else []


def _safe_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Game profile registry                                                        #
# --------------------------------------------------------------------------- #

def normalize_game(data: dict, source: str) -> dict:
    """
    Coerce any shape (local file, dms.gg row, etc.) into a game profile.

    The function intentionally preserves arbitrary profile fields so game
    systems can grow without requiring Python changes.
    """

    data = _as_dict(data)
    g = dict(data)

    g.setdefault(
        "id",
        str(
            data.get("key")
            or data.get("slug")
            or data.get("id")
            or "custom"
        ),
    )

    g.setdefault(
        "label",
        data.get("name") or g["id"],
    )

    g.setdefault(
        "description",
        data.get("description", ""),
    )

    g.setdefault(
        "tldr",
        data.get("tldr") or g["description"],
    )

    g.setdefault(
        "links",
        {
            "rules": [],
            "wiki": None,
            "data_api": None,
        },
    )

    g.setdefault(
        "genre",
        data.get("genre", ""),
    )

    g.setdefault(
        "source",
        source,
    )

    # ------------------------------------------------------------------ #
    # Fields                                                             #
    # ------------------------------------------------------------------ #

    fields = {}

    for key, src in (
        ("race", "races"),
        ("class", "classes"),
        ("alignment", "alignments"),
    ):
        f = (
            data.get("fields", {})
            if isinstance(data.get("fields"), dict)
            else {}
        ).get(key)

        fields[key] = (
            dict(f)
            if isinstance(f, dict)
            else {"suggestions": []}
        )

        fields[key].setdefault(
            "label",
            key.title(),
        )

        fields[key].setdefault(
            "suggestions",
            data.get(
                src,
                ["Custom..."],
            ),
        )

        if not isinstance(
            fields[key]["suggestions"],
            list,
        ):
            fields[key]["suggestions"] = [
                "Custom..."
            ]

    g["fields"] = fields

    # ------------------------------------------------------------------ #
    # Backgrounds                                                       #
    # ------------------------------------------------------------------ #

    bg = data.get("background")

    g["backgrounds"] = (
        dict(bg)
        if isinstance(bg, dict)
        else {
            "suggestions": (
                bg
                if isinstance(bg, list)
                else ["Custom..."]
            )
        }
    )

    g["backgrounds"].setdefault(
        "label",
        "Background",
    )

    g["backgrounds"].setdefault(
        "suggestions",
        ["Custom..."],
    )

    # ------------------------------------------------------------------ #
    # Abilities                                                         #
    # ------------------------------------------------------------------ #

    ab = data.get("abilities")

    g["abilities"] = (
        dict(ab)
        if isinstance(ab, dict)
        else {}
    )

    g["abilities"].setdefault(
        "enabled",
        True,
    )

    g["abilities"].setdefault(
        "scores",
        list(STD_ABILITIES),
    )

    g["abilities"].setdefault(
        "min",
        1,
    )

    g["abilities"].setdefault(
        "max",
        30,
    )

    g["abilities"].setdefault(
        "default",
        10,
    )

    # ------------------------------------------------------------------ #
    # Progression                                                       #
    # ------------------------------------------------------------------ #

    prog = data.get("progression")

    g["progression"] = (
        dict(prog)
        if isinstance(prog, dict)
        else {"xp_levels": []}
    )

    g["progression"].setdefault(
        "level_field",
        "identity.level",
    )

    g["progression"].setdefault(
        "xp_levels",
        [],
    )

    return g


def local_games() -> dict:
    """All game profiles from games/*.json."""

    out = {}

    for p in sorted(
        GAME_DIR.glob("*.json")
    ):
        try:
            with open(
                p,
                encoding="utf-8",
            ) as f:
                out[p.stem] = normalize_game(
                    json.load(f),
                    "local",
                )

        except (
            json.JSONDecodeError,
            OSError,
        ):
            continue

    return out


def remote_systems() -> list:
    """Playable systems from the Dungeon Masters API."""

    data = cached_remote(DMS_API_URL)

    if not data:
        return []

    rows = (
        data.get("data", data)
        if isinstance(data, dict)
        else data
    )

    if not isinstance(rows, list):
        return []

    out = []
    seen = set()

    for row in rows:

        if not isinstance(row, dict):
            continue

        slug = str(
            row.get("key")
            or row.get("slug")
            or row.get("id")
            or ""
        )

        name = (
            row.get("name")
            or row.get("label")
        )

        if not slug or not name:
            continue

        g = normalize_game(
            row,
            "remote",
        )

        g["id"] = (
            "dms_"
            + g["id"].lower()
        )

        if g["id"] in seen:
            continue

        seen.add(g["id"])
        out.append(g)

    return out


def all_games(
    include_remote: bool = True,
) -> dict:
    games = local_games()

    if include_remote:
        for g in remote_systems():
            # Local profiles always win.
            games.setdefault(
                g["id"],
                g,
            )

    return games


# --------------------------------------------------------------------------- #
# Campaigns                                                                    #
# --------------------------------------------------------------------------- #

def load_local_campaigns() -> list:
    try:
        with open(
            CAMPAIGNS_FILE,
            encoding="utf-8",
        ) as f:
            data = json.load(f)

        if not isinstance(data, dict):
            return []

        campaigns = data.get(
            "campaigns",
            [],
        )

        return (
            campaigns
            if isinstance(campaigns, list)
            else []
        )

    except (
        OSError,
        json.JSONDecodeError,
    ):
        return []


def save_local_campaigns(
    campaigns: list,
):
    with open(
        CAMPAIGNS_FILE,
        "w",
        encoding="utf-8",
    ) as f:
        json.dump(
            {
                "campaigns": campaigns
            },
            f,
            indent=2,
            ensure_ascii=False,
        )


def local_campaigns(
    for_system: str | None = None,
) -> list:
    out = []

    for campaign in load_local_campaigns():

        c = dict(campaign)

        c.setdefault(
            "source",
            "local",
        )

        c.setdefault(
            "ai_generated",
            c.get("type") == "aigenerated",
        )

        if (
            for_system
            and c.get("system")
            not in (
                None,
                "any",
                for_system,
            )
        ):
            continue

        out.append(c)

    return out


def remote_adventures() -> list:
    """5e adventures from 5etools."""

    data = cached_remote(
        E5TTOOLS_ADVENTURES_URL
    )

    rows = (
        data.get("data")
        if isinstance(data, dict)
        else data
    )

    if not isinstance(rows, list):
        return []

    out = []

    for row in rows:

        if not isinstance(row, dict):
            continue

        if not (
            row.get("isAdventure")
            or row.get("type") == "adventure"
        ):
            continue

        book = row.get("book")

        out.append(
            {
                "id": (
                    "5etools_"
                    + str(
                        row.get("slug")
                        or row.get("id")
                    )
                ),
                "title": row.get(
                    "name",
                    "",
                ),
                "system": "dnd5e",
                "type": "premade",
                "description": (
                    row.get("blurb")
                    or row.get("description")
                    or ""
                )[:400],
                "setting": (
                    book.get(
                        "name",
                        "",
                    )
                    if isinstance(
                        book,
                        dict,
                    )
                    else ""
                ) or "5e sourcebook",
                "page_count": row.get(
                    "pageCount"
                ),
                "ai_generated": False,
                "source": "5etools",
                "url": row.get(
                    "page_url",
                    "",
                ),
            }
        )

    return out


def ai_campaign_option(
    system: str | None,
) -> dict:
    return {
        "id": "ai-generated",
        "title": "✨ AI-generated campaign (fresh)",
        "system": system or "any",
        "type": "aigenerated",
        "description": (
            "No premade story — the AI narrator invents "
            "the world and plot around your party. "
            "Give it a seed and it fills the setting "
            "+ world_notes at first session."
        ),
        "setting": "",
        "tone": "",
        "ai_generated": True,
        "source": "ai",
    }


def all_campaigns(
    for_system: str | None,
    include_remote: bool = True,
) -> list:
    out = [
        ai_campaign_option(
            for_system
        )
    ]

    out += sorted(
        local_campaigns(for_system),
        key=lambda c: c.get(
            "title",
            "",
        ),
    )

    if (
        include_remote
        and for_system in (
            None,
            "any",
            "dnd5e",
        )
    ):
        out += remote_adventures()

    return out


# --------------------------------------------------------------------------- #
# Generic class-choice system                                                  #
# --------------------------------------------------------------------------- #

def _resolve_path(
    root: dict,
    path: str,
):
    """
    Resolve a dotted path such as:

        subclass_data.Cleric

    The path is intentionally generic so game profiles can reference
    arbitrary sections of their own JSON.
    """

    current: Any = root

    for part in str(path).split("."):

        if isinstance(current, dict):
            current = current.get(part)

        else:
            return None

    return current


def _normalize_option(
    option,
) -> dict | None:
    """
    Convert a simple string option or object into the common option shape.
    """

    if isinstance(option, str):

        return {
            "name": option,
            "description": "",
        }

    if isinstance(option, dict):

        name = (
            option.get("name")
            or option.get("label")
            or option.get("id")
        )

        if not name:
            return None

        result = dict(option)

        result["name"] = str(name)
        result.setdefault(
            "description",
            "",
        )

        return result

    return None


def _normalize_options(
    options,
) -> list:
    out = []

    if not isinstance(
        options,
        list,
    ):
        return out

    for option in options:

        normalized = _normalize_option(
            option
        )

        if normalized is not None:
            out.append(normalized)

    return out


def _resolve_choice_options(
    choice: dict,
    game: dict,
) -> list:
    """
    Resolve options for a generic choice.

    Supported:

        "options": [...]

    or:

        "options_source": "subclass_data.Cleric"

    The source can point anywhere inside the game profile.
    """

    if not isinstance(
        choice,
        dict,
    ):
        return []

    if isinstance(
        choice.get("options"),
        list,
    ):
        return _normalize_options(
            choice["options"]
        )

    source = choice.get(
        "options_source"
    )

    if not source:
        return []

    resolved = _resolve_path(
        game,
        source,
    )

    return _normalize_options(
        resolved
    )


def _legacy_subclass_choice(
    class_name: str,
    profile: dict,
    game: dict,
) -> dict | None:
    """
    Convert the old:

        subclass_level
        subclass_label
        subclass_data

    structure into the new generic choices structure.

    This means existing game JSON files do NOT have to be migrated
    immediately.
    """

    subclass_level = profile.get(
        "subclass_level"
    )

    subclass_label = profile.get(
        "subclass_label"
    )

    subclass_data = (
        game.get("subclass_data")
        or {}
    )

    options = subclass_data.get(
        class_name,
        [],
    )

    if subclass_level is None:
        return None

    if not isinstance(
        options,
        list,
    ):
        options = []

    return {
        "id": "subclass",
        "label": (
            subclass_label
            or "Subclass"
        ),
        "type": "choice",
        "level": _safe_int(
            subclass_level,
            1,
        ),
        "required": True,
        "options_source": (
            f"subclass_data.{class_name}"
        ),
        "options": _normalize_options(
            options
        ),
        "legacy_subclass": True,
    }


def _class_choices(
    game: dict,
    class_name: str,
    profile: dict,
) -> list:
    """
    Return the raw generic choices for one class.

    New profiles use:

        class_data.<class>.choices

    Existing profiles using subclass_data automatically receive a generated
    legacy `subclass` choice.
    """

    raw = profile.get(
        "choices",
        [],
    )

    choices = []

    if isinstance(
        raw,
        list,
    ):
        for choice in raw:

            if not isinstance(
                choice,
                dict,
            ):
                continue

            choices.append(
                dict(choice)
            )

    # Legacy subclass compatibility.
    has_subclass_choice = any(
        c.get("id") == "subclass"
        for c in choices
    )

    if not has_subclass_choice:

        legacy = _legacy_subclass_choice(
            class_name,
            profile,
            game,
        )

        if legacy is not None:
            choices.append(legacy)

    return choices


def _prepare_choice(
    choice: dict,
    game: dict,
    character_level: int,
) -> dict | None:
    """
    Prepare a generic choice for the rules API.

    A choice becomes available when:

        choice.level <= character_level

    The API never needs to know what the choice represents.
    """

    if not isinstance(
        choice,
        dict,
    ):
        return None

    result = dict(choice)

    level = _safe_int(
        choice.get("level", 1),
        1,
    )

    if level > character_level:
        return None

    result["level"] = level

    options = _resolve_choice_options(
        choice,
        game,
    )

    result["options"] = options
    result["option_count"] = len(
        options
    )

    if len(options) == 1:
        result["option_tag"] = "1 option"
    else:
        result["option_tag"] = (
            f"{len(options)} options"
        )

    # Useful frontend metadata.
    result["available"] = True

    return result


def _get_class_choices(
    game: dict,
    class_name: str,
    profile: dict,
    character_level: int = 1,
) -> list:
    """
    Return every generic class choice available at the requested level.
    """

    result = []

    for choice in _class_choices(
        game,
        class_name,
        profile,
    ):

        prepared = _prepare_choice(
            choice,
            game,
            character_level,
        )

        if prepared is not None:
            result.append(
                prepared
            )

    return result


def _merge_class_profile(
    cls: dict,
    local_profile: dict | None,
    game: dict,
    level: int,
) -> dict:
    """
    Add local-profile-specific metadata to a live class entry.

    This is important because live 5e/PF2e data may know about a class's
    rules/features but does not necessarily know about your custom choices,
    deity lists, patron lists, etc.
    """

    if not isinstance(
        cls,
        dict,
    ):
        return cls

    local_profile = (
        local_profile
        if isinstance(
            local_profile,
            dict,
        )
        else {}
    )

    class_name = (
        cls.get("name")
        or ""
    )

    # Local profile choices are authoritative for character-builder
    # metadata because they are editable game-profile data.
    choices = _get_class_choices(
        game,
        class_name,
        local_profile,
        level,
    )

    cls["choices"] = choices

    # Legacy fields remain available for clients that still use them.
    if "subclass_level" not in cls:
        cls["subclass_level"] = local_profile.get(
            "subclass_level"
        )

    if "subclass_label" not in cls:
        cls["subclass_label"] = local_profile.get(
            "subclass_label"
        )

    if (
        "role_ability"
        in local_profile
    ):
        cls["role_ability"] = local_profile.get(
            "role_ability"
        )

    # Convenient generic count.
    cls["choice_count"] = len(
        choices
    )

    return cls


def _augment_class_choices(
    rules: dict,
    system: str,
    level: int = 1,
) -> dict:
    """
    Attach generic class choices to the rules payload.

    No special subclass filtering happens here.

    Every choice whose declared level is <= the requested character level
    is returned.
    """

    game = local_games().get(
        system
    ) or {}

    class_data = (
        game.get("class_data")
        or {}
    )

    for cls in rules.get(
        "classes",
        [],
    ):

        if not isinstance(
            cls,
            dict,
        ):
            continue

        class_name = cls.get(
            "name",
            "",
        )

        profile = class_data.get(
            class_name
        )

        _merge_class_profile(
            cls,
            profile,
            game,
            level,
        )

    return rules


# --------------------------------------------------------------------------- #
# Character storage                                                            #
# --------------------------------------------------------------------------- #

def new_sheet(
    system: str,
) -> dict:
    """Blank character sheet."""

    game = all_games().get(
        system,
        {},
    )

    ab = game.get(
        "abilities",
        {},
    )

    scores = (
        ab.get("scores")
        or list(STD_ABILITIES)
    )

    default_val = ab.get(
        "default",
        10,
    )

    return {
        "id": uuid.uuid4().hex[:12],
        "system": system,
        "system_label": game.get(
            "label",
            "Custom System",
        ),

        "campaign": {
            "id": None,
            "title": None,
            "ai_generated": False,
            "seed": "",
        },

        "created_at": _now(),
        "updated_at": _now(),

        "visibility": {
            "hidden_revealed": False,
        },

        "identity": {
            "name": "",
            "race": "",
            "class": "",
            "level": 1,
            "gender": "",
            "age": "",
            "appearance": "",
            "player_name": "",
        },

        # ---------------------------------------------------------------- #
        # Generic class/race/background/etc. choices.                    #
        # ---------------------------------------------------------------- #
        #
        # Examples:
        #
        #   {
        #       "subclass": "Life Domain",
        #       "deity": "Pelor"
        #   }
        #
        # The backend does not prescribe what these keys mean.
        #
        "choices": {},

        "abilities": {
            **{
                score: default_val
                for score in scores
            },
            "notes": "",
        },

        "background": {
            "seed": "",
            "summary": "",
            "details": "",
        },

        "details": {
            "personality": "",
            "goals": "",
            "fears_flaws": "",
            "traits": "",
            "alignment": "",
            "languages": "",
            "skills": "",
            "equipment": "",
            "spells": "",
            "custom": {},
        },

        # Public: known to the group.
        "public": {
            "known_identity": "",
            "known_backstory": "",
            "known_relationships": "",
            "known_items": "",
            "rumors": "",
        },

        # Hidden: DM-only.
        "hidden": {
            "hidden_agendas": [],
            "secrets": [],
            "dm_notes": "",
            "messages": [],
        },

        # Progression.
        "progression": {
            "xp": 0,
            "level": 1,
        },

        "inventory": [],

        # Build/reward record.
        "build": {
            "race_traits": [],
            "race_skills": [],
            "class_features_by_level": {},
            "proficiencies": [],
            "spells": [],
            "cantrips": [],
        },
    }


def new_message(
    text: str,
    from_name: str = "DM",
    kind: str = "note",
    to: str = "self",
) -> dict:
    """Create a hidden message."""

    return {
        "id": uuid.uuid4().hex[:10],
        "from": from_name,
        "to": to,
        "kind": kind,
        "text": text,
        "created_at": _now(),
        "read": False,
    }


def _modify(
    score: int,
) -> int:
    return (
        int(score) - 10
    ) // 2


def derive(
    sheet: dict,
) -> dict:
    """
    Recompute derived fields.

    Only standard six-ability fantasy systems get D&D-style modifiers.
    """

    ab = sheet.get(
        "abilities",
        {},
    )

    if set(STD_ABILITIES).issubset(
        set(ab)
    ):

        sheet["abilities"][
            "modifiers"
        ] = {
            k: _modify(ab[k])
            for k in STD_ABILITIES
            if isinstance(
                ab.get(k),
                (int, float),
            )
        }

    return sheet


def sheet_path(
    sheet_id: str,
) -> Path:
    return (
        SHEET_DIR
        / f"char_sheet_{sheet_id}.json"
    )


def load_sheet(
    sheet_id: str,
):
    path = sheet_path(
        sheet_id
    )

    if not path.exists():
        return None

    try:
        with open(
            path,
            encoding="utf-8",
        ) as f:
            return json.load(f)

    except (
        OSError,
        json.JSONDecodeError,
    ):
        return None


def save_sheet(
    sheet: dict,
) -> dict:
    sheet = derive(
        sheet
    )

    sheet["updated_at"] = _now()

    with open(
        sheet_path(
            sheet["id"]
        ),
        "w",
        encoding="utf-8",
    ) as f:
        json.dump(
            sheet,
            f,
            indent=2,
            ensure_ascii=False,
        )

    return sheet


# --------------------------------------------------------------------------- #
# Generic character merge                                                      #
# --------------------------------------------------------------------------- #

def _merge(
    target: dict,
    payload: dict,
):
    """
    Deep-merge the client payload into the sheet.

    `choices` is intentionally generic.

    The character creator can therefore store:

        choices.subclass
        choices.deity
        choices.patron
        choices.fighting_style
        choices.muse
        choices.bloodline
        choices.anything_else

    without Python needing a new field for each one.
    """

    if not isinstance(
        payload,
        dict,
    ):
        return

    for key, value in payload.items():

        if key in (
            "id",
            "created_at",
            "updated_at",
        ):
            continue

        # -------------------------------------------------------------- #
        # System                                                         #
        # -------------------------------------------------------------- #

        if key == "system":

            if isinstance(
                value,
                str,
            ):

                target["system"] = value

                target["system_label"] = (
                    all_games()
                    .get(value, {})
                    .get(
                        "label",
                        value,
                    )
                )

            continue

        # -------------------------------------------------------------- #
        # Generic choices                                                #
        # -------------------------------------------------------------- #

        if key == "choices":

            if not isinstance(
                value,
                dict,
            ):
                continue

            choices = target.setdefault(
                "choices",
                {},
            )

            for choice_id, choice_value in value.items():

                if not isinstance(
                    choice_id,
                    str,
                ):
                    continue

                # Choices are deliberately open-ended.
                #
                # A choice can be:
                #   "Life Domain"
                #   ["Fire", "Water"]
                #   {"name": "...", ...}
                #
                # This allows future game systems to define richer
                # selections without backend changes.
                choices[choice_id] = choice_value

            continue

        # -------------------------------------------------------------- #
        # Abilities                                                      #
        # -------------------------------------------------------------- #

        if (
            key == "abilities"
            and isinstance(
                value,
                dict,
            )
        ):

            ab = target.setdefault(
                "abilities",
                {},
            )

            for ab_key, ab_val in value.items():

                if ab_key == "modifiers":
                    continue

                if (
                    isinstance(
                        ab_val,
                        str,
                    )
                    and not ab_val.strip().isdigit()
                ):
                    ab[ab_key] = str(
                        ab_val
                    )
                    continue

                try:
                    ab[ab_key] = max(
                        1,
                        min(
                            30,
                            int(ab_val),
                        ),
                    )

                except (
                    TypeError,
                    ValueError,
                ):
                    continue

            continue

        # -------------------------------------------------------------- #
        # Nested dictionaries                                            #
        # -------------------------------------------------------------- #

        if (
            key in target
            and isinstance(
                target[key],
                dict,
            )
            and isinstance(
                value,
                dict,
            )
        ):

            for sub_key, sub_value in value.items():

                if (
                    sub_key
                    in target[key]
                    or key == "campaign"
                ):

                    if (
                        isinstance(
                            target[key].get(
                                sub_key
                            ),
                            dict,
                        )
                        and isinstance(
                            sub_value,
                            dict,
                        )
                    ):

                        target[key][
                            sub_key
                        ].update(
                            sub_value
                        )

                    else:

                        target[key][
                            sub_key
                        ] = sub_value

                elif (
                    key == "details"
                    and sub_key == "custom"
                    and isinstance(
                        sub_value,
                        dict,
                    )
                ):

                    target[key].setdefault(
                        "custom",
                        {},
                    ).update(
                        sub_value
                    )

            continue

        # -------------------------------------------------------------- #
        # Lists                                                          #
        # -------------------------------------------------------------- #

        if (
            key in target
            and isinstance(
                target[key],
                list,
            )
            and isinstance(
                value,
                list,
            )
        ):

            target[key] = [
                v
                for v in value
                if isinstance(
                    v,
                    (str, dict),
                )
            ]

            continue

        # -------------------------------------------------------------- #
        # Scalar values                                                  #
        # -------------------------------------------------------------- #

        if (
            key in target
            and isinstance(
                value,
                (
                    str,
                    int,
                    float,
                    bool,
                ),
            )
        ):

            target[key] = value


# --------------------------------------------------------------------------- #
# REST: games                                                                  #
# --------------------------------------------------------------------------- #

@app.get("/api/games")
def api_games():
    return jsonify(
        all_games(
            include_remote=_want_remote()
        )
    )


@app.get("/api/games/<game_id>")
def api_game(
    game_id: str,
):
    game = all_games(
        include_remote=_want_remote()
    ).get(
        game_id
    )

    if game is None:
        return jsonify(
            {
                "error": "unknown game system"
            }
        ), 404

    return jsonify(game)


# --------------------------------------------------------------------------- #
# Rules knowledge                                                              #
# --------------------------------------------------------------------------- #

_RULE_KEYS = (
    "skills",
    "races",
    "classes",
    "backgrounds",
    "spells",
    "conditions",
    "damages",
    "alignments",
)


def _empty_rules() -> dict:
    return {
        key: []
        for key in _RULE_KEYS
    }


def _dedup_by_name(
    items: list,
) -> list:
    """Drop duplicate entries by case-insensitive name."""

    out = []
    seen = set()

    for item in items:

        if not isinstance(
            item,
            dict,
        ):
            continue

        key = str(
            item.get(
                "name",
                "",
            )
        ).strip().lower()

        if not key or key in seen:
            continue

        seen.add(key)
        out.append(item)

    return out


def _normalize_feature_map(
    raw_features,
) -> dict:
    features = {}

    if not isinstance(
        raw_features,
        dict,
    ):
        return features

    for level, names in raw_features.items():

        sequence = (
            names
            if isinstance(
                names,
                list,
            )
            else [names]
        )

        normalized = []

        for item in sequence:

            if isinstance(
                item,
                str,
            ):

                normalized.append(
                    {
                        "name": item,
                        "description": "",
                    }
                )

            elif isinstance(
                item,
                dict,
            ):

                normalized.append(
                    {
                        **item,
                        "name": (
                            item.get(
                                "name"
                            )
                            or "Feature"
                        ),
                        "description": item.get(
                            "description",
                            "",
                        ),
                    }
                )

        features[str(level)] = normalized

    return features


def _profile_rules(
    system: str,
) -> dict:
    """
    Normalize local profile data into the shared rules/rewards shape.

    Generic choices are preserved.
    Legacy subclass data is also converted to a generic choice.
    """

    game = local_games().get(
        system
    ) or {}

    out = {
        **_empty_rules(),
        "system": system,
        "source": "local-profile",
    }

    # ------------------------------------------------------------------ #
    # Races                                                              #
    # ------------------------------------------------------------------ #

    race_data = (
        game.get("race_data")
        or {}
    )

    for name, data in race_data.items():

        data = (
            data
            if isinstance(
                data,
                dict,
            )
            else {}
        )

        traits = []

        for item in data.get(
            "traits",
            [],
        ):

            if isinstance(
                item,
                str,
            ):

                traits.append(
                    {
                        "name": item,
                        "description": "",
                    }
                )

            elif isinstance(
                item,
                dict,
            ):

                traits.append(
                    {
                        **item,
                        "name": item.get(
                            "name",
                            "Trait",
                        ),
                        "description": item.get(
                            "description",
                            "",
                        ),
                    }
                )

        out["races"].append(
            {
                "name": name,
                "traits": traits,
                "skill_proficiencies": list(
                    data.get(
                        "skill_proficiencies",
                        [],
                    )
                ),
                "ability_scores": data.get(
                    "ability_scores",
                    {},
                ),
                "subraces": [],
            }
        )

    by_race = {
        race["name"]: race
        for race in out["races"]
    }

    # ------------------------------------------------------------------ #
    # Subraces / heritages                                              #
    # ------------------------------------------------------------------ #

    for race_name, subs in (
        game.get("subrace_data")
        or {}
    ).items():

        race = by_race.get(
            race_name
        )

        if (
            not race
            or not isinstance(
                subs,
                dict,
            )
        ):
            continue

        for sub_name, sub_data in subs.items():

            sub_data = (
                sub_data
                if isinstance(
                    sub_data,
                    dict,
                )
                else {}
            )

            traits = []

            for item in sub_data.get(
                "traits",
                [],
            ):

                if isinstance(
                    item,
                    str,
                ):

                    traits.append(
                        {
                            "name": item,
                            "description": "",
                        }
                    )

                elif isinstance(
                    item,
                    dict,
                ):

                    traits.append(
                        {
                            **item,
                            "name": item.get(
                                "name",
                                "Trait",
                            ),
                            "description": item.get(
                                "description",
                                "",
                            ),
                        }
                    )

            race["subraces"].append(
                {
                    "name": sub_name,
                    "traits": traits,
                    "ability_scores": sub_data.get(
                        "ability_scores",
                        {},
                    ),
                }
            )

    # ------------------------------------------------------------------ #
    # Classes                                                            #
    # ------------------------------------------------------------------ #

    class_data = (
        game.get("class_data")
        or {}
    )

    for name, data in class_data.items():

        data = (
            data
            if isinstance(
                data,
                dict,
            )
            else {}
        )

        features = _normalize_feature_map(
            data.get(
                "features"
            )
        )

        raw_choices = data.get(
            "choices",
            [],
        )

        choices = []

        if isinstance(
            raw_choices,
            list,
        ):

            for choice in raw_choices:

                if not isinstance(
                    choice,
                    dict,
                ):
                    continue

                choices.append(
                    dict(choice)
                )

        # If the profile still uses the old subclass structure, don't
        # throw it away. Convert it into the generic choices system.
        if not any(
            c.get("id") == "subclass"
            for c in choices
        ):

            legacy = _legacy_subclass_choice(
                name,
                data,
                game,
            )

            if legacy is not None:
                choices.append(
                    legacy
                )

        class_entry = {
            "name": name,

            "skills": [
                {
                    "name": skill,
                    "choice": None,
                    "options": [],
                }
                for skill in data.get(
                    "skills",
                    [],
                )
                if isinstance(
                    skill,
                    str,
                )
            ],

            "features": features,

            "starting_features": features.get(
                "1",
                [],
            ),

            "is_spellcaster": bool(
                data.get(
                    "spellcaster",
                    False,
                )
            ),

            "spellcasting_ability": data.get(
                "spellcasting_ability",
                "",
            ),

            # Generic choice system.
            "choices": choices,

            # Optional arbitrary class metadata.
            "role_ability": data.get(
                "role_ability"
            ),

            # Legacy compatibility.
            "subclass_level": data.get(
                "subclass_level"
            ),

            "subclass_label": data.get(
                "subclass_label"
            ),
        }

        out["classes"].append(
            class_entry
        )

    # ------------------------------------------------------------------ #
    # Backgrounds                                                       #
    # ------------------------------------------------------------------ #

    bg = (
        game.get("backgrounds")
        or {}
    )

    suggestions = bg.get(
        "suggestions",
        [],
    )

    if not isinstance(
        suggestions,
        list,
    ):
        suggestions = []

    out["backgrounds"] = [
        {
            "name": name
        }
        for name in suggestions
        if name != "Custom..."
    ]

    return out


def rules_payload(
    system: str,
    level: int = 1,
) -> dict:
    """
    Return one stable rules/rewards format for every selectable system.

    `level` controls which generic class choices are visible.

    Examples:

        /api/rules/dnd5e?level=1
        /api/rules/dnd5e?level=5

    A choice with:

        "level": 3

    is absent at level 1 and available at level 3+.

    There is no special subclass filter anymore.
    """

    local = _profile_rules(
        system
    )

    base = dict(local)

    base["system"] = system
    base["offline"] = not _want_remote()
    base["character_level"] = level

    if _want_remote():

        try:

            if system == "dnd5e":
                live = fiveetools.five_e()

            elif system == "pathfinder2e":
                live = pf2etools.pf2e()

            else:
                live = None

            if isinstance(
                live,
                dict,
            ):

                for key, value in live.items():

                    if value not in (
                        None,
                        [],
                        {},
                    ):
                        base[key] = value

                base["source"] = (
                    "live+local"
                )

        except Exception:
            base["source"] = (
                "local-profile"
            )

    # Deduplicate live/local rule entries.
    base["races"] = _dedup_by_name(
        base.get(
            "races",
            [],
        )
    )

    base["classes"] = _dedup_by_name(
        base.get(
            "classes",
            [],
        )
    )

    # Reattach the editable local class metadata, including generic choices.
    base = _augment_class_choices(
        base,
        system,
        level,
    )

    return base


@app.get("/api/rules/<system>")
def api_rules(
    system: str,
):
    """
    Rules lookup endpoint.

    Query:
        ?level=1

    Example:
        /api/rules/dnd5e?level=1
    """

    level = max(
        1,
        _safe_int(
            request.args.get(
                "level",
                1,
            ),
            1,
        ),
    )

    return jsonify(
        rules_payload(
            system,
            level,
        )
    )


@app.get("/api/adventure/<adv_id>")
def api_adventure(
    adv_id: str,
):
    """Full 5etools adventure data."""

    if not _want_remote():
        return jsonify(
            {
                "error": (
                    "adventure data only available "
                    "with internet (or a fresh cache)"
                )
            }
        ), 404

    data = fiveetools.adventure(
        adv_id
    )

    if not data:
        return jsonify(
            {
                "error": (
                    "adventure not found "
                    "(offline or bad id)"
                )
            }
        ), 404

    return jsonify(data)


# --------------------------------------------------------------------------- #
# Campaign endpoints                                                           #
# --------------------------------------------------------------------------- #

@app.get("/api/campaigns")
def api_campaigns():
    return jsonify(
        all_campaigns(
            for_system=(
                request.args.get(
                    "system"
                )
                or None
            ),
            include_remote=_want_remote(),
        )
    )


@app.post("/api/campaigns")
def api_create_campaign():
    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    campaign_type = payload.get(
        "type",
        "premade",
    )

    campaign = {
        "id": (
            "camp_"
            + uuid.uuid4().hex[:8]
        ),
        "title": payload.get(
            "title",
            "Untitled Campaign",
        ),
        "system": payload.get(
            "system",
            "any",
        ),
        "type": campaign_type,
        "description": payload.get(
            "description",
            "",
        ),
        "setting": payload.get(
            "setting",
            "",
        ),
        "tone": payload.get(
            "tone",
            "",
        ),
        "world_notes": payload.get(
            "world_notes",
            "",
        ),
        "ai_generated": (
            campaign_type
            == "aigenerated"
        ),
        "created_at": _now(),
        "source": "local",
    }

    campaigns = (
        load_local_campaigns()
    )

    campaigns.append(
        campaign
    )

    save_local_campaigns(
        campaigns
    )

    return jsonify(
        campaign
    ), 201


# --------------------------------------------------------------------------- #
# Character endpoints                                                          #
# --------------------------------------------------------------------------- #

@app.get("/api/characters")
def api_list_characters():
    sheets = []

    for p in sorted(
        SHEET_DIR.glob(
            "char_sheet_*.json"
        )
    ):

        try:

            with open(
                p,
                encoding="utf-8",
            ) as f:
                sheet = json.load(f)

            identity = sheet.get(
                "identity",
                {},
            )

            sheets.append(
                {
                    "id": sheet.get(
                        "id"
                    ),
                    "name": identity.get(
                        "name",
                        "",
                    ),
                    "system_label": sheet.get(
                        "system_label",
                        "",
                    ),
                    "campaign": sheet.get(
                        "campaign",
                        {},
                    ).get(
                        "title"
                    ),
                    "player": identity.get(
                        "player_name",
                        "",
                    ),
                    "created_at": sheet.get(
                        "created_at",
                        "",
                    ),
                }
            )

        except (
            json.JSONDecodeError,
            KeyError,
            OSError,
        ):
            continue

    return jsonify(
        sheets
    )


@app.get(
    "/api/characters/<sheet_id>"
)
def api_get_character(
    sheet_id: str,
):
    """?view=public → only what the group knows."""

    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    if request.args.get(
        "view"
    ) == "public":

        public_view = {
            key: value
            for key, value in sheet.items()
            if key != "hidden"
        }

        public_view.setdefault(
            "visibility",
            {},
        )["hidden_revealed"] = False

        return jsonify(
            public_view
        )

    return jsonify(
        sheet
    )


@app.post("/api/characters")
def api_create_character():
    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    games = all_games()

    system = payload.get(
        "system",
        "dnd5e",
    )

    if system not in games:

        system = (
            "custom"
            if "custom" in games
            else next(
                iter(games)
            )
        )

    sheet = new_sheet(
        system
    )

    # Optional campaign link.
    camp_payload = payload.get(
        "campaign"
    )

    campaign_block = None

    if (
        isinstance(
            camp_payload,
            dict,
        )
        and camp_payload.get("id")
    ):

        cid = camp_payload[
            "id"
        ]

        if cid == "ai-generated":

            camp = {
                "id": (
                    "camp_ai_"
                    + uuid.uuid4().hex[:8]
                ),
                "title": (
                    camp_payload.get(
                        "title"
                    )
                    or (
                        "AI Campaign "
                        + _now()[:10]
                    )
                ),
                "system": system,
                "type": "aigenerated",
                "description": (
                    "AI-invented campaign, "
                    "seeded by the character creator."
                ),
                "setting": camp_payload.get(
                    "setting",
                    "",
                ),
                "tone": camp_payload.get(
                    "tone",
                    "",
                ),
                "world_notes": "",
                "seed": camp_payload.get(
                    "seed",
                    "",
                ),
                "ai_generated": True,
                "created_at": _now(),
                "source": "ai",
            }

            save_local_campaigns(
                load_local_campaigns()
                + [camp]
            )

            camp_payload = camp

        else:

            camp = next(
                (
                    campaign
                    for campaign in all_campaigns(
                        None
                    )
                    if campaign.get(
                        "id"
                    ) == cid
                ),
                {
                    "id": cid,
                    "title": camp_payload.get(
                        "title",
                        cid,
                    ),
                },
            )

        campaign_block = {
            "id": camp.get(
                "id"
            ),
            "title": camp.get(
                "title"
            ),
            "ai_generated": camp.get(
                "ai_generated",
                False,
            ),
            "seed": camp_payload.get(
                "seed",
                "",
            ),
        }

    _merge(
        sheet,
        payload,
    )

    if campaign_block:
        sheet["campaign"] = (
            campaign_block
        )

    return jsonify(
        save_sheet(sheet)
    ), 201


@app.put(
    "/api/characters/<sheet_id>"
)
def api_update_character(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    _merge(
        sheet,
        request.get_json(
            silent=True
        )
        or {},
    )

    return jsonify(
        save_sheet(sheet)
    )


@app.delete(
    "/api/characters/<sheet_id>"
)
def api_delete_character(
    sheet_id: str,
):
    path = sheet_path(
        sheet_id
    )

    if not path.exists():
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    path.unlink()

    return jsonify(
        {
            "deleted": sheet_id
        }
    )


@app.post(
    "/api/characters/<sheet_id>/toggle-hidden"
)
def api_toggle_hidden(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    visibility = sheet.setdefault(
        "visibility",
        {},
    )

    visibility[
        "hidden_revealed"
    ] = not visibility.get(
        "hidden_revealed",
        False,
    )

    return jsonify(
        save_sheet(sheet)
    )


# --------------------------------------------------------------------------- #
# Progression                                                                  #
# --------------------------------------------------------------------------- #

def _progression(
    sheet: dict,
) -> list | None:
    """XP → level table for the sheet's system."""

    game = all_games().get(
        sheet.get("system")
    )

    prog = (
        game or {}
    ).get(
        "progression"
    ) or {}

    table = prog.get(
        "xp_levels"
    ) or []

    return table or None


def _level_for(
    xp: int,
    table: list,
) -> int:
    """Highest level whose XP threshold is <= XP."""

    level = 1

    for i, threshold in enumerate(
        table,
        start=1,
    ):

        try:
            threshold = int(
                threshold
            )
        except (
            TypeError,
            ValueError,
        ):
            continue

        if xp >= threshold:
            level = i

    return level


@app.post(
    "/api/characters/<sheet_id>/xp"
)
def api_award_xp(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    try:
        amount = int(
            payload.get(
                "amount",
                0,
            )
        )
    except (
        TypeError,
        ValueError,
    ):
        return jsonify(
            {
                "error": "amount must be an integer"
            }
        ), 400

    table = _progression(
        sheet
    )

    progression = sheet.setdefault(
        "progression",
        {
            "xp": 0,
            "level": 1,
        },
    )

    old_level = int(
        progression.get(
            "level"
        )
        or sheet.get(
            "identity",
            {},
        ).get(
            "level",
            1,
        )
        or 1
    )

    progression["xp"] = (
        int(
            progression.get(
                "xp",
                0,
            )
        )
        + amount
    )

    new_level = (
        _level_for(
            progression["xp"],
            table,
        )
        if table
        else old_level
    )

    leveled_up = (
        new_level > old_level
    )

    progression[
        "level"
    ] = new_level

    if leveled_up:

        sheet.setdefault(
            "identity",
            {},
        )["level"] = (
            new_level
        )

        sheet.setdefault(
            "hidden",
            {},
        ).setdefault(
            "messages",
            [],
        ).append(
            new_message(
                (
                    "You leveled up to "
                    f"level {new_level}!"
                ),
                kind="levelup",
            )
        )

    save_sheet(
        sheet
    )

    return jsonify(
        {
            "xp": progression["xp"],
            "level": new_level,
            "old_level": old_level,
            "leveled_up": leveled_up,
        }
    )


# --------------------------------------------------------------------------- #
# Inventory                                                                    #
# --------------------------------------------------------------------------- #

@app.post(
    "/api/characters/<sheet_id>/inventory"
)
def api_add_item(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    item = (
        request.get_json(
            silent=True
        )
        or {}
    )

    name = str(
        item.get(
            "name",
            "",
        )
    ).strip()

    if not name:
        return jsonify(
            {
                "error": "item name required"
            }
        ), 400

    inventory = sheet.setdefault(
        "inventory",
        [],
    )

    try:
        qty = int(
            item.get(
                "qty",
                1,
            )
        )
    except (
        TypeError,
        ValueError,
    ):
        qty = 1

    qty = qty or 1

    for existing in inventory:

        if existing.get(
            "name"
        ) == name:

            try:
                old_qty = int(
                    existing.get(
                        "qty",
                        1,
                    )
                )
            except (
                TypeError,
                ValueError,
            ):
                old_qty = 1

            existing["qty"] = (
                old_qty + qty
            )

            save_sheet(
                sheet
            )

            return jsonify(
                existing
            ), 200

    entry = {
        "name": name,
        "qty": qty,
        "notes": item.get(
            "notes",
            "",
        ),
    }

    inventory.append(
        entry
    )

    save_sheet(
        sheet
    )

    return jsonify(
        entry
    ), 201


@app.delete(
    "/api/characters/<sheet_id>/inventory/<int:index>"
)
def api_remove_item(
    sheet_id: str,
    index: int,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    inventory = sheet.setdefault(
        "inventory",
        [],
    )

    if not (
        0 <= index < len(inventory)
    ):
        return jsonify(
            {
                "error": "bad inventory index"
            }
        ), 404

    removed = inventory.pop(
        index
    )

    save_sheet(
        sheet
    )

    return jsonify(
        {
            "removed": removed
        }
    )


# --------------------------------------------------------------------------- #
# Hidden messages                                                              #
# --------------------------------------------------------------------------- #

@app.post(
    "/api/characters/<sheet_id>/messages"
)
def api_send_message(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    text = str(
        payload.get(
            "text",
            "",
        )
    ).strip()

    if not text:
        return jsonify(
            {
                "error": "message text required"
            }
        ), 400

    msg = new_message(
        text,
        from_name=payload.get(
            "from"
        ) or "DM",
        kind=payload.get(
            "kind"
        ) or "note",
    )

    sheet.setdefault(
        "hidden",
        {},
    ).setdefault(
        "messages",
        [],
    ).append(msg)

    save_sheet(
        sheet
    )

    return jsonify(
        msg
    ), 201


@app.get(
    "/api/characters/<sheet_id>/messages"
)
def api_list_messages(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    return jsonify(
        sheet.get(
            "hidden",
            {},
        ).get(
            "messages",
            [],
        )
    )


@app.post(
    "/api/characters/<sheet_id>/messages/<msg_id>/read"
)
def api_mark_read(
    sheet_id: str,
    msg_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    messages = (
        sheet.get(
            "hidden",
            {},
        ).get(
            "messages",
            [],
        )
    )

    for message in messages:

        if message.get(
            "id"
        ) == msg_id:

            message["read"] = True

            save_sheet(
                sheet
            )

            return jsonify(
                message
            )

    return jsonify(
        {
            "error": "message not found"
        }
    ), 404


# --------------------------------------------------------------------------- #
# Party / whispers                                                             #
# --------------------------------------------------------------------------- #

@app.get(
    "/api/characters/<sheet_id>/party"
)
def api_party(
    sheet_id: str,
):
    sheet = load_sheet(
        sheet_id
    )

    if sheet is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    others = []

    current_path = sheet_path(
        sheet_id
    )

    for p in sorted(
        SHEET_DIR.glob(
            "char_sheet_*.json"
        )
    ):

        if p.stem == current_path.stem:
            continue

        try:

            with open(
                p,
                encoding="utf-8",
            ) as f:
                other = json.load(f)

            identity = other.get(
                "identity",
                {},
            )

            others.append(
                {
                    "id": other.get(
                        "id"
                    ),
                    "name": identity.get(
                        "name",
                        "",
                    ),
                    "race": identity.get(
                        "race",
                        "",
                    ),
                    "class": identity.get(
                        "class",
                        "",
                    ),
                    "level": identity.get(
                        "level",
                        1,
                    ),
                    "portrait": identity.get(
                        "portrait",
                        "🧑",
                    ),
                    "player": identity.get(
                        "player_name",
                        "",
                    ),
                }
            )

        except (
            json.JSONDecodeError,
            KeyError,
            OSError,
        ):
            continue

    return jsonify(
        others
    )


@app.post(
    "/api/characters/<sheet_id>/whisper"
)
def api_whisper(
    sheet_id: str,
):
    sender = load_sheet(
        sheet_id
    )

    if sender is None:
        return jsonify(
            {
                "error": "character not found"
            }
        ), 404

    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    target_id = payload.get(
        "to"
    )

    text = str(
        payload.get(
            "text",
            "",
        )
    ).strip()

    if not target_id:
        return jsonify(
            {
                "error": (
                    "recipient 'to' required"
                )
            }
        ), 400

    if not text:
        return jsonify(
            {
                "error": (
                    "message text required"
                )
            }
        ), 400

    target = load_sheet(
        target_id
    )

    if target is None:
        return jsonify(
            {
                "error": (
                    "recipient not found"
                )
            }
        ), 404

    sender_identity = sender.get(
        "identity",
        {},
    )

    sender_name = (
        sender_identity.get(
            "name"
        )
        or "a character"
    )

    target_identity = target.get(
        "identity",
        {},
    )

    target_name = (
        target_identity.get(
            "name"
        )
        or target_id
    )

    msg = new_message(
        text,
        from_name=sender_name,
        kind="whisper",
        to=target_name,
    )

    target.setdefault(
        "hidden",
        {},
    ).setdefault(
        "messages",
        [],
    ).append(msg)

    save_sheet(
        target
    )

    return jsonify(
        msg
    ), 201


# --------------------------------------------------------------------------- #
# Health                                                                       #
# --------------------------------------------------------------------------- #

@app.get("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "local_games": [
                p.stem
                for p in sorted(
                    GAME_DIR.glob(
                        "*.json"
                    )
                )
            ],
            "sheets": [
                p.name
                for p in SHEET_DIR.glob(
                    "char_sheet_*.json"
                )
            ],
        }
    )


# --------------------------------------------------------------------------- #
# Web UI                                                                       #
# --------------------------------------------------------------------------- #

@app.get("/")
def index():
    return send_from_directory(
        BASE_DIR,
        "webui.html",
    )


@app.get("/webui.js")
def webui_js():
    return send_from_directory(
        BASE_DIR,
        "webui.js",
    )


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":

    print(
        "Char Creator running at "
        "http://127.0.0.1:5000"
    )

    print(
        "  local games  : "
        f"{sorted(p.stem for p in GAME_DIR.glob('*.json'))}"
    )

    print(
        f"  remote games : {DMS_API_URL}"
    )

    print(
        "  campaigns    : "
        f"{CAMPAIGNS_FILE.name} + "
        f"{E5TTOOLS_ADVENTURES_URL}"
    )

    try:

        _5 = fiveetools.five_e()
        _p2 = pf2etools.pf2e()

        print(
            "  live rules   : "
            f"5e {len(_5.get('classes', []))} classes / "
            f"{len(_5.get('races', []))} races | "
            f"PF2e "
            f"{len(_p2.get('classes', []))} classes / "
            f"{len(_p2.get('races', []))} races "
            "(offline if 0)"
        )

    except Exception:

        print(
            "  live rules   : "
            "offline/unavailable "
            "(local profiles remain)"
        )

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True,
    )