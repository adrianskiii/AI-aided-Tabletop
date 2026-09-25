"""
fiveetools.py — 5e rules knowledge, outsourced to the 5etools API.

Everything here is *live SRD data* (https://api.5etools.co, no API key,
cached 6 h in .cache/, degrades gracefully offline). We deliberately do NOT
hardcode rule text — the UI asks this module for whatever it shows:

    five_e()          → dict of the merged knowledge base (one endpoint)
        skills        [{name, ability, ability_label, description,
                        sourcebook, url, image}]
        races         [{name, speed, traits[{name, description}], url, image,
                        sourcebook}]
        classes       [{name, hitDie, armor, skills[{name, level}],
                        features[{level, name, description, prerequisite}],
                        url, image, sourcebook}]
        backgrounds   [{name, skills[{name, level}], features, description,
                       url, sourcebook}]
        spells        [{name, level, school, description, url, image}]
                       (first 200 spells; the UI filters by class/school)
        conditions    [{name, description}]
        damage        [{name, description}]
        alignment     [{name, description}]
        dice          d2..d1000 (for a future dice roller)

Adventures (full data — chapters, maps, NPCs with stats and traits,
items) are loaded lazily by id in `adventure(id)`:

    adventure("curse-of-strahd") → {info..., chapters[...], npcs[...], ...}

Each object keeps the 5etools `url` where the authoritative page lives —
the UI links to it, so nobody has to google.
"""

from remote import cached_remote

BASE = "https://api.5etools.co"
SPELLS_URL = f"{BASE}/spells?limit=200"


# --------------------------------------------------------------------------- #
#  Small normalizers — raw 5etools shape → the compact shapes the UI uses      #
# --------------------------------------------------------------------------- #

def _skill(x: dict) -> dict:
    ab = (x.get("ability") or {}).get("abbreviation") or "?"
    ab_label = (x.get("ability") or {}).get("name") or ""
    return {
        "name": x.get("name", ""),
        "ability": ab,
        "ability_label": ab_label,
        "description": x.get("desc") or x.get("description") or "",
        "sourcebook": (x.get("sourcebook") or {}).get("name", ""),
        "url": x.get("page_url") or f"{BASE}/skills/{x.get('slug')}",
        "image": (x.get("image") or {}).get("thumbnail")
                 or (x.get("image") or {}).get("full"),
    }


def _race(x: dict) -> dict:
    # ability score bonuses: 5etools stores them on each trait as a
    # "ability" object {name, amount} → surface as a compact dict
    asi = {}
    for t in (x.get("traits") or []):
        ab = t.get("ability")
        if isinstance(ab, dict) and ab.get("name"):
            asi[ab["name"]] = ab.get("amount")
    traits = [{"name": t.get("name", ""),
               "description": t.get("description") or t.get("desc") or ""}
              for t in (x.get("traits") or [])]
    # skill / tool proficiencies the race grants (5etools "skillProficiencies",
    # "startProficiencies", or free-form "proficiencies" shapes)
    skill_profs = []
    for field in ("skillProficiencies", "startProficiencies", "proficiencies"):
        raw = x.get(field)
        if isinstance(raw, list):
            for p in raw:
                name = None
                if isinstance(p, str):
                    name = p
                elif isinstance(p, dict):
                    sk = p.get("skill") or p.get("proficiency") or p.get("name")
                    if isinstance(sk, dict):
                        name = sk.get("name")
                    elif sk:
                        name = sk
                    # "choose from N of [...options]" shapes
                    if not name and p.get("choose"):
                        opts = p.get("options") or p.get("from") or []
                        names = [o.get("name") if isinstance(o, dict) else o
                                 for o in opts]
                        name = "choose: " + "/".join(n for n in names if n)
                if name and isinstance(name, str):
                    skill_profs.append(name.strip())
    # dedupe, keep order (build a fresh list — never a shared/closed-over one)
    out, seen = [], set()
    for s in skill_profs:
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    skill_profs = out
    return {
        "name": x.get("name", ""),
        "speed": x.get("speed"),
        "ability_scores": asi or None,       # +Str etc; None when free-form
        "languages": [l.get("name") if isinstance(l, dict) else l
                      for l in (x.get("languages") or [])],
        "traits": traits,
        "skill_proficiencies": skill_profs,  # skills/tools granted by the race
        "subraces": [_race(sr) for sr in (x.get("subraces") or [])
                     if isinstance(sr, dict)],
        "sourcebook": (x.get("sourcebook") or {}).get("name", ""),
        "url": x.get("page_url") or f"{BASE}/races/{x.get('slug')}",
        "image": (x.get("image") or {}).get("full")
                 or (x.get("image") or {}).get("thumbnail"),
    }


