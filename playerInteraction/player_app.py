"""
player_app.py — the PLAYER platform. Brand-new app, port 5001.

Scope, deliberately:
  - A player sees the FULL sheet — abilities, hp, stats, resources, buffs/
    conditions, inventory — only for the character they're playing as.
  - A player can act *with* other characters and NPCs (mainly: propose an
    item swap), but never sees the other side's sheet. Trades are typed
    requests ("I'll give you a Rope, for a Torch"), not an x-ray of their
    inventory.
  - Free-form narration (attack, pick a pocket, ask an NPC to trade,
    whatever) logs instantly to the character's own action log — no gate,
    it's just flavor text the DM sees show up live.
  - Anything that would actually SPEND something (a spell slot, a resource
    pool, an inventory item) is NOT self-service. The player files a
    request (requests_store.py); nothing is deducted until the DM approves
    it from dm_app.py (port 5002). This is the anti-cheat boundary: a
    player has no endpoint anywhere that mutates their own hp, resources,
    buffs, xp, or inventory quantities directly — only the DM does, either
    by hand or by approving a request.

Does not import or modify char_creator.py or dm_app.py. Reads/writes the
same char_sheets/*.json via sheets.py, trades.json via trades.py, and
requests.json via requests_store.py.

REST API
--------
GET    /api/roster                               everyone (id, name, class/race, level, npc flag) — no stats, no inventory
GET    /api/me/<id>                               full own sheet incl. derived 'known' block — 'hidden' block is never included
GET    /api/me/<id>/messages                      DM whispers / player whispers / level-up notices addressed to this character
POST   /api/me/<id>/messages/<msg_id>/read         mark a message read
POST   /api/me/<id>/messages/to-dm                 {"text"} — private note to the DM
POST   /api/me/<id>/messages/whisper               {"to_id","text"} — private note to another player

POST   /api/me/<id>/requests                       {"type","description","costs":[...],"target_id"?} — file an action request; NOT applied until DM approves
GET    /api/me/<id>/requests                       your own request history + status
POST   /api/me/<id>/spells/cast                    {"name","slot_level"} — convenience wrapper around /requests
POST   /api/me/<id>/inventory/<int:index>/use       convenience wrapper around /requests (item-use cost)

GET    /api/me/<id>/action-economy                 your per-turn action/bonus-action/reaction (or PF2e 3-action) pools
POST   /api/me/<id>/action-economy/<key>/use        spend one of your own turn-actions (bookkeeping only, no persistent effect)
POST   /api/me/<id>/action-economy/reset            refill your own pools (end of turn)

POST   /api/me/<id>/actions                        {"type","description","target_id"?} — free narration, logs instantly, no cost/approval
GET    /api/me/<id>/actions                        your own action log

POST   /api/me/<id>/level-up                       apply a level up the DM has unlocked (mechanically inert beyond what's already baked into 'build')

POST   /api/trades                                  propose a swap: {"from_id","to_id","offer":[{"name","qty"}],"request":[{"name","qty"}],"note"}
GET    /api/trades?character=<id>&status=pending    inbox/outbox for a character (status optional)
POST   /api/trades/<trade_id>/accept                {"by": "<to_id>"} — executes the swap
POST   /api/trades/<trade_id>/decline               {"by": "<to_id>"}
POST   /api/trades/<trade_id>/cancel                {"by": "<from_id>"} — only while still pending

GET    /health
"""
import sys
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory
sys.path.append(str(Path(__file__).resolve().parent.parent / "utility"))
# dm_inbox.py and requests_store.py live in dmInteraction/, not utility/ —
# add that folder too so this app can import them without duplicating files.
sys.path.append(str(Path(__file__).resolve().parent.parent / "dmInteraction"))

import trades as trade_store
import dm_inbox
import requests_store
from sheets import (
    load_sheet,
    save_sheet,
    list_sheet_ids,
    log_action,
    take_items,
    give_items,
    is_npc,
    new_message,
    known_info,
    reset_action_economy,
    _now,
)

