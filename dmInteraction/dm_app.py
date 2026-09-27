"""
dm_app.py — the DM platform. Brand-new app, port 5002.

Everything the player app deliberately withholds lives here: full visibility
into every character (players AND NPCs), and the power to grant or take away
XP, items, buffs/conditions, resources (spell slots, rages, ...), HP, and
free-form stats on ANY character. Also: create bare NPC sheets, whisper a
private message to a player, oversee (or force-cancel) trades, unlock level
ups, run the per-round action economy, and — the important one — approve or
deny the requests players file for anything that would spend a resource or
an item. Approval is the only place those deductions actually happen; a
player has no endpoint that mutates their own hp/resources/buffs/xp/
inventory directly.

Does not import or modify char_creator.py or player_app.py. Reads/writes
the same char_sheets/*.json via sheets.py, trades.json via trades.py,
requests.json via requests_store.py, and dm_inbox.json via dm_inbox.py.

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
POST   /api/characters/<id>/level-up/unlock         lets that player apply their next level up

GET    /api/characters/<id>/action-economy
POST   /api/characters/<id>/action-economy          upsert a pool {"key","max","current","label"}
DELETE /api/characters/<id>/action-economy/<key>
POST   /api/characters/<id>/action-economy/reset     refill one character's pools
POST   /api/action-economy/reset-all                 "new round" — refill everyone's pools

GET    /api/requests?status=pending                every player-filed action request
POST   /api/requests/<id>/approve                    {"note"?} — validates + deducts the declared cost, notifies the player
POST   /api/requests/<id>/deny                       {"reason"?} — nothing is deducted, notifies the player

GET    /api/dm/inbox                                messages FROM players TO the DM
POST   /api/dm/inbox/<id>/read

GET    /api/activity?limit=50                     merged, time-sorted action log across every character
GET    /api/trades                                 every trade, any status (oversight)
POST   /api/trades/<trade_id>/cancel               DM can force-cancel a pending trade

GET    /health
"""
import sys
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory
sys.path.append(str(Path(__file__).resolve().parent.parent / "utility"))

from sheets import (

    load_sheet,
    save_sheet,
    list_sheet_ids,
    log_action,
    new_message,
    is_npc,
    take_items,
    reset_action_economy,
    _now,
)
import trades as trade_store
import dm_inbox
import requests_store
import uuid

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent

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
# Level up — the DM unlocks it, the player applies it in their own app       #
# --------------------------------------------------------------------------- #

