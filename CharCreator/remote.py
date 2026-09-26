"""
remote.py — shared HTTP + cache helpers for all remote data sources.

Both `char_creator.py` (dms.gg systems, adventure list) and `fiveetools.py`
(SRD detail data) build on `cached_remote()`:

  * GET over urllib (no third-party HTTP libs)
  * responses cached in .cache/ for CACHE_TTL (6 h)
  * offline → returns stale cache if present, else None (never raises)

Usage:
    from remote import cached_remote
    data = cached_remote("https://api.5etools.co/skills")
"""

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

REMOTE_TIMEOUT = 8            # seconds per remote call
CACHE_TTL = 6 * 3600          # reuse cached remote data for 6 h


def _cache_file_for(url: str) -> Path:
    name = "remote_" + url.replace("https://", "").replace("http://", "")
    name = name.replace("/", "_").replace("?", "_").replace("=", "_") \
               .replace("&", "_")
    return CACHE_DIR / (name + ".json")


def cached_remote(url: str):
    """GET `url`, cached in .cache/ with a TTL. None when offline."""
    cache_file = _cache_file_for(url)
    try:
        age = datetime.now(timezone.utc).timestamp() - cache_file.stat().st_mtime
        if age < CACHE_TTL:
            with open(cache_file, encoding="utf-8") as f:
                return json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    req = urllib.request.Request(url, headers={"User-Agent": "tabletop-host/"})
    try:
        with urllib.request.urlopen(req, timeout=REMOTE_TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8"))
        cache_file.write_text(json.dumps(data), encoding="utf-8")
        return data
    except Exception:
        # stale cache beats nothing
        try:
            with open(cache_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
