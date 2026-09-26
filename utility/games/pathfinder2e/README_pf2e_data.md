# Pathfinder 2e data pack

Four files, split by how trustworthy hand-authoring them is:

| File | What's in it | Completeness |
|---|---|---|
| `pf2e_core_mechanics.json` | Action economy, MAP, degrees of success, DC tables, saving throws, **all ~35 conditions**, currency, bulk, rest/downtime | Complete — this list is fixed by the rules and barely changes |
| `pf2e_skills_actions.json` | All 16 skills + Perception, each with its standard actions | Complete — same reasoning |
| `pf2e_spellcasting_system.json` | Traditions, spell ranks, slot tables per caster type (prepared vs. spontaneous), cantrip scaling, focus points, rituals | Complete for the *mechanics*; explicitly **not** the spell list itself |
| `pf2e_ancestries_classes.json` | Your original ancestries/heritages/classes/subclasses/backgrounds, cleaned up and merged | Complete for the *chassis*; class feats, skill feats, general feats, and full spell/monster/item catalogs are intentionally left out |

## Why the catalogs (spells, feats, monsters, items) aren't in here

Pathfinder 2e Remastered has roughly:
- 900+ spells across 4 traditions
- ~2,000+ feats (class, skill, general, ancestry) across 20+ classes
- 600+ monsters in the Bestiaries
- Hundreds of magic items, weapons, and armor entries

Typing these out from memory would produce a plausible-looking but partly wrong dataset — invented spell effects, wrong feat prerequisites, made-up monster stat blocks. That's actively dangerous for a tool meant to run or brief a real game, worse than just not having the data. This isn't a "too much effort" excuse — it's that hand-authored completeness here is fake completeness.

## The actual fix: pull `pf2ools-data` at runtime, same pattern as your D&D5e fetch

`pf2ools-data` (https://github.com/Pf2ools/pf2ools-data) is a community-maintained, MIT/Paizo-Community-Use-Policy-licensed repo that mirrors **all** official Pathfinder 2e content as JSON, one file per spell/feat/monster/etc., regenerated from the actual rulebooks. It ships two consumption-friendly layers:

- `data/core/<source>/<datatype>/` — one JSON file per item, organized by sourcebook
- `bundles/` — the same data pre-merged into fewer, larger files for easy fetching
- `indexes/` — lookup indexes if you want to search without downloading everything

There's no query API — you fetch files over plain HTTPS via GitHub's raw content host or the contents API. That fits your existing `remote.py` cache-and-degrade-gracefully pattern exactly.

### Concrete fetch pattern for `pf2etools.py`

```python
import requests

GITHUB_API = "https://api.github.com/repos/Pf2ools/pf2ools-data"
RAW_BASE = "https://raw.githubusercontent.com/Pf2ools/pf2ools-data/master"

def list_bundle_files():
    """Discover what's available without guessing filenames."""
    resp = requests.get(f"{GITHUB_API}/contents/bundles", timeout=10)
    resp.raise_for_status()
    return [f["name"] for f in resp.json() if f["name"].endswith(".json")]

def fetch_bundle(filename: str) -> dict:
    resp = requests.get(f"{RAW_BASE}/bundles/{filename}", timeout=15)
    resp.raise_for_status()
    return resp.json()

def pf2e():
    """Mirror the shape your fiveetools.five_e() already returns."""
    bundles = list_bundle_files()
    spells = next((b for b in bundles if "spell" in b.lower()), None)
    feats = next((b for b in bundles if "feat" in b.lower()), None)
    bestiary = next((b for b in bundles if "bestiary" in b.lower() or "creature" in b.lower()), None)

    return {
        "classes": [],  # already covered by pf2e_ancestries_classes.json locally
        "races": [],    # ditto (ancestries)
        "spells": fetch_bundle(spells) if spells else [],
        "feats": fetch_bundle(feats) if feats else [],
        "monsters": fetch_bundle(bestiary) if bestiary else [],
    }
```

Wrap each `fetch_bundle` / `list_bundle_files` call in your existing `cached_remote` 6-hour cache, exactly like `fiveetools.py` already does for `dnd5eapi.co` — same degrade-gracefully-offline behavior, no new architecture needed.

**One caveat to check before you rely on it:** the exact bundle filenames (`Spells.json` vs `spells.json` vs split-by-source files) can only be confirmed by actually calling `list_bundle_files()` against the live repo — GitHub directory listings shift over time, so don't hardcode a guessed filename; discover it at runtime as shown above.

### Licensing note
Content Paizo published is included in `pf2ools-data` under Paizo's Community Use Policy; homebrew/third-party content is under its own listed license per source. Both are meant for exactly this kind of reuse — no different from how `dnd5eapi.co` republishes the 5e SRD under the OGL.

## What I'd do next
1. Drop these 4 JSON files into your `games/` (or wherever local profiles live) so Pathfinder 2e shows up in the dropdown immediately with a complete rules chassis.
2. Rewrite `pf2etools.py` using the fetch pattern above instead of whatever it currently points to.
3. Leave `class_feats`, `skill_feats`, `general_feats`, `spells`, and `monsters` as remote-fetched fields merged in at request time — never hand-maintained.

Want me to go ahead and write the full `pf2etools.py` replacement now, and wire `pathfinder2e` into `char_creator.py`'s game registry the same way D&D5e is wired in?
