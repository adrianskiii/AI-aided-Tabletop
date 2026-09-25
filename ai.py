"""
ai.py — shared LLM layer for the tabletop AI DM.

One small facade (`default_llm()`) so narrator.py / npc.py never talk to a
vendor directly. Backends, picked by env vars (keys are NEVER committed):

  TABLETOP_LLM_BACKEND   auto | openai | anthropic | ollama | offline
                         (default "auto")
  openai (any OpenAI-compatible server, incl. LM Studio / vLLM / Ollama OpenAI mode)
    OPENAI_API_KEY                  required (e.g. "sk-...")
    OPENAI_BASE_URL                 optional, default https://api.openai.com/v1
    TABLETOP_MODEL                  default gpt-4o-mini
  anthropic
    ANTHROPIC_API_KEY               required
    TABLETOP_MODEL                  default claude-3-5-sonnet-latest
  ollama (local model, no key)
    OLLAMA_URL                      default http://127.0.0.1:11434
    OLLAMA_MODEL / TABLETOP_MODEL   default llama3.1
  offline
    Deterministic placeholder text — lets the whole app run with no
    internet and no keys (useful for development and this sandbox).

"auto" resolution: OPENAI_API_KEY → ANTHROPIC_API_KEY → Ollama reachable
→ offline. A remote backend that fails at runtime degrades to offline
once, so a dropped network never bricks a session (it is logged and the
reply is flagged "(offline placeholder)").

Only stdlib + flask are needed anywhere in this repo.
"""

import json
import os
import random
import re
import urllib.request
import urllib.error

DEFAULT_TIMEOUT = 60          # a narrated turn can be slow
OLLAMA_PING_TIMEOUT = 2      # liveness probe for backend auto-detect

TEMPERATURE = float(os.environ.get("TABLETOP_TEMPERATURE", "0.9"))
MAX_TOKENS = int(os.environ.get("TABLETOP_MAX_TOKENS", "700"))


class LLMError(RuntimeError):
    """Raised when a backend call fails."""


# --------------------------------------------------------------------------- #
#  HTTP helper (stdlib only — no vendor SDKs)                                  #
# --------------------------------------------------------------------------- #

def _http_json(url: str, headers: dict, payload: dict,
               timeout: int = DEFAULT_TIMEOUT) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise LLMError(f"HTTP {e.code} from {url}: {body}") from None
    except Exception as e:
        raise LLMError(f"request to {url} failed: {e}") from None


def _first_text(data: dict) -> str:
    """Pick the assistant message text out of a chat-shaped response."""
    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        raise LLMError(f"unrecognized response shape: {str(data)[:200]}") from None


# --------------------------------------------------------------------------- #
#  Backends                                                                    #
# --------------------------------------------------------------------------- #

class OpenAILLM:
    """Any OpenAI-compatible /chat/completions endpoint."""

    def __init__(self):
        self.name = "openai"
        self.key = os.environ.get("OPENAI_API_KEY", "")
        self.base = os.environ.get("OPENAI_BASE_URL",
                                   "https://api.openai.com/v1").rstrip("/")
        self.model = os.environ.get("TABLETOP_MODEL", "gpt-4o-mini")
        if not self.key:
            raise LLMError("OPENAI_API_KEY not set")

    def generate(self, system: str, messages: list, hint: dict | None = None):
        data = _http_json(
            f"{self.base}/chat/completions",
            {"Authorization": f"Bearer {self.key}"},
            {"model": self.model,
             "messages": ([{"role": "system", "content": system}]
                          if system else []) + messages,
             "temperature": TEMPERATURE, "max_tokens": MAX_TOKENS})
        return _first_text(data)


class AnthropicLLM:
    def __init__(self):
        self.name = "anthropic"
        self.key = os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = os.environ.get("TABLETOP_MODEL", "claude-3-5-sonnet-latest")
        if not self.key:
            raise LLMError("ANTHROPIC_API_KEY not set")

    def generate(self, system: str, messages: list, hint: dict | None = None):
        data = _http_json(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": self.key, "anthropic-version": "2023-06-01"},
            {"model": self.model, "system": system,
             "messages": messages,
             "temperature": TEMPERATURE, "max_tokens": MAX_TOKENS})
        parts = data.get("content") or []
        return "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()


class OllamaLLM:
    """Local models via Ollama — no key, fully offline once pulled."""

    def __init__(self, url: str | None = None):
        self.name = "ollama"
        self.url = (url or os.environ.get("OLLAMA_URL",
                                            "http://127.0.0.1:11434")).rstrip("/")
        self.model = os.environ.get("TABLETOP_MODEL",
                                    os.environ.get("OLLAMA_MODEL", "llama3.1"))

    def ping(self) -> bool:
        try:
            with urllib.request.urlopen(self.url + "/api/tags",
                                         timeout=OLLAMA_PING_TIMEOUT) as r:
                return r.status == 200
        except Exception:
            return False

    def generate(self, system: str, messages: list, hint: dict | None = None):
        payload_msgs = ([{"role": "system", "content": system}]
                        if system else []) + messages
        data = _http_json(f"{self.url}/api/chat", {},
                          {"model": self.model, "messages": payload_msgs,
                           "stream": False,
                           "options": {"temperature": TEMPERATURE}})
        return (data.get("message", {}).get("content") or "").strip()


