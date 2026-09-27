"""
requests_store.py — pending action requests.

A player can narrate freely at no cost (that still goes straight into their
own action_log via player_app.py's /actions endpoint — no gate needed for
flavor text). But anything that would SPEND something — a spell slot, a
resource pool, an inventory item — is declared here as a request and sits
"pending" until the DM approves or denies it. Approval is the only place
those deductions actually happen, and it re-validates the character can
still afford it (their pools may have changed since the request was made).
This is what keeps a player from just editing their own sheet by clicking
a pip: the pip is gone, only requests remain, and only the DM resolves them.

    {
      "id": "...",
      "character_id": "...", "character_name": "...",
      "type": "attack" | "spell_cast" | "skill_check" | "social" | "exploration" | "action",
      "description": "...",
      "target_id": "..." | null, "target_name": "..." | null,
      "costs": [
        {"kind": "resource", "key": "spell_slots_2", "amount": 1, "label": "2nd-level slot"},
        {"kind": "item", "name": "Potion of Healing", "qty": 1}
      ],
      "status": "pending" | "approved" | "denied",
      "resolution_note": "",
      "created_at": "...", "resolved_at": null
    }
"""

import json
import uuid
from pathlib import Path

from sheets import BASE_DIR, _now

REQUESTS_FILE = BASE_DIR / "requests.json"


def load_requests() -> list:
    if not REQUESTS_FILE.exists():
        return []
    try:
        return json.loads(REQUESTS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def save_requests(items: list) -> None:
    REQUESTS_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def find_request(request_id: str) -> dict | None:
    return next((r for r in load_requests() if r["id"] == request_id), None)


def new_request(
    character_id: str,
    character_name: str,
    req_type: str,
    description: str,
    costs: list,
    target_id: str | None = None,
    target_name: str | None = None,
) -> dict:
    req = {
        "id": uuid.uuid4().hex[:10],
        "character_id": character_id,
        "character_name": character_name,
        "type": req_type,
        "description": description,
        "target_id": target_id,
        "target_name": target_name,
        "costs": costs or [],
        "status": "pending",
        "resolution_note": "",
        "created_at": _now(),
        "resolved_at": None,
    }
    items = load_requests()
    items.append(req)
    save_requests(items)
    return req


def update_request(request_id: str, **fields) -> dict | None:
    items = load_requests()
    for r in items:
        if r["id"] == request_id:
            r.update(fields)
            save_requests(items)
            return r
    return None