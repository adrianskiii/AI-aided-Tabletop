"""
dm_app.py — the DM platform. Brand-new app, port 5002.

Everything the player app deliberately withholds lives here: full visibility
into every character (players AND NPCs), and the power to grant or take away
XP, items, buffs/conditions, resources (spell slots, rages, ...), HP, and
free-form stats on ANY character. Also: create bare NPC sheets, whisper a
private message to a player, and oversee (or force-cancel) trades.

Does not import or modify char_creator.py or player_app.py. Reads/writes
the same char_sheets/*.json via sheets.py, and trades.json via trades.py.

REST API
--------
GET    /api/characters                          every character, full sheet (players + NPCs)
GET    /api/characters/<id>                      one full sheet
POST   /api/npcs                                 {"name": "...", "system": "dnd5e", ...} — create a bare NPC sheet

POST   /api/characters/<id>/hp                   {"delta"|"set"|"max"|"temp"}
POST   /api/characters/<id>/stats                {"key","value"} or {"key","delta"}

GET    /api/characters/<id>/resources
POST   /api/characters/<id>/resources             upsert a pool {"key","max","current","label"}
DELETE /api/characters/<id>/resources/<key>
POST   /api/characters/<id>/resources/<key>/restore  {"amount"} or {"full": true}

GET    /api/characters/<id>/buffs
POST   /api/characters/<id>/buffs                 grant a buff/debuff/condition
DELETE /api/characters/<id>/buffs/<buff_id>

POST   /api/characters/<id>/inventory             {"name","qty","notes"} — grant an item
DELETE /api/characters/<id>/inventory/<int:index>  take an item away entirely

POST   /api/characters/<id>/xp                    {"amount"} — positive or negative
POST   /api/characters/<id>/messages               {"text","kind"} — private whisper to that player

GET    /api/activity?limit=50                     merged, time-sorted action log across every character
GET    /api/trades                                 every trade, any status (oversight)
POST   /api/trades/<trade_id>/cancel               DM can force-cancel a pending trade

GET    /health
"""

from flask import Flask, jsonify, request, send_from_directory

from sheets import (
    BASE_DIR,
    load_sheet,
    save_sheet,
    list_sheet_ids,
    log_action,
    new_message,
    is_npc,
    _now,
)
import trades as trade_store
import uuid

app = Flask(__name__)


def _not_found():
    return jsonify({"error": "character not found"}), 404


def _bad(msg: str, code: int = 400):
    return jsonify({"error": msg}), code


def _num(value, default=0):
    try:
        return type(default)(value)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Characters                                                                   #
# --------------------------------------------------------------------------- #

@app.get("/api/characters")
def api_list_characters():
    out = []
    for sheet_id in list_sheet_ids():
        sheet = load_sheet(sheet_id)
        if sheet is not None:
            out.append(sheet)
    return jsonify(out)


