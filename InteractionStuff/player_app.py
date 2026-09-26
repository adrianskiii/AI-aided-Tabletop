"""
player_app.py — the PLAYER platform. Brand-new app, port 5001.

Scope, deliberately:
  - A player sees the FULL sheet — abilities, hp, stats, resources, buffs/
    conditions, inventory — only for the character they're playing as.
  - A player can act *with* other characters and NPCs (mainly: propose an
    item swap), but never sees the other side's sheet. Trades are typed
    requests ("I'll give you a Rope, for a Torch"), not an x-ray of their
    inventory.
  - A player can spend their OWN resources (cast a spell, use a charge),
    consume their OWN items, and log their OWN actions (attack, pick a
    pocket, ask an NPC to trade, whatever) — that's the character acting
    in the world. Granting XP/items/buffs out of nowhere is the DM's job:
    that's dm_app.py (port 5002), a separate platform on purpose.

Does not import or modify char_creator.py or dm_app.py. Reads/writes the
same char_sheets/*.json via sheets.py, and trades.json via trades.py.

REST API
--------
GET    /api/roster                               everyone (id, name, class/race, level, npc flag) — no stats, no inventory
GET    /api/me/<id>                               full own sheet (identity, abilities, background, details, state, inventory) — 'hidden' block is never included
GET    /api/me/<id>/messages                      DM whispers / level-up notices addressed to this character
POST   /api/me/<id>/messages/<msg_id>/read         mark a message read

POST   /api/me/<id>/resources/<key>/use            spend your own resource pool, e.g. a spell slot
POST   /api/me/<id>/spells/cast                    {"name": "...", "slot_level": 1}  convenience wrapper
POST   /api/me/<id>/inventory/<int:index>/use       consume qty of your own item

POST   /api/me/<id>/actions                        {"type": "...", "description": "...", "target_id": "<optional other char/npc>"}
GET    /api/me/<id>/actions                        your own action log

POST   /api/trades                                  propose a swap: {"from_id","to_id","offer":[{"name","qty"}],"request":[{"name","qty"}],"note"}
GET    /api/trades?character=<id>&status=pending    inbox/outbox for a character (status optional)
POST   /api/trades/<trade_id>/accept                {"by": "<to_id>"} — executes the swap
POST   /api/trades/<trade_id>/decline               {"by": "<to_id>"}
POST   /api/trades/<trade_id>/cancel                {"by": "<from_id>"} — only while still pending

GET    /health
"""

from flask import Flask, jsonify, request, send_from_directory

from sheets import (
    BASE_DIR,
    load_sheet,
    save_sheet,
    list_sheet_ids,
    log_action,
    take_items,
    give_items,
    is_npc,
    new_message,
    _now,
)
import trades as trade_store

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


def _fmt_items(items: list) -> str:
    return ", ".join(f"{i.get('qty', 1)}x {i.get('name', '?')}" for i in items) or "nothing"


# --------------------------------------------------------------------------- #
# Roster — the least amount of info needed to pick who to act with           #
# --------------------------------------------------------------------------- #

@app.get("/api/roster")
def api_roster():
    out = []
    for sheet_id in list_sheet_ids():
        sheet = load_sheet(sheet_id)
        if sheet is None:
            continue
        identity = sheet.get("identity", {})
        out.append({
            "id": sheet.get("id"),
            "name": identity.get("name", ""),
            "race": identity.get("race", ""),
            "class": identity.get("class", ""),
            "level": identity.get("level", 1),
            "system_label": sheet.get("system_label", ""),
            "npc": is_npc(sheet),
        })
    return jsonify(out)


# --------------------------------------------------------------------------- #
# "Me" — full detail, own character only                                     #
# --------------------------------------------------------------------------- #

