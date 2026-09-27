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
  await Promise.all([loadCharacterList(), loadActivity(), loadTrades(), loadDmInbox(), loadRequests()]);
}

async function loadRequests() {
  const items = await api("/api/requests?status=pending").catch(() => []);
  $("requestList").innerHTML =
    items.map((r) => {
      const costStr = (r.costs || []).map((c) =>
        c.kind === "resource" ? `${c.amount}x ${c.label || c.key}` : `${c.qty}x ${c.name}`
      ).join(", ") || "nothing";
      const target = r.target_name ? ` → <b>${r.target_name}</b>` : "";
      return `<div class="trade-card" data-id="${r.id}">
        <div class="status pending">${r.type.replace("_", " ")}</div>
        <div><b>${r.character_name}</b>${target}: ${r.description}</div>
        <div class="muted">costs: ${costStr}</div>
        <div class="row">
          <input class="reqNote" data-id="${r.id}" placeholder="note / reason (optional)" style="flex:1; min-width:140px;">
          <button data-id="${r.id}" class="primary reqApprove">Approve</button>
          <button data-id="${r.id}" class="danger reqDeny">Deny</button>
        </div>
      </div>`;
    }).join("") || `<div class="empty">nothing pending</div>`;

  $("requestList").querySelectorAll(".reqApprove").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const noteEl = document.querySelector(`.reqNote[data-id="${btn.dataset.id}"]`);
      const note = noteEl ? noteEl.value.trim() : "";
      await api(`/api/requests/${btn.dataset.id}/approve`, { method: "POST", body: JSON.stringify({ note }) });
      toast("Request approved");
      await loadRequests();
      if (selected) await refreshSelected();
    })
  );
  $("requestList").querySelectorAll(".reqDeny").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const noteEl = document.querySelector(`.reqNote[data-id="${btn.dataset.id}"]`);
      const reason = noteEl ? noteEl.value.trim() : "";
      await api(`/api/requests/${btn.dataset.id}/deny`, { method: "POST", body: JSON.stringify({ reason }) });
      toast("Request denied");
      await loadRequests();
      if (selected) await refreshSelected();
    })
  );
}

async function loadDmInbox() {
  const items = await api("/api/dm/inbox").catch(() => []);
  $("dmInbox").innerHTML =
    items.map((m) => `<div class="feed-entry ${m.read ? "" : ""}" data-id="${m.id}">
      <span class="who">${m.from_name}</span> — ${m.text}
      ${m.read ? "" : '<button class="markRead" data-id="' + m.id + '" style="margin-left:6px;">mark read</button>'}
    </div>`).join("") || `<div class="empty">no messages</div>`;

  $("dmInbox").querySelectorAll(".markRead").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/dm/inbox/${btn.dataset.id}/read`, { method: "POST" });
      await loadDmInbox();
    })
  );
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
  $("levelVal").textContent = identity?.level ?? 1;
  $("levelUpStatus").textContent = state.level_up_available ? "Level up available — waiting on player" : "";

  renderBuffs(state.buffs);
  renderResources(state.resources);
  renderInventory(inventory);
  renderLog(state.action_log);
  renderActionEconomy(state.action_economy);
}

function renderActionEconomy(econ) {
  const entries = Object.entries(econ || {});
  $("actionEconList").innerHTML =
    entries.map(([key, p]) => `<div class="row" style="justify-content:space-between;">
      <span>${p.label || key} <span class="muted">(${p.current}/${p.max})</span></span>
      <button data-key="${key}" class="actRemove danger">✕</button>
    </div>`).join("") || `<div class="empty">none set</div>`;

  $("actionEconList").querySelectorAll(".actRemove").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/characters/${selected.id}/action-economy/${btn.dataset.key}`, { method: "DELETE" });
      await refreshSelected();
    })
  );
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

  $("levelUpUnlock").onclick = async () => {
    await api(`/api/characters/${selected.id}/level-up/unlock`, { method: "POST" });
    toast("Level up unlocked");
    await refreshSelected();
  };

  $("actionEconReset").onclick = async () => {
    await api(`/api/characters/${selected.id}/action-economy/reset`, { method: "POST" });
    await refreshSelected();
  };

  $("actAdd").onclick = async () => {
    const key = $("actKey").value.trim();
    const max = parseInt($("actMax").value || "0", 10);
    if (!key || !max) return;
    await api(`/api/characters/${selected.id}/action-economy`, {
      method: "POST",
      body: JSON.stringify({ key, max, label: $("actLabel").value.trim() || key }),
    });
    $("actKey").value = ""; $("actMax").value = ""; $("actLabel").value = "";
    await refreshSelected();
  };

  $("newRound").onclick = async () => {
    await api("/api/action-economy/reset-all", { method: "POST" });
    toast("New round — all actions refreshed");
    if (selected) await refreshSelected();
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
setInterval(loadDmInbox, 8000);
setInterval(loadRequests, 6000);