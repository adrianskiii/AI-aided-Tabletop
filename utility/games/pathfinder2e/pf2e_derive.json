"""
pf2e_derive.py — compute Pathfinder 2e (Remaster) derived stats for a sheet.

Writes sheet["stats"]; never touches abilities/build/choices, so it is safe
to call on every save from derive().

    from pf2e_derive import derive_pf2e_stats
    sheet = derive_pf2e_stats(sheet, class_data, ancestry_data, background_data)

Inputs `class_data` / `ancestry_data` are the dicts from your class.json /
main.json (tolerant lookups, see _first()). Missing values fall back to the
Player Core tables below and are listed in stats["missing"].
"""

RANK_BONUS = {"untrained": 0, "trained": 2, "expert": 4, "master": 6, "legendary": 8}
RANK_ORDER = ["untrained", "trained", "expert", "master", "legendary"]

ABILS = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]
SHORT = {"str": "strength", "dex": "dexterity", "con": "constitution",
         "int": "intelligence", "wis": "wisdom", "cha": "charisma"}

SKILL_ABILITY = {
    "Acrobatics": "dexterity", "Arcana": "intelligence", "Athletics": "strength",
    "Crafting": "intelligence", "Deception": "charisma", "Diplomacy": "charisma",
    "Intimidation": "charisma", "Medicine": "wisdom", "Nature": "wisdom",
    "Occultism": "intelligence", "Performance": "charisma", "Religion": "wisdom",
    "Society": "intelligence", "Stealth": "dexterity", "Survival": "wisdom",
    "Thievery": "dexterity",
}

# Player Core / Player Core 2 fallbacks (class HP per level, key attribute(s)).
CLASS_FALLBACK = {
    "alchemist": (8, ["intelligence"]), "barbarian": (12, ["strength"]),
    "bard": (8, ["charisma"]), "champion": (10, ["strength", "dexterity"]),
    "cleric": (8, ["wisdom"]), "druid": (8, ["wisdom"]),
    "fighter": (10, ["strength", "dexterity"]), "investigator": (8, ["intelligence"]),
    "monk": (10, ["strength", "dexterity"]), "oracle": (8, ["charisma"]),
    "ranger": (10, ["strength", "dexterity"]), "rogue": (8, ["dexterity"]),
    "sorcerer": (6, ["charisma"]), "swashbuckler": (10, ["dexterity"]),
    "witch": (6, ["intelligence"]), "wizard": (6, ["intelligence"]),
    "magus": (8, ["strength", "dexterity"]), "summoner": (10, ["charisma"]),
    "thaumaturge": (8, ["charisma"]), "psychic": (6, ["intelligence", "charisma"]),
    "gunslinger": (8, ["dexterity"]), "inventor": (8, ["intelligence"]),
    "kineticist": (8, ["constitution"]), "animist": (8, ["wisdom"]),
    "exemplar": (10, ["strength", "dexterity"]),
}
SIZE_DEFAULT_SPEED = 25


def _first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, "", []):
            return d[k]
    return default


def _int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _mod(score):
    return (_int(score, 10) - 10) // 2


def _abil_name(v):
    if not isinstance(v, str):
        return None
    v = v.strip().lower()
    return SHORT.get(v[:3], v) if v[:3] in SHORT else None


def _best_rank(entries):
    best = "untrained"
    for e in entries:
        r = str(e.get("rank", "untrained")).lower()
        if r in RANK_ORDER and RANK_ORDER.index(r) > RANK_ORDER.index(best):
            best = r
    return best


def _primary_only(build):
    """Proficiencies that apply to stats.

    PF2e has no multiclassing: an archetype dedication never hands out a
    second class's saves / Perception / armor / weapons, so entries tagged
    '(multiclass)' are ignored here (they are still shown in the build).
    """
    return [p for p in build.get("proficiencies", [])
            if isinstance(p, dict) and "(multiclass)" not in str(p.get("source", ""))]


def _ranks(entries, name, category=None):
    hits = [p for p in entries
            if str(p.get("name", "")).lower() == name.lower()
            and (category is None or p.get("category") == category)]
    return _best_rank(hits)


