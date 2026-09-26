/* player.js — client for player_app.py (port 5001). No frameworks. */

const $ = (id) => document.getElementById(id);
let me = null;       // full /api/me/<id> payload for the selected character
let roster = [];     // everyone, name-level only

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
  roster = await api("/api/roster").catch(() => []);
  const select = $("charSelect");
  select.innerHTML = "";

  if (!roster.length) {
    $("emptyState").style.display = "block";
    $("sheet").style.display = "none";
    return;
  }

  for (const c of roster) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name || "(unnamed)"}${c.npc ? " (NPC)" : ""}`;
    select.appendChild(opt);
  }
  select.onchange = () => loadCharacter(select.value);
  await loadCharacter(roster.find((c) => !c.npc)?.id || roster[0].id);
}

async function loadCharacter(id) {
  me = await api(`/api/me/${id}`);
  $("emptyState").style.display = "none";
  $("sheet").style.display = "block";
  populateTargetPickers(id);
  await renderAll();
}

async function refresh() {
  me = await api(`/api/me/${me.id}`);
  await renderAll();
}

function populateTargetPickers(selfId) {
  const others = roster.filter((c) => c.id !== selfId);
  for (const selId of ["actionTarget", "tradeTarget"]) {
    const sel = $(selId);
    const keep = selId === "actionTarget" ? `<option value="">(no target)</option>` : "";
    sel.innerHTML = keep + others.map((c) => `<option value="${c.id}">${c.name}${c.npc ? " (NPC)" : ""}</option>`).join("");
  }
}

// --------------------------------------------------------------------- //
// Render                                                                  //
// --------------------------------------------------------------------- //

async function renderAll() {
  const { identity, abilities, state, inventory, progression } = me;

  $("charName").textContent = identity.name || "(unnamed)";
  $("charSub").textContent =
    `${identity.race || ""} ${identity.class || ""} · lvl ${identity.level || 1} · ${me.system_label || me.system}`.trim();

  renderHp(state.hp);
  renderAbilities(abilities);
  renderBuffs(state.buffs);
  renderResources(state.resources);
  renderInventory(inventory);
  renderLog(state.action_log);
  await renderMessages();
  await renderTrades();
}

function renderHp(hp) {
  const max = hp.max ?? 0;
  const cur = hp.current ?? 0;
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  $("hpBar").style.width = pct + "%";
  $("hpCurrent").textContent = hp.current ?? "—";
  $("hpMax").textContent = hp.max ?? "—";
  $("hpTemp").textContent = hp.temp ? `+${hp.temp} temp` : "";
}

function renderAbilities(ab) {
  const rows = Object.entries(ab)
    .filter(([k]) => k !== "modifiers" && k !== "notes")
    .map(([k, v]) => {
      const mod = ab.modifiers?.[k];
      const modStr = mod !== undefined ? ` (${mod >= 0 ? "+" : ""}${mod})` : "";
      return `<tr><td>${cap(k)}</td><td class="mono">${v}${modStr}</td></tr>`;
    })
    .join("");
  $("abilitiesTable").innerHTML = rows || `<tr><td class="empty">no abilities set</td></tr>`;
}

function renderBuffs(buffs) {
  const wrap = $("buffChips");
  wrap.innerHTML =
    buffs
      .map((b) => {
        const dur = b.duration_rounds != null ? ` (${b.duration_rounds}r)` : "";
        const cls = b.kind === "debuff" || b.kind === "condition" ? "debuff" : "buff";
        return `<span class="chip ${cls}">${b.name}${dur}</span>`;
      })
      .join("") || `<span class="empty">no active buffs</span>`;
}

function renderResources(resources) {
  const entries = Object.entries(resources || {});
  $("resourceList").innerHTML =
    entries
      .map(([key, r]) => {
        const pips = Array.from({ length: r.max || 0 })
          .map((_, i) => `<div class="pip ${i < r.current ? "filled" : ""}" data-key="${key}" data-idx="${i}"></div>`)
          .join("");
        return `<div class="resource-row"><span>${r.label || key} <span class="muted">(${r.current}/${r.max})</span></span><div class="pips">${pips}</div></div>`;
      })
      .join("") || `<div class="empty">none granted yet</div>`;

  $("resourceList").querySelectorAll(".pip").forEach((pip) =>
    pip.addEventListener("click", () => usePip(pip.dataset.key, +pip.dataset.idx))
  );
}

function renderInventory(inv) {
  $("invTable").innerHTML =
    inv
      .map(
        (item, i) => `<tr>
          <td>${item.name}</td><td class="mono">x${item.qty ?? 1}</td>
          <td><button data-i="${i}" class="useItem">Use</button></td>
        </tr>`
      )
      .join("") || `<tr><td class="empty">empty</td></tr>`;

  $("invTable").querySelectorAll(".useItem").forEach((btn) =>
    btn.addEventListener("click", () => useItem(+btn.dataset.i))
  );
}

function renderLog(log) {
  $("logList").innerHTML = (log || [])
    .slice(-40)
    .map((e) => `<div class="log-entry"><span class="t">${e.type.replace("_", " ")}</span>${e.description}</div>`)
    .join("") || `<div class="empty">nothing logged yet</div>`;
}

async function renderMessages() {
  const messages = await api(`/api/me/${me.id}/messages`).catch(() => []);
  $("messageList").innerHTML =
    messages
      .slice()
      .reverse()
      .map(
        (m) => `<div class="msg ${m.read ? "" : "unread"}" data-id="${m.id}">
          <div class="from">${m.from} · ${m.kind}</div>${m.text}
        </div>`
      )
      .join("") || `<div class="empty">no messages</div>`;

  $("messageList").querySelectorAll(".msg.unread").forEach((el) =>
    el.addEventListener("click", async () => {
      await api(`/api/me/${me.id}/messages/${el.dataset.id}/read`, { method: "POST" });
      el.classList.remove("unread");
    })
  );
}

async function renderTrades() {
  const all = await api(`/api/trades?character=${me.id}`).catch(() => []);
  const inbox = all.filter((t) => t.to_id === me.id);
  const outbox = all.filter((t) => t.from_id === me.id);

  $("tradeInbox").innerHTML =
    inbox.map((t) => tradeCard(t, t.status === "pending" ? [
      `<button data-act="accept" data-id="${t.id}">Accept</button>`,
      `<button data-act="decline" data-id="${t.id}" class="danger">Decline</button>`,
    ].join("") : "")).join("") || `<div class="empty">nothing incoming</div>`;

  $("tradeOutbox").innerHTML =
    outbox.map((t) => tradeCard(t, t.status === "pending" ? `<button data-act="cancel" data-id="${t.id}" class="danger">Cancel</button>` : "")).join("") ||
    `<div class="empty">nothing sent</div>`;

  document.querySelectorAll("[data-act]").forEach((btn) =>
    btn.addEventListener("click", () => respondTrade(btn.dataset.act, btn.dataset.id))
  );
}

function tradeCard(t, actionsHtml) {
  const fmt = (items) => items.map((i) => `${i.qty}x ${i.name}`).join(", ") || "nothing";
  return `<div class="trade-card">
    <div class="status ${t.status}">${t.status}</div>
    <div><b>${t.from_name}</b> → <b>${t.to_name}</b></div>
    <div class="muted">offers ${fmt(t.offer)} for ${fmt(t.request)}</div>
    ${t.note ? `<div class="muted">"${t.note}"</div>` : ""}
    <div class="row">${actionsHtml}</div>
  </div>`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// --------------------------------------------------------------------- //
// Actions                                                                  //
// --------------------------------------------------------------------- //

async function usePip(key, idx) {
  const r = me.state.resources[key];
  if (idx >= r.current) return; // only clicking a filled pip spends it
  await api(`/api/me/${me.id}/resources/${key}/use`, { method: "POST", body: JSON.stringify({ amount: r.current - idx }) });
  await refresh();
}

async function useItem(i) {
  await api(`/api/me/${me.id}/inventory/${i}/use`, { method: "POST", body: JSON.stringify({ amount: 1 }) });
  await refresh();
  toast("Item used");
}

async function respondTrade(action, id) {
  await api(`/api/trades/${id}/${action}`, { method: "POST", body: JSON.stringify({ by: me.id }) });
  await refresh();
  toast(`Trade ${action}ed`);
}

function wireControls() {
  $("spellCast").onclick = async () => {
    const name = $("spellName").value.trim();
    if (!name) return;
    const lvl = $("spellLevel").value;
    const body = { name };
    if (lvl !== "") body.slot_level = parseInt(lvl, 10);
    const r = await api(`/api/me/${me.id}/spells/cast`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
    if (r) {
      toast(`Cast ${r.name}`);
      $("spellName").value = "";
      $("spellLevel").value = "";
      await refresh();
    }
  };

  $("actionAdd").onclick = async () => {
    const description = $("actionDesc").value.trim();
    if (!description) return;
    const body = { type: $("actionType").value, description };
    if ($("actionTarget").value) body.target_id = $("actionTarget").value;
    await api(`/api/me/${me.id}/actions`, { method: "POST", body: JSON.stringify(body) });
    $("actionDesc").value = "";
    await refresh();
  };

  $("tradePropose").onclick = async () => {
    const to_id = $("tradeTarget").value;
    if (!to_id) return toast("pick who to trade with", true);
    const offer = [];
    const oName = $("offerName").value.trim();
    if (oName) offer.push({ name: oName, qty: parseInt($("offerQty").value || "1", 10) });
    const request = [];
    const rName = $("requestName").value.trim();
    if (rName) request.push({ name: rName, qty: parseInt($("requestQty").value || "1", 10) });
    if (!offer.length && !request.length) return toast("offer or request something first", true);

    await api("/api/trades", {
      method: "POST",
      body: JSON.stringify({ from_id: me.id, to_id, offer, request, note: $("tradeNote").value.trim() }),
    }).catch(() => null);

    $("offerName").value = ""; $("requestName").value = ""; $("tradeNote").value = "";
    await refresh();
    toast("Trade proposed");
  };
}

wireControls();
boot();