# --------------------------------------------------------------------------- #
#  Offline placeholder (development / sandbox — no internet, no keys)          #
# --------------------------------------------------------------------------- #

class OfflineLLM:
    """Deterministic, template-based stand-in so every flow still runs."""

    name = "offline"
    model = "none"

    _OPENERS = [
        "The air tastes of {detail} and the light is doing something wrong. "
        "For now, {party}: this is {place}, and the road ahead has already "
        "noticed you.",
        "{place}. {detail}. Somewhere close, something is waiting and it "
        "knows the shape of the party that just walked in: {party}.",
        "First light over {place}. Rain or not, {party} are here — and the "
        "world {tone} has been keeping its own ledger the whole time.",
    ]
    _DETAILS = ["wet stone", "cheap incense", "ozone", "cold iron",
                "static on the wire", "gunpowder and perfume"]
    _REPLIES = [
        "{name} says {line}\n\nThe words land, and the room tilts with them. "
        "{detail} drifts past the party; whoever is listening shifts just "
        "enough to count as an answer. {beat}",
        "{line} — and in the silence after it, everything that was waiting "
        "finds its nerve. {detail}. {beat}",
        "The party hears {name}: {line}\n\n{place} answers the only way it "
        "knows how — by making things more specific. A door that was not "
        "there before is now. {detail}. {beat}",
        "{name}: {line}\n\nNobody moves for a moment. Then the {detail} does "
        "what {detail} does, and the moment is over before it started. {beat}",
    ]
    _BEATS = [
        "What do you do?",
        "The next move belongs to you.",
        "Something wants a name for what happens next.",
        "Hold the line, or change it.",
        "The world is pausing, out of professional courtesy.",
    ]

    def generate(self, system: str, messages: list, hint: dict | None = None):
        hint = hint or {}
        party = ", ".join(hint.get("party") or ["the adventurers"])
        place = hint.get("setting") or hint.get("title") or "an unnamed threshold"
        tone = hint.get("tone") or "unsettled"
        line = (hint.get("line") or "").strip().replace("\n", " ")
        speaker = hint.get("speaker") or party.split(",")[0]
        detail = random.choice(self._DETAILS)
        beat = random.choice(self._BEATS)

        if not line:
            return (random.choice(self._OPENERS)
                    .format(party=party, place=place, tone=tone, detail=detail)
                    + " " + beat + "  (offline placeholder — set a real "
                      "backend via TABLETOP_LLM_BACKEND to get true narration)")
        name = speaker if speaker != "DM" else re.sub(r"^.*?:\s*", "",
                                                       line.splitlines()[0]) or party
        body = random.choice(self._REPLIES).format(
            name=name, line=f'"{line[:400]}"', party=party, place=place,
            tone=tone, detail=detail, beat=beat)
        return body + "  (offline placeholder — set a real backend via " \
                      "TABLETOP_LLM_BACKEND to get true narration)"


# --------------------------------------------------------------------------- #
#  Facade with auto-detect + graceful degradation                              #
# --------------------------------------------------------------------------- #

class TabletopLLM:
    def __init__(self):
        self.active = None
        self.degraded = False
        self._resolve()

    def _resolve(self):
        want = os.environ.get("TABLETOP_LLM_BACKEND", "auto").lower()
        candidates = []
        if want == "openai":
            candidates = [OpenAILLM]
        elif want == "anthropic":
            candidates = [AnthropicLLM]
        elif want == "ollama":
            candidates = [OllamaLLM]
        elif want == "offline":
            candidates = [OfflineLLM]
        else:  # auto
            if os.environ.get("OPENAI_API_KEY"):
                candidates = [OpenAILLM]
            elif os.environ.get("ANTHROPIC_API_KEY"):
                candidates = [AnthropicLLM]
            else:
                o = OllamaLLM()
                if o.ping():
                    candidates = [OllamaLLM]
        if not candidates:
            candidates = [OfflineLLM]
        try:
            self.active = candidates[0]()
        except LLMError:
            self.active = OfflineLLM()

    def status(self) -> dict:
        a = self.active
        return {"backend": a.name, "model": getattr(a, "model", "template"),
                "degraded": self.degraded}

    def generate(self, system: str, messages: list,
                 hint: dict | None = None) -> str:
        try:
            return self.active.generate(system, messages, hint=hint)
        except LLMError as e:
            print(f"[ai] backend {self.active.name} failed ({e}); "
                  f"falling back to offline placeholder")
            self.degraded = True
            self.active = OfflineLLM()
            return self.active.generate(system, messages, hint=hint)


_LLM: TabletopLLM | None = None


def default_llm() -> TabletopLLM:
    global _LLM
    if _LLM is None:
        _LLM = TabletopLLM()
    return _LLM
