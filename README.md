# Tabletop RGP Hosting

API-based tabletop AI DM hosting.
Step 1 done: **Char Creator** — a BG3-style single-page character creator
with a live, click-through rules knowledge base.

## TODOs
### Finish char creator // feature char_creation
The char creator needs the following:
- API coverage over skills, buffs, skills and so on so that the players see what they are building
- Skill/Ability points need to be handled correctly so that you can only allocate the max amount of the provided skill points and also along their logic (some have maybe multiple points for higher Skill levels like above skill lvl 5 it costs 2)
- subclasses and -races
- full description of skills

### Add extra UI with APIs for characters // feature player_char_sheet
That is the UI in which the player:
- make it so that players have all the spells listed and not free word fields with a cast button

### Narrator  // feature dm_interaction
Provide a plattform for AI-based and person-based DMs. Should have access to:
- API calls to talk to all players and individual player UIs
- Make API calls to add/remove provide/delete items, buffs, skills, xp,...
- Try to find a way to reload the AI often/reduce prompt length to reduce costs of running via API
- Make it so that the narrotor fills specific files to keep it up to date and not loose important "stray sentences" in the huge prompts (no idea how)
### NPC
Provide an AI agent for NPCs. One AI agent is sufficent as long as all information stay saved in a json/csv/idc. Must interact with the narrator due to thoughts the npc has an the players havent seen/heard yet, but can if they can read minds for examples or personality/idiology/agengas,...


## Architecture

```
Tabletop RGP Hosting/
├── char_creator.py      # Flask app: REST API (port 5000)
├── remote.py            # shared cached_remote() — 6 h cache, offline-safe
├── fiveetools.py        # live 5e SRD layer (skills/races/classes/…)
├── webui.html           # the single-page UI (markup + theme)
├── webui.js             # the UI's client logic (API-driven, no hardcoding)
├── campaigns.json       # campaign registry (narrated drop-ins + AI records)
├── games/               # local game-system profiles (one JSON each)
│   ├── dnd5e.json          ← tldr + ruleset/wiki links + ability config
│   ├── pathfinder2e.json
│   ├── baldurs_gate.json
│   ├── cyberpunk2020.json
│   └── custom.json
├── char_sheets/         # one JSON per character (created at runtime)
├── ai.py                # LLM facade (future AI DM — not wired yet)
├── narrator.py / npc.py # stubs for the AI DM (coming next)
└── .cache/              # cached remote API responses (created at runtime)
```

### Design principle

Nothing is hardcoded — every piece of info the UI shows comes from an API
or a data file, so new systems/campaigns/rules appear without code changes:

- **System profiles** (`games/*.json`) carry a `tldr` (one-paragraph flavor),
  `links` (ruleset / wiki / data-API URLs) and the ability-score config.
- **Live rules** come from [5etools.co](https://api.5etools.co) (the free 5e
  SRD API, no key) via `fiveetools.py` — skills with descriptions, race
  traits, class features *level by level*, backgrounds, 200+ spells,
  conditions, damage types, and full adventure data. Cached 6 h, degrades
  gracefully offline (sections hide instead of erroring).
- **Prep-free campaigns** live in `campaigns.json` with a `world_notes`
  field the DM (or AI) can run straight from — setup, tone, NPCs, acts.

**Games** come from two sources, merged in `/api/games`:
- **Local profiles** in `games/*.json` — fully editable; add a new file
  (e.g. `games/spirit.json`) and it appears in the dropdown automatically.