BASE_DIR = Path(__file__).resolve().parent
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
    view["known"] = known_info(sheet)  # class features/proficiencies/traits/spells unlocked so far
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
# Spending resources/items is NOT self-service. A player declares a request  #
# (what they want to do + what it would cost); nothing is deducted until the #
# DM approves it from the dashboard. See requests_store.py.                  #
# --------------------------------------------------------------------------- #

def _validate_costs(sheet: dict, costs: list) -> str | None:
    """Sanity-check that a request's declared costs are at least plausible
    against the CURRENT sheet (existing resource keys, items on hand in
    enough quantity). Returns an error string, or None if OK. This is just
    a friendly early check for the player — the DM's approval step
    re-validates for real at the point of actually spending it."""
    resources = sheet["state"]["resources"]
    inventory = sheet.get("inventory", [])
    for c in costs:
        kind = c.get("kind")
        if kind == "resource":
            key = c.get("key")
            pool = resources.get(key)
            if pool is None:
                return f"no such resource '{key}'"
            if pool["current"] < _num(c.get("amount", 1), 1):
                return f"not enough '{key}' ({pool['current']} available)"
        elif kind == "item":
            name = str(c.get("name", "")).strip().lower()
            qty = _num(c.get("qty", 1), 1)
            have = sum(_num(i.get("qty", 1), 1) for i in inventory if i.get("name", "").lower() == name)
            if have < qty:
                return f"not enough '{c.get('name')}' (have {have}, need {qty})"
        else:
            return f"unknown cost kind '{kind}'"
    return None


