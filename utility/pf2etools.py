"""
pf2etools.py — Pathfinder 2e rules knowledge from Pf2eTools (open JSON).

Pf2eTools mirrors the officially-fan-hosted Archives of Nethys data as plain
JSON on GitHub, so Pathfinder 2e races (ancestries), sub-races (heritages),
classes, per-level class features, and subclasses (archetypes/specializations)
pull live — same graceful offline degradation as fiveetools.py.

    pf2e() → {skills, races (incl. subraces/heritages), classes (incl.
              per-level features + subclasses), spells, backgrounds}

source: https://github.com/Pf2eToolsOrg/Pf2eTools  (data/ directory)
"""

from remote import cached_remote

BASE = "https://raw.githubusercontent.com/Pf2eToolsOrg/Pf2eTools/master/data"
# include a token-free mirror path as fallback for the raw.githubusercontent
# (both return the same JSON; cached_remote caches whichever succeeds)


def _rows(url: str) -> list:
    """GET a Pf2eTools data URL, coerce to a list of dicts ([] when offline)."""
    data = cached_remote(url)
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        # some files are a dict keyed by name
        return [v for v in data.values() if isinstance(v, dict)]
    return []


# --------------------------------------------------------------------------- #
#  Normalizers — Pf2eTools shape → the compact shape the UI already uses      #
# --------------------------------------------------------------------------- #

def _ancestry(x: dict) -> dict:
    """Pf2eTools race → {name, hp, size, speed, traits, subraces(heritages),
    languages, ability_boosts}."""
    boosts = x.get("abilityBoosts") or []
    flaws = x.get("abilityFlaws") or []
    return {
        "name": x.get("name", ""),
        "speed": (x.get("speed") or {}).get("walk") if isinstance(x.get("speed"), dict) else x.get("speed"),
        "hp": x.get("hp"),
        "size": x.get("size"),
        "ability_scores": None,   # PF2e uses boosts/flaws, surfaced as traits
        "ability_boosts": [b for b in boosts if isinstance(b, str)],
        "ability_flaws": [f for f in flaws if isinstance(f, str)],
        "languages": [l.get("name") if isinstance(l, dict) else l
                      for l in (x.get("languages") or [])],
        "traits": [{"name": t, "description": ""} for t in (x.get("traits") or [])
                   if isinstance(t, str)],
        "subraces": [_heritage(h) for h in (x.get("heritages") or [])
                     if isinstance(h, dict)],
        "sourcebook": (x.get("source") or {}).get("name", "") if isinstance(x.get("source"), dict) else (x.get("source") or ""),
        "image": None,
    }


def _heritage(x: dict) -> dict:
    """Pf2eTools heritage → {name, traits} (a PF2e 'subrace')."""
    return {
        "name": x.get("name", ""),
        "traits": [{"name": t, "description": ""} for t in (x.get("traits") or [])
                   if isinstance(t, str)],
        "description": x.get("description") or x.get("overview") or "",
    }


def _pf2e_class(x: dict) -> dict:
    """Pf2eTools class → {name, hp, key_ability, features (per level),
    subclasses} matching the shape renderLevels/renderSubclass expect."""
    features = x.get("classFeatures") or []
    per_level = {}
    starting = []
    for f in features:
        if not isinstance(f, dict):
            continue
        lvl = str(f.get("level") or 1)
        entry = {
            "name": f.get("name", ""),
            "description": f.get("description") or (f.get("entries") and _flatten(f["entries"])) or "",
        }
        (per_level.setdefault(lvl, []).append(entry))
        if lvl == "1":
            starting.append(entry)
    subs = []
    for sc in (x.get("subclasses") or []):
        if not isinstance(sc, dict):
            continue
        subs.append({
            "name": sc.get("name", ""),
            "description": sc.get("description") or (sc.get("entries") and _flatten(sc["entries"])) or "",
        })
    return {
        "name": x.get("name", ""),
        "hit_die": (x.get("hp") or {}).get("d") if isinstance(x.get("hp"), dict) else x.get("hp"),
        "key_ability": x.get("keyAbility") or x.get("keyAbilityScore") or "",
        "saving_throws": [k for k, v in (x.get("savingThrows") or {}).items() if v] if isinstance(x.get("savingThrows"), dict) else [],
        "skills": [],
        "starting_features": starting,
        "subclasses": subs,
        "features": per_level,
        "spellcasting_ability": "",
        "is_spellcaster": bool(x.get("spellcasting")),
        "sourcebook": "",
        "image": None,
    }


def _flatten(entries) -> str:
    """Pf2eTools uses [{type, name, entries: [...]}] trees — flatten to text."""
    parts = []
    def walk(node):
        if isinstance(node, str):
            parts.append(node)
        elif isinstance(node, dict):
            if node.get("name"):
                parts.append(node["name"])
            for e in (node.get("entries") or []):
                walk(e)
        elif isinstance(node, list):
            for e in node:
                walk(e)
    walk(entries)
    return " ".join(p for p in parts if p).strip()


# --------------------------------------------------------------------------- #
#  Fetchers                                                                     #
# --------------------------------------------------------------------------- #

def ancestries() -> list:
    return [_ancestry(x) for x in _rows(f"{BASE}/races.json")]


def classes() -> list:
    # class list from data/class/index.json, then each class file by name
    index = _rows(f"{BASE}/class/index.json")
    names = [x.get("name", "") for x in index if x.get("name")]
    if not names:
        # fall back to a bundle if present
        bundle = _rows(f"{BASE}/classes.json")
        return [_pf2e_class(x) for x in bundle]
    out = []
    for name in names:
        cls = cached_remote(f"{BASE}/class/{name}.json")
        if isinstance(cls, dict):
            out.append(_pf2e_class(cls))
    return out


def spells() -> list:
    data = cached_remote(f"{BASE}/spells/index.json")
    rows = data.get("spell") if isinstance(data, dict) else data
    return [{"name": x.get("name", ""), "level": x.get("level", 0),
             "school": (x.get("traditions") or {}).get("arcane") and "arcane" or ""}
            for x in ([r for r in rows] if isinstance(rows, list) else []) if isinstance(x, dict)]


def pf2e() -> dict:
    """The whole PF2e knowledge base in the same shape as five_e()."""
    return {
        "skills": [],
        "races": ancestries(),
        "classes": classes(),
        "backgrounds": [],
        "spells": spells(),
        "conditions": [],
        "damages": [],
        "alignments": [],
        "source": "Pf2eTools / Archives of Nethys (open data)",
    }