def derive_pf2e_stats(sheet, class_data=None, ancestry_data=None, background_data=None):
    class_data = class_data or {}
    ancestry_data = ancestry_data or {}
    background_data = background_data or {}
    missing = []

    level = max(1, _int(sheet.get("identity", {}).get("level"), 1))
    ab = sheet.get("abilities", {})
    mods = {k: _mod(ab.get(k, 10)) for k in ABILS}
    build = sheet.get("build", {})
    profs = _primary_only(build)

    cls_slug = str(sheet.get("choices", {}).get("class", "")).lower().replace(" ", "_")
    fb_hp, fb_key = CLASS_FALLBACK.get(cls_slug, (8, ["strength"]))

    # ---- Hit points ------------------------------------------------------ #
    class_hp = _int(_first(class_data, "hp_per_level", "hit_points", "hp"), 0)
    if not class_hp:
        class_hp, _ = fb_hp, missing.append("class hp (used Player Core table)")
    anc_hp = _int(_first(ancestry_data, "hp", "hit_points"), 0)
    if not anc_hp:
        missing.append("ancestry hp (used 8)")
        anc_hp = 8
    max_hp = anc_hp + (class_hp + mods["constitution"]) * level

    prev = sheet.get("stats", {}).get("hp", {}) if isinstance(sheet.get("stats"), dict) else {}
    cur = prev.get("current")
    hp = {
        "max": max_hp,
        "current": min(_int(cur, max_hp), max_hp) if cur is not None else max_hp,
        "temp": _int(prev.get("temp"), 0),
        "breakdown": f"ancestry {anc_hp} + ({class_hp} class + {mods['constitution']:+d} Con) x {level}",
    }

    # ---- Key ability / Class DC ----------------------------------------- #
    key_raw = _first(class_data, "key_ability", "key_attribute")
    keys = [_abil_name(k) for k in (key_raw if isinstance(key_raw, list) else [key_raw])]
    keys = [k for k in keys if k] or fb_key
    chosen = _abil_name(sheet.get("choices", {}).get("key_ability", "")) or \
        max(keys, key=lambda k: mods[k])
    dc_rank = _ranks(profs, "Class DC")
    class_dc = 10 + mods[chosen] + level + RANK_BONUS[dc_rank]

    # ---- Saves / Perception --------------------------------------------- #
    def total(ability, rank):
        return mods[ability] + level + RANK_BONUS[rank] if rank != "untrained" else mods[ability]

    perc_rank = _ranks(profs, "Perception")
    saves = {}
    for name, ability in (("Fortitude", "constitution"), ("Reflex", "dexterity"), ("Will", "wisdom")):
        r = _ranks(profs, name)
        saves[name.lower()] = {"rank": r, "bonus": total(ability, r), "ability": ability}
    perception = {"rank": perc_rank, "bonus": total("wisdom", perc_rank), "ability": "wisdom",
                  "dc": 10 + total("wisdom", perc_rank)}

    # ---- Armor Class (unarmored baseline, no items yet) ----------------- #
    armor_rank = _ranks(profs, "Unarmored Armor", "armor")
    ac = {
        "value": 10 + mods["dexterity"] + level + (RANK_BONUS[armor_rank] if armor_rank != "untrained" else 0),
        "rank": armor_rank,
        "breakdown": f"10 + {mods['dexterity']:+d} Dex + {level} level + {RANK_BONUS[armor_rank]} prof (unarmored)",
        "note": "Baseline without armor/shield; add item bonus and Dex cap when equipment is modelled.",
    }

    # ---- Skills ---------------------------------------------------------- #
    skill_ranks = {}
    for p in profs:
        if p.get("category") == "skill":
            skill_ranks.setdefault(str(p["name"]).title(), []).append(p)
    for p in build.get("race_skills", []):
        if isinstance(p, dict) and p.get("name"):
            skill_ranks.setdefault(str(p["name"]).title(), []).append(p)
    for s in _first(background_data, "skills", default=[]) or []:
        skill_ranks.setdefault(str(s).title(), []).append({"rank": "trained"})

    skills = {}
    for name, ability in SKILL_ABILITY.items():
        r = _best_rank(skill_ranks.get(name, []))
        skills[name] = {"rank": r, "bonus": total(ability, r), "ability": ability}

    # ---- Attacks (by weapon category) ------------------------------------ #
    attacks = {}
    for cat in ("Unarmed", "Simple", "Martial", "Advanced"):
        r = _ranks(profs, f"{cat} Weapons", "weapons")
        for kind, ability in (("melee", "strength"), ("ranged", "dexterity")):
            attacks[f"{cat.lower()}_{kind}"] = {"rank": r, "bonus": total(ability, r)}

    # ---- Speed / size ---------------------------------------------------- #
    speed = _first(ancestry_data, "speed", default=None)
    if isinstance(speed, dict):
        speed = speed.get("walk") or speed.get("land")
    speed = _int(speed, 0)
    if not speed:
        speed = SIZE_DEFAULT_SPEED
        missing.append("ancestry speed (used 25)")

    sheet["stats"] = {
        "level": level, "hp": hp, "ac": ac, "class_dc": {"value": class_dc, "rank": dc_rank, "key_ability": chosen},
        "perception": perception, "saves": saves, "skills": skills, "attacks": attacks,
        "speed": speed, "size": _first(ancestry_data, "size", default="Medium"),
        "ability_modifiers": mods,
        "bulk_limit": {"encumbered_at": 5 + mods["strength"], "max": 10 + mods["strength"]},
        "missing": missing,
    }
    return sheet