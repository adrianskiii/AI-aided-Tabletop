/* player.js — client for player_app.py (port 5001). No frameworks. */

const $ = (id) => document.getElementById(id);
let me = null;       // full /api/me/<id> payload for the selected character
let roster = [];     // everyone, name-level only
let lastMsgCount = 0;

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

// --------------------------------------------------------------------- //
// Tabs                                                                    //
// --------------------------------------------------------------------- //

function wireTabs() {
  $("tabs").querySelectorAll("button[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("tabs").querySelectorAll("button[data-tab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
      $(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// --------------------------------------------------------------------- //
// Boot / load                                                             //
// --------------------------------------------------------------------- //

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
  lastMsgCount = 0;
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
  for (const selId of ["actionTarget", "tradeTarget", "whisperTarget"]) {
    const sel = $(selId);
    const keep = selId === "actionTarget" ? `<option value="">(no target)</option>` : "";
    sel.innerHTML = keep + others.map((c) => `<option value="${c.id}">${c.name}${c.npc ? " (NPC)" : ""}</option>`).join("");
  }
}

function populateCostResourcePicker() {
  const sel = $("costResource");
  const entries = Object.entries(me.state.resources || {});
  sel.innerHTML = `<option value="">(no resource cost)</option>` +
    entries.map(([key, r]) => `<option value="${key}">${r.label || key} (${r.current}/${r.max})</option>`).join("");
}

// --------------------------------------------------------------------- //
// Render                                                                  //
// --------------------------------------------------------------------- //

async function renderAll() {
  const { identity, abilities, state, inventory, progression, known } = me;

  $("charName").textContent = identity.name || "(unnamed)";
  $("charSub").textContent =
    `${identity.race || ""} ${identity.class || ""} · lvl ${identity.level || 1} · ${me.system_label || me.system}`.trim();

  renderHp(state.hp);
  renderAbilities(abilities);
  renderBuffs(state.buffs);
  renderResources(state.resources);
  renderActionEconomy(state.action_economy);
  renderKnown(known || {});
  renderLog(state.action_log);
  renderInventory(inventory);
  renderProgression(progression, state);
  populateCostResourcePicker();
  await renderMessages();
  await renderTrades();
  await renderMyRequests();
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
    (buffs || [])
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
          .map((_, i) => `<div class="pip ${i < r.current ? "filled" : ""}"></div>`)
          .join("");
        return `<div class="resource-row"><span>${r.label || key} <span class="muted">(${r.current}/${r.max})</span></span><div class="pips">${pips}</div></div>`;
      })
      .join("") || `<div class="empty">none granted yet</div>`;
  // Pips are read-only display — spending a resource goes through a DM-approved
  // request (Social tab), not a direct click here. See wireControls() for the
  // resource dropdown used to build those requests.
}

function renderActionEconomy(econ) {
  const entries = Object.entries(econ || {});
  $("actionEconList").innerHTML =
    entries
      .map(([key, p]) => {
        const pips = Array.from({ length: p.max || 0 })
          .map((_, i) => `<div class="pip action ${i < p.current ? "filled" : ""}" data-key="${key}" data-idx="${i}"></div>`)
          .join("");
        return `<div class="pool-row"><span>${p.label || key} <span class="muted">(${p.current}/${p.max})</span></span><div class="pips">${pips}</div></div>`;
      })
      .join("") || `<div class="empty">no action pools set by DM yet</div>`;

  $("actionEconList").querySelectorAll(".pip").forEach((pip) =>
    pip.addEventListener("click", () => useActionPip(pip.dataset.key, +pip.dataset.idx))
  );
}

function renderKnown(known) {
  $("featureList").innerHTML =
    (known.class_features || [])
      .map((f) => `<div class="feature-card"><span class="lvl">lvl ${f.level}</span><span class="name">${f.name}</span>${f.tldr || f.description ? " — " + (f.tldr || f.description) : ""}</div>`)
      .join("") || `<div class="empty">no class features yet</div>`;

  const profLabel = (p) => {
    if (typeof p === "string") return p;
    const name = p.name || p.skill || "?";
    const rank = p.rank || p.level;
    return rank ? `${name} (${rank})` : name;
  };

  $("profList").innerHTML = tagList((known.proficiencies || []).map(profLabel));
  $("raceTraitList").innerHTML = tagList((known.race_traits || []).map((t) => (typeof t === "string" ? t : t.name)));
  $("raceSkillList").innerHTML = tagList((known.race_skills || []).map(profLabel));

  $("cantripList").innerHTML = spellRows(known.cantrips);
  $("spellList").innerHTML = spellRows(known.spells);
}

function tagList(items) {
  const list = (items || []).filter(Boolean);
  return list.map((t) => `<span class="tag">${t}</span>`).join("") || `<span class="empty">none</span>`;
}

function spellRows(spells) {
  if (!spells || !spells.length) return `<div class="empty">none known</div>`;
  return spells
    .map((spell) => {
      if (typeof spell === "string") {
        return `<div class="spell-row"><span>${spell}</span></div>`;
      }
      const name = spell.name || "Unnamed";
      const level = spell.level != null ? `<span class="muted">Lv ${spell.level}</span>` : "";
      const school = spell.school ? `<span class="muted">${spell.school}</span>` : "";
      return `<div class="spell-row"><span>${name}</span><span class="spell-meta">${level}${school}</span></div>`;
    })
    .join("");
}

async function renderMyRequests() {
  const items = await api(`/api/me/${me.id}/requests`).catch(() => []);
  $("myRequests").innerHTML =
    items.slice(0, 20).map((r) => {
      const costStr = (r.costs || []).map((c) =>
        c.kind === "resource" ? `${c.amount}x ${c.label || c.key}` : `${c.qty}x ${c.name}`
      ).join(", ") || "nothing";
      return `<div class="trade-card">
        <div class="status ${r.status}">${r.status}</div>
        <div>${r.description}</div>
        <div class="muted">costs: ${costStr}</div>
        ${r.resolution_note ? `<div class="muted">"${r.resolution_note}"</div>` : ""}
      </div>`;
    }).join("") || `<div class="empty">nothing filed yet</div>`;
}

function renderInventory(inv) {
  $("invTable").innerHTML =
    inv
      .map(
        (item, i) => `<tr>
          <td>${item.name}</td><td class="mono">x${item.qty ?? 1}</td>
          <td><button data-i="${i}" class="useItem">Request use</button></td>
        </tr>`
      )
      .join("") || `<tr><td class="empty">empty</td></tr>`;

  $("invTable").querySelectorAll(".useItem").forEach((btn) =>
    btn.addEventListener("click", () => useItem(+btn.dataset.i))
  );
}

function renderProgression(progression, state) {
  const xp = progression?.xp ?? 0;
  const level = progression?.level ?? me.identity?.level ?? 1;
  $("progLevel").textContent = level;
  $("xpVal").textContent = xp;
  // no universal xp-per-level formula across systems, so show a soft bar
  // relative to the next 1000-xp band purely as a visual cue
  const pct = Math.max(0, Math.min(100, (xp % 1000) / 10));
  $("xpBar").style.width = pct + "%";

  const available = !!state.level_up_available;
  $("levelUpBtn").disabled = !available;
  $("levelUpStatus").textContent = available
    ? "Your DM unlocked a level up — go ahead!"
    : "Waiting on the DM to unlock your next level.";
  $("levelUpBadge").style.display = available ? "inline-block" : "none";
}

function renderLog(log) {
  $("logList").innerHTML = (log || [])
    .slice(-40)
    .map((e) => `<div class="log-entry"><span class="t">${e.type.replace("_", " ")}</span>${e.description}</div>`)
    .join("") || `<div class="empty">nothing logged yet</div>`;
}

async function renderMessages() {
  const messages = await api(`/api/me/${me.id}/messages`).catch(() => []);
  const unread = messages.filter((m) => !m.read).length;
  $("msgBadge").style.display = unread ? "inline-block" : "none";
  $("msgBadge").textContent = unread || "";

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
      const remaining = $("messageList").querySelectorAll(".msg.unread").length;
      $("msgBadge").style.display = remaining ? "inline-block" : "none";
      $("msgBadge").textContent = remaining || "";
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

async function useActionPip(key, idx) {
  const p = me.state.action_economy[key];
  if (idx >= p.current) return;
  await api(`/api/me/${me.id}/action-economy/${key}/use`, { method: "POST", body: JSON.stringify({ amount: p.current - idx }) });
  await refresh();
}

async function useItem(i) {
  await api(`/api/me/${me.id}/inventory/${i}/use`, { method: "POST", body: JSON.stringify({ amount: 1 }) });
  await refresh();
  toast("Request sent to DM");
}

async function respondTrade(action, id) {
  await api(`/api/trades/${id}/${action}`, { method: "POST", body: JSON.stringify({ by: me.id }) });
  await refresh();
  toast(`Trade ${action}ed`);
}

function wireControls() {
  $("endTurn").onclick = async () => {
    await api(`/api/me/${me.id}/action-economy/reset`, { method: "POST" });
    await refresh();
    toast("Actions refreshed");
  };

  $("levelUpBtn").onclick = async () => {
    const r = await api(`/api/me/${me.id}/level-up`, { method: "POST" }).catch(() => null);
    if (r) {
      toast(`Level up! Now level ${r.level}`);
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
    toast("Logged");
  };

  $("actionRequest").onclick = async () => {
    const description = $("actionDesc").value.trim();
    if (!description) return toast("describe what you're doing first", true);
    const body = { type: $("actionType").value, description };
    if ($("actionTarget").value) body.target_id = $("actionTarget").value;

    const resKey = $("costResource").value;
    if (resKey) {
      const r = me.state.resources[resKey];
      const amount = parseInt($("costAmount").value || "1", 10);
      body.costs = [{ kind: "resource", key: resKey, amount, label: r?.label || resKey }];
    } else {
      body.costs = [];
    }

    const r = await api(`/api/me/${me.id}/requests`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
    if (r) {
      $("actionDesc").value = "";
      await refresh();
      toast("Request sent to DM — waiting for approval");
    }
  };

  $("whisperSend").onclick = async () => {
    const to_id = $("whisperTarget").value;
    const text = $("whisperText").value.trim();
    if (!to_id || !text) return toast("pick someone and write a message", true);
    await api(`/api/me/${me.id}/messages/whisper`, { method: "POST", body: JSON.stringify({ to_id, text }) });
    $("whisperText").value = "";
    toast("Whisper sent");
  };

  $("dmMsgSend").onclick = async () => {
    const text = $("dmMsgText").value.trim();
    if (!text) return;
    await api(`/api/me/${me.id}/messages/to-dm`, { method: "POST", body: JSON.stringify({ text }) });
    $("dmMsgText").value = "";
    toast("Message sent to DM");
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

wireTabs();
wireControls();
boot();
setInterval(() => { if (me) refresh(); }, 8000); // light polling for DM grants / other players' actions