@app.get("/api/characters/<sheet_id>")
def api_get_character(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    return jsonify(sheet)


@app.post("/api/npcs")
def api_create_npc():
    """A bare, playable-by-the-DM sheet, flagged npc:true so the player
    app's roster shows it as an NPC. Fill in the rest by hand or via the
    same endpoints used for player characters — an NPC is just a sheet."""
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name:
        return _bad("name required")

    sheet_id = uuid.uuid4().hex[:12]
    sheet = {
        "id": sheet_id,
        "system": payload.get("system", "custom"),
        "system_label": payload.get("system_label", payload.get("system", "custom")),
        "npc": True,
        "created_at": _now(),
        "updated_at": _now(),
        "identity": {
            "name": name,
            "race": payload.get("race", ""),
            "class": payload.get("role", payload.get("class", "")),
            "level": payload.get("level", 1),
        },
        "abilities": payload.get("abilities", {}),
        "background": {"seed": "", "summary": payload.get("summary", ""), "details": ""},
        "details": {},
        "public": {},
        "hidden": {"hidden_agendas": [], "secrets": [], "dm_notes": payload.get("dm_notes", ""), "messages": []},
        "progression": {"xp": 0, "level": payload.get("level", 1)},
        "inventory": payload.get("inventory", []),
        "build": {},
    }
    save_sheet(sheet)
    return jsonify(sheet), 201


# --------------------------------------------------------------------------- #
# HP / stats                                                                   #
# --------------------------------------------------------------------------- #

@app.post("/api/characters/<sheet_id>/hp")
def api_hp(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    hp = sheet["state"]["hp"]

    if "max" in payload:
        hp["max"] = _num(payload["max"], hp.get("max") or 0)
        if hp.get("current") is None:
            hp["current"] = hp["max"]
    if "temp" in payload:
        hp["temp"] = max(0, _num(payload["temp"], 0))

    if "set" in payload:
        hp["current"] = _num(payload["set"], hp.get("current") or 0)
    elif "delta" in payload:
        delta = _num(payload["delta"], 0)
        current = hp.get("current") if hp.get("current") is not None else (hp.get("max") or 0)
        if delta < 0:
            absorb = min(hp.get("temp", 0), -delta)
            hp["temp"] = hp.get("temp", 0) - absorb
            delta += absorb
        current = current + delta
        if hp.get("max") is not None:
            current = min(current, hp["max"])
        hp["current"] = max(0, current)
        if delta < 0:
            log_action(sheet, "damage", f"DM dealt {-delta} damage")
        elif delta > 0:
            log_action(sheet, "heal", f"DM healed {delta}")

    save_sheet(sheet)
    return jsonify(hp)


@app.post("/api/characters/<sheet_id>/stats")
def api_stats(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    key = str(payload.get("key", "")).strip()
    if not key:
        return _bad("key required")

    stats = sheet["state"]["stats"]
    if "value" in payload:
        stats[key] = payload["value"]
    elif "delta" in payload:
        stats[key] = _num(stats.get(key, 0), 0) + _num(payload["delta"], 0)
    else:
        return _bad("provide 'value' or 'delta'")

    save_sheet(sheet)
    return jsonify(stats)


# --------------------------------------------------------------------------- #
# Resources                                                                     #
# --------------------------------------------------------------------------- #

@app.get("/api/characters/<sheet_id>/resources")
def api_list_resources(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    return jsonify(sheet["state"]["resources"])


@app.post("/api/characters/<sheet_id>/resources")
def api_upsert_resource(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    key = str(payload.get("key", "")).strip()
    if not key:
        return _bad("key required")

    resources = sheet["state"]["resources"]
    existing = resources.get(key, {})
    max_val = _num(payload.get("max", existing.get("max", 0)), 0)
    current = payload.get("current", existing.get("current", max_val))

    resources[key] = {
        "current": _num(current, max_val),
        "max": max_val,
        "label": payload.get("label", existing.get("label", key)),
    }
    save_sheet(sheet)
    return jsonify(resources[key]), 201


@app.delete("/api/characters/<sheet_id>/resources/<key>")
def api_delete_resource(sheet_id: str, key: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    removed = sheet["state"]["resources"].pop(key, None)
    if removed is None:
        return _bad("no such resource", 404)
    save_sheet(sheet)
    return jsonify({"removed": key})


@app.post("/api/characters/<sheet_id>/resources/<key>/restore")
def api_restore_resource(sheet_id: str, key: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    pool = sheet["state"]["resources"].get(key)
    if pool is None:
        return _bad(f"no such resource '{key}'", 404)

    if payload.get("full"):
        pool["current"] = pool["max"]
    else:
        pool["current"] = min(pool["max"], pool["current"] + _num(payload.get("amount", 1), 1))

    save_sheet(sheet)
    return jsonify(pool)


# --------------------------------------------------------------------------- #
# Buffs / conditions                                                           #
# --------------------------------------------------------------------------- #

@app.get("/api/characters/<sheet_id>/buffs")
def api_list_buffs(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    return jsonify(sheet["state"]["buffs"])


@app.post("/api/characters/<sheet_id>/buffs")
def api_add_buff(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name:
        return _bad("buff 'name' required")

    buff = {
        "id": uuid.uuid4().hex[:10],
        "name": name,
        "kind": payload.get("kind", "buff"),
        "description": payload.get("description", ""),
        "source": payload.get("source", "DM"),
        "duration_rounds": payload.get("duration_rounds"),
        "applied_at": _now(),
    }
    sheet["state"]["buffs"].append(buff)
    log_action(sheet, "buff_applied", f"DM applied {buff['kind']}: {name}", buff_id=buff["id"])
    save_sheet(sheet)
    return jsonify(buff), 201


@app.delete("/api/characters/<sheet_id>/buffs/<buff_id>")
def api_remove_buff(sheet_id: str, buff_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    buffs = sheet["state"]["buffs"]
    match = next((b for b in buffs if b["id"] == buff_id), None)
    if match is None:
        return _bad("no such buff", 404)

    buffs.remove(match)
    log_action(sheet, "buff_removed", f"DM removed: {match['name']}", buff_id=buff_id)
    save_sheet(sheet)
    return jsonify({"removed": match})


# --------------------------------------------------------------------------- #
# Inventory grants                                                             #
# --------------------------------------------------------------------------- #

@app.post("/api/characters/<sheet_id>/inventory")
def api_grant_item(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name:
        return _bad("item name required")
    qty = _num(payload.get("qty", 1), 1) or 1

    inventory = sheet.setdefault("inventory", [])
    existing = next((e for e in inventory if e.get("name", "").lower() == name.lower()), None)
    if existing:
        existing["qty"] = _num(existing.get("qty", 1), 1) + qty
        entry = existing
    else:
        entry = {"name": name, "qty": qty, "notes": payload.get("notes", "")}
        inventory.append(entry)

    log_action(sheet, "item_granted", f"DM granted {qty} x {name}")
    save_sheet(sheet)
    return jsonify(entry), 201


@app.delete("/api/characters/<sheet_id>/inventory/<int:index>")
def api_take_item(sheet_id: str, index: int):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    inventory = sheet.setdefault("inventory", [])
    if not (0 <= index < len(inventory)):
        return _bad("bad inventory index", 404)

    removed = inventory.pop(index)
    log_action(sheet, "item_removed", f"DM removed {removed.get('name')}")
    save_sheet(sheet)
    return jsonify({"removed": removed})


# --------------------------------------------------------------------------- #
# XP and whispers                                                              #
# --------------------------------------------------------------------------- #

@app.post("/api/characters/<sheet_id>/xp")
def api_xp(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    amount = _num(payload.get("amount", 0), 0)

    progression = sheet.setdefault("progression", {"xp": 0, "level": 1})
    progression["xp"] = _num(progression.get("xp", 0), 0) + amount
    log_action(sheet, "xp", f"DM {'granted' if amount >= 0 else 'removed'} {abs(amount)} XP")

    save_sheet(sheet)
    return jsonify(progression)


@app.post("/api/characters/<sheet_id>/messages")
def api_whisper(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    if not text:
        return _bad("text required")

    msg = new_message(text, from_name="DM", kind=payload.get("kind", "whisper"))
    sheet.setdefault("hidden", {}).setdefault("messages", []).append(msg)
    save_sheet(sheet)
    return jsonify(msg), 201


# --------------------------------------------------------------------------- #
# Activity feed — merged action logs across every character                   #
# --------------------------------------------------------------------------- #

@app.get("/api/activity")
def api_activity():
    limit = _num(request.args.get("limit", 50), 50)
    feed = []
    for sheet_id in list_sheet_ids():
        sheet = load_sheet(sheet_id)
        if sheet is None:
            continue
        name = sheet.get("identity", {}).get("name", sheet_id)
        for entry in sheet["state"]["action_log"]:
            feed.append({**entry, "character_id": sheet_id, "character_name": name})
    feed.sort(key=lambda e: e["at"], reverse=True)
    return jsonify(feed[:limit])


# --------------------------------------------------------------------------- #
# Trade oversight                                                              #
# --------------------------------------------------------------------------- #

@app.get("/api/trades")
def api_list_trades():
    status = request.args.get("status")
    all_trades = trade_store.load_trades()
    if status:
        all_trades = [t for t in all_trades if t["status"] == status]
    all_trades.sort(key=lambda t: t["created_at"], reverse=True)
    return jsonify(all_trades)


@app.post("/api/trades/<trade_id>/cancel")
def api_force_cancel_trade(trade_id: str):
    trade = trade_store.find_trade(trade_id)
    if trade is None:
        return _bad("no such trade", 404)
    if trade["status"] != "pending":
        return _bad(f"trade already {trade['status']}", 409)
    trade = trade_store.update_trade(trade_id, status="cancelled", resolved_at=_now())
    return jsonify(trade)


# --------------------------------------------------------------------------- #
# Web UI + health                                                             #
# --------------------------------------------------------------------------- #

@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "dm.html")


@app.get("/dm.js")
def dm_js():
    return send_from_directory(BASE_DIR, "dm.js")


@app.get("/health")
def health():
    return jsonify({"status": "ok", "characters": list_sheet_ids()})


if __name__ == "__main__":
    print("DM app running at http://127.0.0.1:5002")
    app.run(host="127.0.0.1", port=5002, debug=True)