def _class_features(x: dict) -> dict:
    """Normalize a class's per-level features from either API shape.

    5etools exposes class features in two ways depending on the endpoint:
      * `/classes`        → `features` is a LIST of {name, level, prerequisite}
      * some mirrors      → `features` is a DICT {level: [{name, …}]}
    Either way, fold it into {level: [{name, description, prerequisite}]}.
    Descriptions are joined later from `/classfeatures` by name (see below)."""
    raw = x.get("features")
    out = {}
    if isinstance(raw, dict):
        for lvl, feats in raw.items():
            for f in (feats or []):
                if not isinstance(f, dict):
                    continue
                out.setdefault(lvl, []).append({
                    "name": f.get("name", ""),
                    "description": f.get("desc") or f.get("description") or "",
                    "prerequisite": f.get("prerequisite") or "",
                })
    elif isinstance(raw, list):
        for f in raw:
            if not isinstance(f, dict):
                continue
            lvl = str(f.get("level") or f.get("level_start") or 1)
            out.setdefault(lvl, []).append({
                "name": f.get("name", ""),
                "description": f.get("desc") or f.get("description") or "",
                "prerequisite": f.get("prerequisite") or "",
            })
    # also accept classFeatures / levels free-form naming sometimes present
    alt = x.get("classFeatures")
    if isinstance(alt, list) and not out:
        for f in alt:
            if not isinstance(f, dict):
                continue
            lvl = str(f.get("level") or 1)
            out.setdefault(lvl, []).append({
                "name": f.get("feature") or f.get("name", ""),
                "description": f.get("description") or "",
                "prerequisite": f.get("prerequisite") or "",
            })
    return out


def _class(x: dict) -> dict:
    features = _class_features(x)
    starting = features.get("1", [])
    # whether this class picks spells (drives the "select spells/cantrips" UI)
    sc = x.get("spellcasting") or {}
    is_caster = bool(sc) and sc.get("ability") is not None
    spell_ability = (sc.get("ability") or {}).get("abbreviation") \
        if isinstance(sc.get("ability"), dict) else ""
    return {
        "name": x.get("name", ""),
        "hit_die": x.get("hitDies"),
        "saving_throws": x.get("savingThrows") or [],
        "skills": [{"name": s.get("name", ""),
                    "level": (s.get("proficiency") or {}).get("level"),
                    "choice": s.get("choice"),
                    "options": [o.get("name", "") for o in (s.get("option") or [])]}
                   for s in (x.get("skills") or [])],
        "armor": x.get("armor") or "none",
        "weapons": x.get("weapons") or "",
        "equipment": x.get("equipment") or "",
        "prerequisite": x.get("prerequisite") or "",
        "spellcasting_ability": (x.get("spellcastingAbility") or {}).get("abbreviation")
                                if isinstance(x.get("spellcastingAbility"), dict) else "",
        "is_spellcaster": is_caster or spell_ability != "",
        "spell_ability": spell_ability,
        "starting_features": starting,   # lvl-1 buffs (BG3-style "at 1st level…")
        "subclasses": [{
            "name": sc.get("name", ""),
            "description": sc.get("description") or sc.get("overview") or "",
            "features": sc.get("features") or [],
            "sourcebook": (sc.get("sourcebook") or {}).get("name", ""),
        } for sc in (x.get("subclasses") or []) if isinstance(sc, dict)],
        "features": features,
        "spellcasting": x.get("spellcasting") or "",
        "sourcebook": (x.get("sourcebook") or {}).get("name", ""),
        "url": x.get("page_url") or f"{BASE}/classes/{x.get('slug')}",
        "image": (x.get("image") or {}).get("full")
                 or (x.get("image") or {}).get("thumbnail"),
    }