@app.get("/api/me/<sheet_id>")
def api_me(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    view = {k: v for k, v in sheet.items() if k != "hidden"}  # never leak DM-only block
    return jsonify(view)


@app.get("/api/me/<sheet_id>/messages")
def api_my_messages(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    return jsonify(sheet.get("hidden", {}).get("messages", []))


@app.post("/api/me/<sheet_id>/messages/<msg_id>/read")
def api_mark_read(sheet_id: str, msg_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    messages = sheet.get("hidden", {}).get("messages", [])
    msg = next((m for m in messages if m.get("id") == msg_id), None)
    if msg is None:
        return _bad("no such message", 404)
    msg["read"] = True
    save_sheet(sheet)
    return jsonify(msg)


# --------------------------------------------------------------------------- #
# Spending your own resources / items                                        #
# --------------------------------------------------------------------------- #

@app.post("/api/me/<sheet_id>/resources/<key>/use")
def api_use_resource(sheet_id: str, key: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    amount = _num(payload.get("amount", 1), 1)

    pool = sheet["state"]["resources"].get(key)
    if pool is None:
        return _bad(f"no such resource '{key}'", 404)
    if pool["current"] < amount:
        return _bad(f"not enough '{key}' ({pool['current']} available)", 409)

    pool["current"] -= amount
    log_action(sheet, "resource_use", f"Used {amount} x {pool.get('label', key)}", key=key)
    save_sheet(sheet)
    return jsonify(pool)


@app.post("/api/me/<sheet_id>/spells/cast")
def api_cast_spell(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name:
        return _bad("spell 'name' required")

    slot_level = payload.get("slot_level")
    if slot_level in (None, "", 0):
        log_action(sheet, "spell_cast", f"Cast {name} (no slot used)")
        save_sheet(sheet)
        return jsonify({"name": name, "slot_level": None, "slot_used": None})

    key = f"spell_slots_{int(slot_level)}"
    pool = sheet["state"]["resources"].get(key)
    if pool is None:
        return _bad(f"no '{key}' resource on this character yet (ask your DM to grant it)", 404)
    if pool["current"] < 1:
        return _bad(f"no {key} remaining", 409)

    pool["current"] -= 1
    log_action(sheet, "spell_cast", f"Cast {name} using a level {slot_level} slot", slot_level=slot_level)
    save_sheet(sheet)
    return jsonify({"name": name, "slot_level": slot_level, "slot_used": key, "remaining": pool["current"]})


@app.post("/api/me/<sheet_id>/inventory/<int:index>/use")
def api_use_item(sheet_id: str, index: int):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    inventory = sheet.setdefault("inventory", [])
    if not (0 <= index < len(inventory)):
        return _bad("bad inventory index", 404)

    payload = request.get_json(silent=True) or {}
    amount = _num(payload.get("amount", 1), 1)

    item = inventory[index]
    qty = _num(item.get("qty", 1), 1) - amount
    if qty > 0:
        item["qty"] = qty
        removed = False
    else:
        inventory.pop(index)
        removed = True

    log_action(sheet, "item_used", f"Used {amount} x {item.get('name', 'item')}")
    save_sheet(sheet)
    return jsonify({"item": item.get("name"), "remaining_qty": max(qty, 0), "removed": removed})


# --------------------------------------------------------------------------- #
# Actions — attack, pick a pocket, ask an NPC to trade, whatever             #
# --------------------------------------------------------------------------- #

@app.get("/api/me/<sheet_id>/actions")
def api_list_actions(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    limit = _num(request.args.get("limit", 50), 50)
    log = sheet["state"]["action_log"]
    return jsonify(log[-limit:] if limit > 0 else log)


@app.post("/api/me/<sheet_id>/actions")
def api_add_action(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    entry_type = str(payload.get("type", "action")).strip() or "action"
    description = str(payload.get("description", "")).strip()
    if not description:
        return _bad("description required")

    extra = {}
    target_id = payload.get("target_id")
    if target_id:
        target = load_sheet(target_id)
        if target:
            extra["target_id"] = target_id
            extra["target_name"] = target.get("identity", {}).get("name", target_id)

    entry = log_action(sheet, entry_type, description, **extra)
    save_sheet(sheet)
    return jsonify(entry), 201


# --------------------------------------------------------------------------- #
# Trading                                                                      #
# --------------------------------------------------------------------------- #

@app.post("/api/trades")
def api_propose_trade():
    payload = request.get_json(silent=True) or {}
    from_id = payload.get("from_id")
    to_id = payload.get("to_id")
    offer = payload.get("offer") or []
    req = payload.get("request") or []

    from_sheet = load_sheet(from_id) if from_id else None
    to_sheet = load_sheet(to_id) if to_id else None
    if from_sheet is None or to_sheet is None:
        return _bad("from_id and to_id must both be existing characters", 404)
    if not offer and not req:
        return _bad("offer and/or request must not both be empty")

    # Validate the offering side actually has what they're proposing to give.
    try:
        take_items(from_sheet.get("inventory", []), offer)
    except ValueError as e:
        return _bad(str(e), 409)

    trade = trade_store.new_trade(
        from_id=from_id,
        from_name=from_sheet.get("identity", {}).get("name", from_id),
        to_id=to_id,
        to_name=to_sheet.get("identity", {}).get("name", to_id),
        offer=offer,
        request=req,
        note=payload.get("note", ""),
    )

    to_sheet.setdefault("hidden", {}).setdefault("messages", []).append(
        new_message(
            f"{trade['from_name']} proposes a trade: offering "
            f"{_fmt_items(offer)} for {_fmt_items(req)}.",
            from_name=trade["from_name"],
            kind="trade_offer",
        )
    )
    save_sheet(to_sheet)

    return jsonify(trade), 201


@app.get("/api/trades")
def api_list_trades():
    character = request.args.get("character")
    status = request.args.get("status")
    all_trades = trade_store.load_trades()
    if character:
        all_trades = [t for t in all_trades if t["from_id"] == character or t["to_id"] == character]
    if status:
        all_trades = [t for t in all_trades if t["status"] == status]
    all_trades.sort(key=lambda t: t["created_at"], reverse=True)
    return jsonify(all_trades)


@app.post("/api/trades/<trade_id>/accept")
def api_accept_trade(trade_id: str):
    trade = trade_store.find_trade(trade_id)
    if trade is None:
        return _bad("no such trade", 404)
    if trade["status"] != "pending":
        return _bad(f"trade already {trade['status']}", 409)

    by = (request.get_json(silent=True) or {}).get("by")
    if by != trade["to_id"]:
        return _bad("only the recipient can accept this trade", 403)

    from_sheet = load_sheet(trade["from_id"])
    to_sheet = load_sheet(trade["to_id"])
    if from_sheet is None or to_sheet is None:
        return _bad("a party to this trade no longer exists", 404)

    try:
        from_inv = take_items(from_sheet.get("inventory", []), trade["offer"])
        to_inv = take_items(to_sheet.get("inventory", []), trade["request"])
    except ValueError as e:
        return _bad(f"trade can no longer be completed: {e}", 409)

    from_sheet["inventory"] = give_items(from_inv, trade["request"])
    to_sheet["inventory"] = give_items(to_inv, trade["offer"])

    log_action(from_sheet, "trade", f"Traded with {trade['to_name']}: gave {_fmt_items(trade['offer'])}, got {_fmt_items(trade['request'])}")
    log_action(to_sheet, "trade", f"Traded with {trade['from_name']}: gave {_fmt_items(trade['request'])}, got {_fmt_items(trade['offer'])}")

    save_sheet(from_sheet)
    save_sheet(to_sheet)
    trade = trade_store.update_trade(trade_id, status="accepted", resolved_at=_now())
    return jsonify(trade)


@app.post("/api/trades/<trade_id>/decline")
def api_decline_trade(trade_id: str):
    trade = trade_store.find_trade(trade_id)
    if trade is None:
        return _bad("no such trade", 404)
    if trade["status"] != "pending":
        return _bad(f"trade already {trade['status']}", 409)

    by = (request.get_json(silent=True) or {}).get("by")
    if by != trade["to_id"]:
        return _bad("only the recipient can decline this trade", 403)

    trade = trade_store.update_trade(trade_id, status="declined", resolved_at=_now())
    return jsonify(trade)


@app.post("/api/trades/<trade_id>/cancel")
def api_cancel_trade(trade_id: str):
    trade = trade_store.find_trade(trade_id)
    if trade is None:
        return _bad("no such trade", 404)
    if trade["status"] != "pending":
        return _bad(f"trade already {trade['status']}", 409)

    by = (request.get_json(silent=True) or {}).get("by")
    if by != trade["from_id"]:
        return _bad("only the sender can cancel this trade", 403)

    trade = trade_store.update_trade(trade_id, status="cancelled", resolved_at=_now())
    return jsonify(trade)


# --------------------------------------------------------------------------- #
# Web UI + health                                                             #
# --------------------------------------------------------------------------- #

@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "player.html")


@app.get("/player.js")
def player_js():
    return send_from_directory(BASE_DIR, "player.js")


@app.get("/health")
def health():
    return jsonify({"status": "ok", "characters": list_sheet_ids()})


if __name__ == "__main__":
    print("Player app running at http://127.0.0.1:5001")
    app.run(host="127.0.0.1", port=5001, debug=True)
