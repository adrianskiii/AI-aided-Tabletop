/* dm.js — client for dm_app.py (port 5002). No frameworks. */

const $ = (id) => document.getElementById(id);
let characters = [];
let selected = null; // full sheet

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => (t.className = "toast"), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || `Error ${res.status}`, true);
    throw new Error(data.error || String(res.status));
  }
  return data;
}

async function boot() {
  await Promise.all([loadCharacterList(), loadActivity(), loadTrades()]);
}

async function loadCharacterList() {
  characters = await api("/api/characters").catch(() => []);
  const list = $("charList");
  list.innerHTML = characters
    .map((c) => {
      const hp = c.state?.hp || {};
      const hpStr = hp.max != null ? `${hp.current ?? "?"}/${hp.max}` : "";
      return `<div class="char-row ${selected?.id === c.id ? "active" : ""}" data-id="${c.id}">
        <span>${c.identity?.name || "(unnamed)"} ${c.npc ? '<span class="npc-tag">NPC</span>' : ""}</span>
        <span class="hp">${hpStr}</span>
      </div>`;
    })
    .join("") || `<div class="empty">no characters yet</div>`;

  list.querySelectorAll(".char-row").forEach((row) =>
    row.addEventListener("click", () => selectCharacter(row.dataset.id))
  );
}

async function selectCharacter(id) {
  selected = await api(`/api/characters/${id}`);
  $("emptyState").style.display = "none";
  $("detail").style.display = "block";
  await loadCharacterList(); // refresh highlight
  renderDetail();
}

async function refreshSelected() {
  if (!selected) return;
  selected = await api(`/api/characters/${selected.id}`);
  renderDetail();
  await loadCharacterList();
  await loadActivity();
}

function renderDetail() {
  const { identity, state, inventory, progression } = selected;
  $("charName").textContent = identity?.name || "(unnamed)";
  $("charSub").textContent = `${identity?.race || ""} ${identity?.class || ""} · lvl ${identity?.level || 1} · ${selected.system_label || selected.system}${selected.npc ? " · NPC" : ""}`.trim();

  const hp = state.hp;
  const pct = hp.max ? Math.max(0, Math.min(100, ((hp.current ?? 0) / hp.max) * 100)) : 0;
  $("hpBar").style.width = pct + "%";
  $("hpCurrent").textContent = hp.current ?? "—";
  $("hpMax").textContent = hp.max ?? "—";

  $("xpVal").textContent = progression?.xp ?? 0;

  renderBuffs(state.buffs);
  renderResources(state.resources);
  renderInventory(inventory);
  renderLog(state.action_log);
}

function renderBuffs(buffs) {
  $("buffChips").innerHTML =
    buffs
      .map((b) => {
        const dur = b.duration_rounds != null ? ` (${b.duration_rounds}r)` : "";
        const cls = b.kind === "debuff" || b.kind === "condition" ? "debuff" : "buff";
        return `<span class="chip ${cls}">${b.name}${dur} <span class="x" data-id="${b.id}">✕</span></span>`;
      })
      .join("") || `<span class="empty">none</span>`;

  $("buffChips").querySelectorAll(".x").forEach((el) =>
    el.addEventListener("click", async () => {
      await api(`/api/characters/${selected.id}/buffs/${el.dataset.id}`, { method: "DELETE" });
      await refreshSelected();
    })
  );
}

function renderResources(resources) {
  const entries = Object.entries(resources || {});
  $("resourceList").innerHTML =
    entries.map(([key, r]) => `<div class="row" style="justify-content:space-between;">
      <span>${r.label || key} <span class="muted">(${r.current}/${r.max})</span></span>
      <span>
        <button data-key="${key}" class="resRestore">Restore full</button>
      </span>
    </div>`).join("") || `<div class="empty">none granted yet</div>`;

  $("resourceList").querySelectorAll(".resRestore").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/characters/${selected.id}/resources/${btn.dataset.key}/restore`, { method: "POST", body: JSON.stringify({ full: true }) });
      await refreshSelected();
    })
  );
}

function renderInventory(inv) {
  $("invTable").innerHTML =
    inv.map((item, i) => `<tr>
      <td>${item.name}</td><td class="mono">x${item.qty ?? 1}</td>
      <td><button data-i="${i}" class="danger takeItem">Take</button></td>
    </tr>`).join("") || `<tr><td class="empty">empty</td></tr>`;

  $("invTable").querySelectorAll(".takeItem").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/characters/${selected.id}/inventory/${btn.dataset.i}`, { method: "DELETE" });
      await refreshSelected();
    })
  );
}