@app.post("/api/characters/<sheet_id>/level-up/unlock")
def api_unlock_level_up(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    sheet["state"]["level_up_available"] = True
    name = sheet.get("identity", {}).get("name", sheet_id)
    msg = new_message(
        f"You can level up now! Head to the Progression tab.",
        from_name="DM", kind="level_up",
    )
    sheet.setdefault("hidden", {}).setdefault("messages", []).append(msg)
    log_action(sheet, "level_up_unlocked", "DM unlocked a level up")
    save_sheet(sheet)
    return jsonify({"level_up_available": True})


# --------------------------------------------------------------------------- #
# Action economy — per-turn action/bonus-action/reaction (5e), 3-actions     #
# (PF2e), etc. The DM can add/rename pools and reset them for a new round.   #
# --------------------------------------------------------------------------- #

@app.get("/api/characters/<sheet_id>/action-economy")
def api_get_action_economy(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    return jsonify(sheet["state"]["action_economy"])


@app.post("/api/characters/<sheet_id>/action-economy")
def api_upsert_action_pool(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    key = str(payload.get("key", "")).strip()
    if not key:
        return _bad("key required")

    econ = sheet["state"]["action_economy"]
    existing = econ.get(key, {})
    max_val = _num(payload.get("max", existing.get("max", 1)), 1)
    current = payload.get("current", max_val)

    econ[key] = {
        "current": _num(current, max_val),
        "max": max_val,
        "label": payload.get("label", existing.get("label", key)),
    }
    save_sheet(sheet)
    return jsonify(econ[key]), 201


@app.delete("/api/characters/<sheet_id>/action-economy/<key>")
def api_delete_action_pool(sheet_id: str, key: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    removed = sheet["state"]["action_economy"].pop(key, None)
    if removed is None:
        return _bad("no such action pool", 404)
    save_sheet(sheet)
    return jsonify({"removed": key})


@app.post("/api/characters/<sheet_id>/action-economy/reset")
def api_reset_action_economy(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    key = (request.get_json(silent=True) or {}).get("key")
    econ = reset_action_economy(sheet, key)
    save_sheet(sheet)
    return jsonify(econ)


@app.post("/api/action-economy/reset-all")
def api_reset_all_action_economy():
    """'New round' — refresh every character's action pools at once."""
    updated = []
    for sheet_id in list_sheet_ids():
        sheet = load_sheet(sheet_id)
        if sheet is None:
            continue
        reset_action_economy(sheet)
        save_sheet(sheet)
        updated.append(sheet_id)
    return jsonify({"reset": updated})


# --------------------------------------------------------------------------- #
# Pending action requests — the only place a resource/item ever actually    #
# gets spent for a player-initiated action. Approve deducts (re-validated   #
# against the sheet as it stands right now) and logs it; deny changes       #
# nothing. Either way the player is notified via a message.                 #
# --------------------------------------------------------------------------- #

def _apply_costs(sheet: dict, costs: list) -> None:
    """Validate then apply every declared cost, atomically. Raises
    ValueError (nothing mutated) if anything can no longer be afforded —
    pools may have changed since the request was filed."""
    resources = sheet["state"]["resources"]
    inventory = sheet.get("inventory", [])

    # validate everything first
    for c in costs:
        if c.get("kind") == "resource":
            pool = resources.get(c.get("key"))
            if pool is None:
                raise ValueError(f"no such resource '{c.get('key')}' anymore")
            if pool["current"] < _num(c.get("amount", 1), 1):
                raise ValueError(f"not enough '{c.get('key')}' left ({pool['current']} available)")

    item_costs = [{"name": c.get("name"), "qty": c.get("qty", 1)} for c in costs if c.get("kind") == "item"]
    if item_costs:
        inventory = take_items(inventory, item_costs)  # raises ValueError if insufficient

    # everything checked out — apply it
    for c in costs:
        if c.get("kind") == "resource":
            resources[c.get("key")]["current"] -= _num(c.get("amount", 1), 1)
    sheet["inventory"] = inventory


def _fmt_costs(costs: list) -> str:
    parts = []
    for c in costs:
        if c.get("kind") == "resource":
            parts.append(f"{c.get('amount', 1)} x {c.get('label', c.get('key'))}")
        elif c.get("kind") == "item":
            parts.append(f"{c.get('qty', 1)} x {c.get('name')}")
    return ", ".join(parts) or "nothing"


@app.get("/api/requests")
def api_list_requests():
    status = request.args.get("status")
    items = requests_store.load_requests()
    if status:
        items = [r for r in items if r["status"] == status]
    items.sort(key=lambda r: r["created_at"], reverse=True)
    return jsonify(items)


@app.post("/api/requests/<request_id>/approve")
def api_approve_request(request_id: str):
    req = requests_store.find_request(request_id)
    if req is None:
        return _bad("no such request", 404)
    if req["status"] != "pending":
        return _bad(f"request already {req['status']}", 409)

    sheet = load_sheet(req["character_id"])
    if sheet is None:
        return _bad("that character no longer exists", 404)

    try:
        _apply_costs(sheet, req["costs"])
    except ValueError as e:
        return _bad(f"can't approve: {e}", 409)

    payload = request.get_json(silent=True) or {}
    note = str(payload.get("note", "")).strip()

    cost_str = _fmt_costs(req["costs"])
    log_action(sheet, req["type"], f"[Approved] {req['description']} (spent {cost_str})" if req["costs"] else f"[Approved] {req['description']}")
    msg = new_message(
        f"Approved: {req['description']}" + (f" — {note}" if note else ""),
        from_name="DM", kind="request_resolved",
    )
    sheet.setdefault("hidden", {}).setdefault("messages", []).append(msg)
    save_sheet(sheet)

    req = requests_store.update_request(request_id, status="approved", resolution_note=note, resolved_at=_now())
    return jsonify(req)


@app.post("/api/requests/<request_id>/deny")
def api_deny_request(request_id: str):
    req = requests_store.find_request(request_id)
    if req is None:
        return _bad("no such request", 404)
    if req["status"] != "pending":
        return _bad(f"request already {req['status']}", 409)

    payload = request.get_json(silent=True) or {}
    reason = str(payload.get("reason", "")).strip()

    sheet = load_sheet(req["character_id"])
    if sheet is not None:
        log_action(sheet, req["type"], f"[Denied] {req['description']}" + (f" — {reason}" if reason else ""))
        msg = new_message(
            f"Denied: {req['description']}" + (f" — {reason}" if reason else ""),
            from_name="DM", kind="request_resolved",
        )
        sheet.setdefault("hidden", {}).setdefault("messages", []).append(msg)
        save_sheet(sheet)

    req = requests_store.update_request(request_id, status="denied", resolution_note=reason, resolved_at=_now())
    return jsonify(req)


# --------------------------------------------------------------------------- #
# DM inbox — messages FROM players TO the DM                                 #
# --------------------------------------------------------------------------- #

@app.get("/api/dm/inbox")
def api_dm_inbox():
    items = dm_inbox.load_inbox()
    items.sort(key=lambda m: m["created_at"], reverse=True)
    return jsonify(items)


@app.post("/api/dm/inbox/<msg_id>/read")
def api_dm_inbox_read(msg_id: str):
    msg = dm_inbox.mark_read(msg_id)
    if msg is None:
        return _bad("no such message", 404)
    return jsonify(msg)


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