def class_features() -> dict:
    """Full class-feature descriptions (5etools `/classfeatures` endpoint).

    Returns a name → {description, sourcebook} lookup so the per-level
    feature lists on each class can be enriched with real rule text —
    "what you're building" shown while creating the character."""
    data = cached_remote(f"{BASE}/classfeatures")
    rows = data.get("data") if isinstance(data, dict) else data
    lookup = {}
    for x in (rows or []):
        if not isinstance(x, dict):
            continue
        name = x.get("name") or ""
        if name:
            lookup[name.lower()] = {
                "description": x.get("description") or x.get("desc") or "",
                "sourcebook": (x.get("sourcebook") or {}).get("name", ""),
            }
    return lookup


def _background(x: dict) -> dict:
    skills_out = []
    for s in (x.get("skills") or []):
        skills_out.append({
            "name": s.get("name", ""),
            "choice": s.get("choice"),           # e.g. 2 → pick 2 skills
            "options": [o.get("name", "") for o in (s.get("option") or [])],
        })
    return {
        "name": x.get("name", ""),
        "skills": skills_out,
        "features": x.get("features") or "",
        "description": x.get("description") or "",
        "sourcebook": (x.get("sourcebook") or {}).get("name", ""),
        "url": x.get("page_url") or f"{BASE}/backgrounds/{x.get('slug')}",
    }


def _spell(x: dict) -> dict:
    sc = x.get("school") or {}
    return {
        "name": x.get("name", ""),
        "level": x.get("level", 0),
        "level_name": x.get("levelName") or "Cantrip",
        "ritual": bool(x.get("ritual")),
        "verbal": bool(x.get("verbal")),
        "somatic": bool(x.get("somatic")),
        "material": bool(x.get("material")),
        "focus": x.get("focus") or "",
        "time": (x.get("castingTime") or {}).get("time") or "",
        "range": (x.get("range") or {}).get("value") or "",
        "duration": (x.get("duration") or {}).get("name") or "",
        "description": x.get("description") or "",
        "sourcebook": (x.get("sourcebook") or {}).get("name", ""),
        "url": x.get("page_url") or f"{BASE}/spells/{x.get('slug')}",
        "image": (x.get("image") or {}).get("thumbnail"),
    }


def _simple_name_desc(x: dict) -> dict:
    """For conditions / damage types / alignments: {name, description}."""
    return {"name": x.get("name") or x.get("label", ""),
            "description": x.get("description") or x.get("longDesc") or ""}


# --------------------------------------------------------------------------- #
#  Fetchers (each returns [] when offline/unknown)                             #
# --------------------------------------------------------------------------- #

def skills() -> list:
    data = cached_remote(f"{BASE}/skills")
    rows = data.get("data") if isinstance(data, dict) else data
    return [_skill(x) for x in (rows or []) if isinstance(x, dict)]


def races() -> list:
    data = cached_remote(f"{BASE}/races")
    rows = data.get("data") if isinstance(data, dict) else data
    return [r for r in (_race(x) for x in (rows or []) if isinstance(x, dict))
            if r.get("name")]


def classes() -> list:
    data = cached_remote(f"{BASE}/classes")
    rows = data.get("data") if isinstance(data, dict) else data
    return [c for c in (_class(x) for x in (rows or []) if isinstance(x, dict))
            if c.get("name")]


def backgrounds() -> list:
    data = cached_remote(f"{BASE}/backgrounds")
    rows = data.get("data") if isinstance(data, dict) else data
    return [_background(x) for x in (rows or []) if isinstance(x, dict)]