- **Remote systems** from the free [Dungeon Masters API](https://api.dms.gg/)
  (`GET /systems`) — D&D, Pathfinder, Cyberpunk and ~60 more, no API key.
  Cached in `.cache/` for 6 h; degrades gracefully offline
  (`?remote=false` forces local-only).

**Campaigns** come from three sources, merged in `/api/campaigns`:
1. **✨ AI-generated** — first entry; fresh campaign invented by the AI
   narrator (seeded via the UI), persisted into `campaigns.json`.
2. **Local** — authored in `campaigns.json` (or via `POST /api/campaigns`).
3. **5etools adventures** — the big D&D 5e adventure database
   (`https://www.5etools.com/api/adventures`), no API key, cached 6 h.

All lists (races/classes/backgrounds/abilities) are *suggestions only* —
every field in the UI is free entry, so any system can be played.

## Run

```bash
pip install -r requirements.txt
python3 char_creator.py
# → http://127.0.0.1:5000
```

## REST API

| Method & path | Purpose |
|---|---|
| `GET /api/games` | All game systems (local `games/*.json` + dms.gg remote) |
| `GET /api/games/<id>` | One game profile (tldr, links, field labels, suggestions, ability config) |
| `GET /api/rules/<system>` | Live rules knowledge base (5e: skills, races, classes+features, backgrounds, spells, conditions, damage) — empty lists when offline |
| `GET /api/adventure/<id>` | Full 5etools adventure (chapters, NPCs, maps, items) |
| `GET /api/campaigns?system=<id>` | Merged list: AI option ⊕ local ⊕ 5etools |
| `POST /api/campaigns` | Author a new local campaign |
| `GET /api/characters` | List characters (metadata only — never leaks hidden data) |
| `GET /api/characters/<id>` | Full sheet (includes `hidden`) |
| `GET /api/characters/<id>?view=public` | **Group view** — `hidden` removed |
| `POST /api/characters` | Create (body: `system`, optional `campaign`, any sheet fields) |
| `PUT /api/characters/<id>` | Update (partial deep-merge) |
| `DELETE /api/characters/<id>` | Delete |
| `POST /api/characters/<id>/toggle-hidden` | Toggle `visibility.hidden_revealed` |

`?remote=false` on any API call forces offline/local data. The rules and
adventure endpoints come straight from 5etools.co (free, no key) and cache
for 6 h — so on a machine with internet the UI populates and caches; offline
the sections degrade to empty (never error).

### Game profile format (`games/<id>.json`)

```json
{
  "id": "mygame",
  "label": "My Game",
  "tldr": "One-paragraph flavor blurb shown in the System panel.",
  "links": {
    "rules":   ["https://…SRD.pdf", "https://…compendium"],
    "wiki":    "https://…wiki",
    "data_api": "optional — where live rules data comes from"
  },
  "genre": "cyberpunk",
  "fields": {
    "race":      { "label": "Species",  "suggestions": ["Human", "Custom..."] },
    "class":     { "label": "Vocation", "suggestions": ["Drone Wrangler"] },
    "alignment": { "label": "Morality", "suggestions": ["Lawful"] }
  },
  "backgrounds": { "label": "Background", "suggestions": ["Custom..."] },
  "abilities": {
    "enabled": true,
    "scores": ["body", "cool"],
    "min": 1, "max": 10, "default": 4,
    "points_buy": { "total": 27, "lo": 8, "hi": 15 }
  }
}
```

`tldr` + `links` feed the "System" panel (flavor + ruleset/wiki links — no
googling). `abilities.enabled: false` (or empty `scores`) hides the ability
step entirely — the sheet then relies on free-form `details.custom` fields.
For D&D 5e, the six standard scores auto-show modifiers and a points-buy
readout.

## Character sheet JSON

One file per character in `char_sheets/char_sheet_<id>.json`:

| Block | Contents | Visible to |
|---|---|---|
| `identity` | name, race, class, level, appearance, player_name | everyone |
| `abilities` | per-system scores (+ `modifiers` only for the standard six) | everyone |
| `background` | seed, summary, full backstory | everyone |
| `details` | personality, goals, flaws, traits, alignment, skills, equipment, spells, `custom` free-form | everyone |
| `campaign` | `{id, title, ai_generated, seed}` — link into `campaigns.json` | everyone |
| `public` | known_identity, known_backstory, known_relationships, known_items, rumors | **the group** |
| `hidden` | `hidden_agendas[]`, `secrets[]` (each with `revealed` flag), `dm_notes` | **DM only** |
| `visibility.hidden_revealed` | has the DM revealed the hidden info? | bookkeeping |

### Example: create via curl

```bash
curl -X POST http://127.0.0.1:5000/api/characters \
  -H 'Content-Type: application/json' \
  -d '{
    "system": "cyberpunk2020",
    "campaign": {"id": "ai-generated", "title": "The Memory Bazaar",
                 "tone": "neon noir",
                 "seed": "a rain-soaked colony world where memories can be traded"},
    "identity": {"name": "Kira Voss", "race": "Amerikkan", "class": "Netrunner"},
    "abilities": {"body": 4, "cool": 7, "logic": 8},
    "public": {"known_identity": "A netrunner with a price on her head"},
    "hidden": {"secrets": [{"title": "Cop tag", "description": "A cop traced her netrun", "revealed": false}]}
  }'
```

## Handoff to the AI DM (next: `narrator.py`)

The narrator consumes:
- `GET /api/characters/<id>?view=public` → what the group *already knows*
- `identity` + `details` → how the PC should *behave*
- `campaign` + the matching `campaigns.json` entry → world context & `world_notes`
- `hidden` → DM-only hooks, revealed only when per-item `revealed: true`
  or `visibility.hidden_revealed` flips (partial reveals supported).

## Known limitations / next up

- [ ] `narrator.py` — AI DM session loop over the JSON sheets
- [ ] `npc.py` — NPC generation from `public` world rules
- [ ] Non-5e systems get no live rules knowledge base yet (only `tldr` +
      `links`). Add a per-system data source by registering it in
      `fiveetools.py` (one fetch + normalizer per kind) and routing it in
      `char_creator.py → rules_payload()`.
- [ ] Multi-user auth (who may see `hidden`), production server (gunicorn)
- Remote APIs (dms.gg, 5etools) need internet; the creator works fully
  offline meanwhile — rules/remote sections degrade to empty.
