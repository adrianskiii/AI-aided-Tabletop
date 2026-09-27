"""
dm_inbox.py — messages FROM players TO the DM.

Not tied to any one character sheet (the DM isn't a sheet), so it gets its
own small ledger file, same pattern as trades.py. Used by:
  - player_app.py: POST a message here ("whisper to DM")
  - dm_app.py:     read/mark-read here
"""

import json
import uuid
from pathlib import Path

from sheets import BASE_DIR, _now

INBOX_FILE = BASE_DIR / "dm_inbox.json"


def load_inbox() -> list:
    if not INBOX_FILE.exists():
        return []
    try:
        return json.loads(INBOX_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def save_inbox(items: list) -> None:
    INBOX_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def new_dm_message(from_id: str, from_name: str, text: str) -> dict:
    msg = {
        "id": uuid.uuid4().hex[:10],
        "from_id": from_id,
        "from_name": from_name,
        "text": text,
        "created_at": _now(),
        "read": False,
    }
    items = load_inbox()
    items.append(msg)
    save_inbox(items)
    return msg


def mark_read(msg_id: str) -> dict | None:
    items = load_inbox()
    for m in items:
        if m["id"] == msg_id:
            m["read"] = True
            save_inbox(items)
            return m
    return None