def spells() -> list:
    """First 200 spells (cantrips → high level, alphabetical within)."""
    data = cached_remote(SPELLS_URL)
    rows = data.get("data") if isinstance(data, dict) else data
    return [_spell(x) for x in (rows or []) if isinstance(x, dict)]


def conditions() -> list:
    data = cached_remote(f"{BASE}/conditions")
    rows = data.get("data") if isinstance(data, dict) else data
    return [_simple_name_desc(x) for x in (rows or []) if isinstance(x, dict)]


def damages() -> list:
    data = cached_remote(f"{BASE}/damages")
    rows = data.get("data") if isinstance(data, dict) else data
    return [_simple_name_desc(x) for x in (rows or []) if isinstance(x, dict)]


def alignments() -> list:
    data = cached_remote(f"{BASE}/alignments")
    rows = data.get("data") if isinstance(data, dict) else data
    return [_simple_name_desc(x) for x in (rows or []) if isinstance(x, dict)]


def _by_name(rows: list, name: str) -> dict | None:
    n = (name or "").strip().lower()
    if not n:
        return None
    for r in rows:
        if r.get("name", "").lower() == n:
            return r
    for r in rows:   # loose match: "wizard" ⊂ "wizard class"?
        if n in r.get("name", "").lower():
            return r
    return None


# --------------------------------------------------------------------------- #
#  Adventure detail (lazy — one GET per adventure opened)                       #
# --------------------------------------------------------------------------- #

def adventure(adventure_id: str) -> dict:
    """Full 5etools adventure data, e.g. id 'curse-of-strahd' (no prefix).

    The id in campaigns.json may carry the '5etools_' prefix added by
    char_creator — it is stripped here.
    """
    slug = str(adventure_id or "").removeprefix("5etools_").strip()
    if not slug:
        return {}
    data = cached_remote(f"{BASE}/adventures/{slug}")
    if not isinstance(data, dict):
        return {}
    # compact the interesting parts; keep the raw payload under "raw"
    info = data.get("info") or {}
    book = info.get("book") or {}
    out = {
        "id": slug,
        "title": info.get("name", ""),
        "system": "dnd5e",
        "type": "premade",
        "description": info.get("blurb") or info.get("description") or "",
        "setting": book.get("name", "") or "5e sourcebook",
        "tone": "",
        "world_notes": "",
        "ai_generated": False,
        "source": "5etools",
        "url": info.get("page_url", ""),
        "url_full": data.get("url_full", ""),
        "recommended_level": info.get("recommendedLevel", ""),
        "play_times": info.get("playTimes", ""),
        "player_count": info.get("playerCount", ""),
        "image": (data.get("image") or {}).get("full"),
    }
    for key in ("chapters", "npcs", "creatures", "items", "maps",
                "spells", "encounters", "monsters"):
        rows = data.get(key) or []
        out[key] = rows if isinstance(rows, list) else []
    return out


# --------------------------------------------------------------------------- #
#  One-shot knowledge base (used by /api/rules/dnd5e)                           #
# --------------------------------------------------------------------------- #

def five_e() -> dict:
    """The whole SRD knowledge base in one dict. Empty lists when offline —
    the UI hides sections that come back empty (graceful degradation)."""
    cls = classes()
    # enrich per-level feature lists with full rule text from /classfeatures
    cf = class_features()
    if cf:
        for c in cls:
            for lvl, feats in (c.get("features") or {}).items():
                for f in feats:
                    if not f.get("description"):
                        hit = cf.get(f.get("name", "").lower())
                        if hit:
                            f["description"] = hit["description"]
            for s in c.get("starting_features") or []:
                if not s.get("description"):
                    hit = cf.get(s.get("name", "").lower())
                    if hit:
                        s["description"] = hit["description"]
    kb = {
        "skills": skills(),
        "races": races(),
        "classes": cls,
        "backgrounds": backgrounds(),
        "spells": spells(),
        "conditions": conditions(),
        "damages": damages(),
        "alignments": alignments(),
    }
    kb["source"] = "5etools.co (SRD 5.1, CC-BY)"
    return kb