function renderLog(log) {
  $("logList").innerHTML = (log || [])
    .slice(-40)
    .map((e) => `<div class="log-entry"><span class="t">${e.type.replace("_", " ")}</span>${e.description}</div>`)
    .join("") || `<div class="empty">nothing yet</div>`;
}

async function loadActivity() {
  const feed = await api("/api/activity?limit=40").catch(() => []);
  $("activityFeed").innerHTML =
    feed.map((e) => `<div class="feed-entry"><span class="t">${e.type.replace("_", " ")}</span><span class="who">${e.character_name}</span> — ${e.description}</div>`).join("") ||
    `<div class="empty">nothing yet</div>`;
}

async function loadTrades() {
  const trades = await api("/api/trades").catch(() => []);
  $("tradeList").innerHTML =
    trades
      .map((t) => {
        const fmt = (items) => items.map((i) => `${i.qty}x ${i.name}`).join(", ") || "nothing";
        const cancelBtn = t.status === "pending" ? `<button data-id="${t.id}" class="danger cancelTrade">Force cancel</button>` : "";
        return `<div class="trade-card">
          <div class="status ${t.status}">${t.status}</div>
          <div><b>${t.from_name}</b> → <b>${t.to_name}</b>: ${fmt(t.offer)} for ${fmt(t.request)}</div>
          ${cancelBtn}
        </div>`;
      })
      .join("") || `<div class="empty">no trades yet</div>`;

  $("tradeList").querySelectorAll(".cancelTrade").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/trades/${btn.dataset.id}/cancel`, { method: "POST" });
      await loadTrades();
      toast("Trade cancelled");
    })
  );
}

function wireControls() {
  $("npcCreate").onclick = async () => {
    const name = $("npcName").value.trim();
    if (!name) return;
    await api("/api/npcs", { method: "POST", body: JSON.stringify({ name }) });
    $("npcName").value = "";
    await loadCharacterList();
    toast(`${name} created`);
  };

  $("hpApply").onclick = async () => {
    const delta = parseInt($("hpDelta").value || "0", 10);
    if (!delta) return;
    await api(`/api/characters/${selected.id}/hp`, { method: "POST", body: JSON.stringify({ delta }) });
    $("hpDelta").value = "";
    await refreshSelected();
  };
  $("hpMaxApply").onclick = async () => {
    const max = parseInt($("hpMaxInput").value || "0", 10);
    if (!max) return;
    await api(`/api/characters/${selected.id}/hp`, { method: "POST", body: JSON.stringify({ max }) });
    $("hpMaxInput").value = "";
    await refreshSelected();
  };

  $("xpApply").onclick = async () => {
    const amount = parseInt($("xpDelta").value || "0", 10);
    if (!amount) return;
    await api(`/api/characters/${selected.id}/xp`, { method: "POST", body: JSON.stringify({ amount }) });
    $("xpDelta").value = "";
    await refreshSelected();
  };

  $("whisperSend").onclick = async () => {
    const text = $("whisperText").value.trim();
    if (!text) return;
    await api(`/api/characters/${selected.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    $("whisperText").value = "";
    toast("Whisper sent");
  };

  $("itemGrant").onclick = async () => {
    const name = $("itemName").value.trim();
    if (!name) return;
    const qty = parseInt($("itemQty").value || "1", 10);
    await api(`/api/characters/${selected.id}/inventory`, { method: "POST", body: JSON.stringify({ name, qty }) });
    $("itemName").value = "";
    await refreshSelected();
  };

  $("buffAdd").onclick = async () => {
    const name = $("buffName").value.trim();
    if (!name) return;
    const rounds = $("buffRounds").value ? parseInt($("buffRounds").value, 10) : null;
    await api(`/api/characters/${selected.id}/buffs`, {
      method: "POST",
      body: JSON.stringify({ name, kind: $("buffKind").value, duration_rounds: rounds }),
    });
    $("buffName").value = ""; $("buffRounds").value = "";
    await refreshSelected();
  };

  $("resAdd").onclick = async () => {
    const key = $("resKey").value.trim();
    const max = parseInt($("resMax").value || "0", 10);
    if (!key || !max) return;
    await api(`/api/characters/${selected.id}/resources`, { method: "POST", body: JSON.stringify({ key, max, current: max }) });
    $("resKey").value = ""; $("resMax").value = "";
    await refreshSelected();
  };
}

wireControls();
boot();
setInterval(loadActivity, 8000); // light polling so the DM sees player actions show up
