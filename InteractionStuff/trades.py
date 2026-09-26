"""
trades.py — central trade ledger, shared by player_app.py and dm_app.py.

A trade is a proposal from one character to another: "I'll give you X, for
Y." It lives in its own file (trades.json) rather than inside either
character's sheet, so both sides (and the DM) see the exact same record and
there's nothing to keep in sync across two files.

    {
      "id": "...",
      "from_id": "785bf8f15145", "from_name": "tav",
      "to_id": "a1b2c3d4e5f6", "to_name": "Shadowheart",
      "offer":   [{"name": "Rope", "qty": 1}],
      "request": [{"name": "Torch", "qty": 2}],
      "note": "need this for the well",
      "status": "pending" | "accepted" | "declined" | "cancelled",
      "created_at": "...", "resolved_at": null
    }

Players only ever see names/quantities they typed themselves — a trade
request is a request, not a window into the other character's inventory.
"""

import json
import uuid
from pathlib import Path

from sheets import BASE_DIR, _now

TRADES_FILE = BASE_DIR / "trades.json"


def load_trades() -> list:
    if not TRADES_FILE.exists():
        return []
    try:
        return json.loads(TRADES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def save_trades(trades: list) -> None:
    TRADES_FILE.write_text(json.dumps(trades, indent=2, ensure_ascii=False), encoding="utf-8")


def find_trade(trade_id: str) -> dict | None:
    return next((t for t in load_trades() if t["id"] == trade_id), None)


def new_trade(
    from_id: str,
    from_name: str,
    to_id: str,
    to_name: str,
    offer: list,
    request: list,
    note: str = "",
) -> dict:
    trade = {
        "id": uuid.uuid4().hex[:10],
        "from_id": from_id,
        "from_name": from_name,
        "to_id": to_id,
        "to_name": to_name,
        "offer": offer,
        "request": request,
        "note": note,
        "status": "pending",
        "created_at": _now(),
        "resolved_at": None,
    }
    trades = load_trades()
    trades.append(trade)
    save_trades(trades)
    return trade


def update_trade(trade_id: str, **fields) -> dict | None:
    trades = load_trades()
    for t in trades:
        if t["id"] == trade_id:
            t.update(fields)
            save_trades(trades)
            return t
    return None