@app.get("/api/me/<sheet_id>/requests")
def api_list_own_requests(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    items = [r for r in requests_store.load_requests() if r["character_id"] == sheet_id]
    items.sort(key=lambda r: r["created_at"], reverse=True)
    return jsonify(items)


@app.post("/api/me/<sheet_id>/requests")
def api_create_request(sheet_id: str):
    """Declare an intended action, optionally with a cost. If there's no
    cost, this is really just flavor and you're better off using
    /actions — but it's harmless to route it through here too."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    description = str(payload.get("description", "")).strip()
    if not description:
        return _bad("description required")
    req_type = str(payload.get("type", "action")).strip() or "action"
    costs = payload.get("costs") or []
    if not isinstance(costs, list):
        return _bad("'costs' must be a list")

    err = _validate_costs(sheet, costs)
    if err:
        return _bad(err, 409)

    target_id = payload.get("target_id")
    target_name = None
    if target_id:
        target = load_sheet(target_id)
        if target is None:
            return _bad("no such target character", 404)
        target_name = target.get("identity", {}).get("name", target_id)

    name = sheet.get("identity", {}).get("name", sheet_id)
    req = requests_store.new_request(
        character_id=sheet_id,
        character_name=name,
        req_type=req_type,
        description=description,
        costs=costs,
        target_id=target_id,
        target_name=target_name,
    )
    return jsonify(req), 201


@app.get("/api/me/<sheet_id>/action-economy")
def api_get_action_economy(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    return jsonify(sheet["state"]["action_economy"])


@app.post("/api/me/<sheet_id>/action-economy/<key>/use")
def api_use_action(sheet_id: str, key: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    amount = _num(payload.get("amount", 1), 1)

    pool = sheet["state"]["action_economy"].get(key)
    if pool is None:
        return _bad(f"no such action pool '{key}'", 404)
    if pool["current"] < amount:
        return _bad(f"not enough '{key}' left ({pool['current']} available)", 409)

    pool["current"] -= amount
    log_action(sheet, "action_spent", f"Spent {amount} x {pool.get('label', key)}", key=key)
    save_sheet(sheet)
    return jsonify(pool)


@app.post("/api/me/<sheet_id>/action-economy/reset")
def api_reset_own_action_economy(sheet_id: str):
    """A player ending their own turn — refills their own action pools."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()
    key = (request.get_json(silent=True) or {}).get("key")
    econ = reset_action_economy(sheet, key)
    log_action(sheet, "turn_end", "Ended turn — actions refreshed")
    save_sheet(sheet)
    return jsonify(econ)


# --------------------------------------------------------------------------- #
# Progression — XP is DM-granted (dm_app.py); leveling up is unlocked by the #
# DM and then applied here, by the player, when they're ready.               #
# --------------------------------------------------------------------------- #

@app.post("/api/me/<sheet_id>/level-up")
def api_level_up(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    if not sheet["state"].get("level_up_available"):
        return _bad("the DM hasn't unlocked a level up for this character yet", 409)

    identity = sheet.setdefault("identity", {})
    progression = sheet.setdefault("progression", {"xp": 0, "level": 1})
    new_level = _num(identity.get("level", 1), 1) + 1
    identity["level"] = new_level
    progression["level"] = new_level

    sheet["state"]["level_up_available"] = False
    log_action(sheet, "level_up", f"Leveled up to {new_level}")
    save_sheet(sheet)
    return jsonify({
        "level": new_level,
        "known": known_info(sheet),
    })


# --------------------------------------------------------------------------- #
# Messaging — a private line to the DM, and player-to-player whispers.      #
# Neither is visible to anyone but the sender, the recipient, and the DM.   #
# --------------------------------------------------------------------------- #

@app.post("/api/me/<sheet_id>/messages/to-dm")
def api_message_dm(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    if not text:
        return _bad("text required")

    name = sheet.get("identity", {}).get("name", sheet_id)
    msg = dm_inbox.new_dm_message(from_id=sheet_id, from_name=name, text=text)
    return jsonify(msg), 201


@app.post("/api/me/<sheet_id>/messages/whisper")
def api_whisper_player(sheet_id: str):
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    to_id = payload.get("to_id")
    text = str(payload.get("text", "")).strip()
    if not to_id or not text:
        return _bad("'to_id' and 'text' required")
    if to_id == sheet_id:
        return _bad("can't whisper yourself")

    target = load_sheet(to_id)
    if target is None:
        return _bad("no such character", 404)

    name = sheet.get("identity", {}).get("name", sheet_id)
    msg = new_message(text, from_name=name, kind="player_whisper", to=to_id)
    target.setdefault("hidden", {}).setdefault("messages", []).append(msg)
    save_sheet(target)
    return jsonify(msg), 201


@app.post("/api/me/<sheet_id>/spells/cast")
def api_cast_spell(sheet_id: str):
    """Convenience wrapper: builds the right cost automatically and files a
    request, same as POST /requests would. The DM still has to approve it
    before the slot is actually spent."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name:
        return _bad("spell 'name' required")

    slot_level = payload.get("slot_level")
    costs = []
    description = f"Cast {name}"
    if slot_level not in (None, "", 0):
        key = f"spell_slots_{int(slot_level)}"
        pool = sheet["state"]["resources"].get(key)
        if pool is None:
            return _bad(f"no '{key}' resource on this character yet (ask your DM to grant it)", 404)
        costs = [{"kind": "resource", "key": key, "amount": 1, "label": pool.get("label", key)}]
        description = f"Cast {name} using a level {slot_level} slot"

    err = _validate_costs(sheet, costs)
    if err:
        return _bad(err, 409)

    char_name = sheet.get("identity", {}).get("name", sheet_id)
    req = requests_store.new_request(
        character_id=sheet_id,
        character_name=char_name,
        req_type="spell_cast",
        description=description,
        costs=costs,
    )
    return jsonify(req), 201


@app.post("/api/me/<sheet_id>/inventory/<int:index>/use")
def api_use_item(sheet_id: str, index: int):
    """Also files a request rather than consuming the item outright — the
    DM confirms it before it actually leaves the inventory."""
    sheet = load_sheet(sheet_id)
    if sheet is None:
        return _not_found()

    inventory = sheet.get("inventory", [])
    if not (0 <= index < len(inventory)):
        return _bad("bad inventory index", 404)

    payload = request.get_json(silent=True) or {}
    amount = _num(payload.get("amount", 1), 1)
    item = inventory[index]

    costs = [{"kind": "item", "name": item.get("name"), "qty": amount}]
    err = _validate_costs(sheet, costs)
    if err:
        return _bad(err, 409)

    char_name = sheet.get("identity", {}).get("name", sheet_id)
    req = requests_store.new_request(
        character_id=sheet_id,
        character_name=char_name,
        req_type="item_use",
        description=f"Use {amount} x {item.get('name')}",
        costs=costs,
    )
    return jsonify(req), 201


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