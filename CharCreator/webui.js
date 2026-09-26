/* =========================================================================
   webui.js — Tabletop Character Forge (wizard client)

   A BG3-style step wizard where every choice is *narrated* (real perks,
   buffs, traits) — nothing hardcoded, everything from:
     /api/games             system profiles (tldr, links, progression, …)
     /api/campaigns?system  campaigns (AI option ⊕ local ⊕ 5etools)
     /api/rules/<system>    live 5e knowledge base (races/classes/…  + sub-)
     /api/characters        list / create / xp / inventory / messages

   State lives in one `S` object. Steps are driven by the panels' data-step
   attributes, so adding a step is a matter of adding a <section>.
   ========================================================================= */
"use strict";

/* ---------------------------------------------------------------------- */
/*  Helpers                                                               */
/* ---------------------------------------------------------------------- */
const $ = id => document.getElementById(String(id).replace(/^#/, ""));
const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const val = id => { const el = $(id); return el ? el.value.trim() : ""; };
const fmtMod = m => (m >= 0 ? "+" : "") + m;

const STD6 = ["strength", "dexterity", "constitution",
              "intelligence", "wisdom", "charisma"];
const ABILITY_ICONS = { strength: "💪", dexterity: "🤸", constitution: "❤️",
  intelligence: "🧠", wisdom: "🦉", charisma: "✨",
  body: "💪", cool: "😎", intuition: "🔮", logic: "🧮", reflexes: "⚡",
  technical: "🔧", empathy: "💞" };
const PORTRAITS = ["🧙", "🧝", "🧝‍♀️", "🧌", "🦹", "🧛", "🧟", "🥷", "🧑‍🚀",
                   "🐉", "🦊", "🦇", "🐺", "🕷️", "🤖", "👹", "😇", "💀"];

/* ---------------------------------------------------------------------- */
/*  Global state                                                          */
/* ---------------------------------------------------------------------- */
const S = {
  games: {}, campaigns: [], rules: null,
  system: null, campaign: null,
  race: null, subrace: null, class: null, subclass: null, background: null,
  prof: {}, spells: new Set(), spellLevels: {},
  portrait: "🧙", kv: [], abilities: {},
  loadedId: null,          // currently-edited sheet, if any
  party: [],               // other characters (for whispers)
  whisperTarget: null,     // selected party member to whisper
};

/* ---------------------------------------------------------------------- */
/*  Wizard navigation                                                     */
/* ---------------------------------------------------------------------- */
const STEP_LABELS = ["System", "Race", "Class", "Skill tree",
                     "Proficiencies", "Details", "Secrets", "Save", "Manage"];
const STEP_ICONS = ["🧭", "🩸", "⚔", "🔺", "📜", "🏛", "🕯", "💾", "📋"];

function buildStepDots() {
  const panels = [...document.querySelectorAll(".step-panel")];
  // left rail — one anchor per step, skip back to any filled menu,
  // plus a bottom "acquire" section listing current skills + spells.
  const rail = $("#rail");
  if (rail) {
    rail.innerHTML = panels.map((p, i) =>
      `<a data-i="${i}" onclick="goStep(${i})" title="${esc(STEP_LABELS[i] || "")}">` +
      `<span>${STEP_ICONS[i] || "·"}</span><span>${esc(STEP_LABELS[i] || "?")}</span></a>`
    ).join("");

  }
}

function toggleAcquire() {
  const p = $("#acquire-panel");
  if (p) { p.style.display = p.style.display === "none" ? "block" : "none"; renderAcquire(); }
}


function _rewardItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(x =>
    typeof x === "string" ? { name: x, description: "" } :
    { name: x.name || x.title || "Reward", description: x.description || x.desc || "" }
  );
  if (typeof value === "object") return Object.entries(value).flatMap(([level, xs]) =>
    (Array.isArray(xs) ? xs : [xs]).map(x =>
      typeof x === "string" ? { level, name: x, description: "" } :
      { level, name: x?.name || x?.title || "Reward", description: x?.description || x?.desc || "" }
    )
  );
  return [];
}

function _classForDock() {
  if (!S.class) return null;
  return S.class;
}

function _subclassForDock() {
  return S.subclass || null;
}

function renderBuildDock() {
  const body = $("#dock-body");
  const meta = $("#dock-meta");
  if (!body || !meta) return;

  const lvlNow = Math.max(1, parseInt(val("f-level")) || 1);
  const race = S.race || {};
  const subrace = S.subrace || null;
  const cls = _classForDock();
  const subclass = _subclassForDock();
  const system = S.system || {};
  const taxonomy = system.taxonomy || {};
  const raceLabel = taxonomy.race_label || ((system.fields || {}).race || {}).label || "Race";
  const subraceLabel = taxonomy.subrace_label || "Subrace";
  const classLabel = taxonomy.class_label || ((system.fields || {}).class || {}).label || "Class";
  const subclassLabel = taxonomy.subclass_label || "Subclass";

  meta.textContent = [
    system.label || system.id || "",
    race.name ? `${raceLabel}: ${race.name}` : "",
    subrace?.name ? `${subraceLabel}: ${subrace.name}` : "",
    cls?.name ? `${classLabel}: ${cls.name}` : "",
    subclass?.name ? `${subclassLabel}: ${subclass.name}` : "",
    `Level ${lvlNow}`
  ].filter(Boolean).join(" · ");

  const normalizeLevel = x => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const groupRows = rows => {
    const map = new Map();
    rows.forEach(r => {
      const lvl = normalizeLevel(r.level);
      const key = lvl == null ? "_" : String(lvl);
      if (!map.has(key)) map.set(key, { level: lvl, names: [], descriptions: [], source: r.source });
      const g = map.get(key);
      if (r.name && !g.names.includes(r.name)) g.names.push(r.name);
      if (r.description && !g.descriptions.includes(r.description)) g.descriptions.push(r.description);
    });
    return [...map.values()].sort((a,b) => {
      if (a.level == null) return 1;
      if (b.level == null) return -1;
      return a.level - b.level;
    }).map(g => ({
      level: g.level,
      name: g.names.join(" · "),
      description: g.descriptions.join(" · "),
      source: g.source
    }));
  };

  const section = (title, rows, emptyText) => {
    const grouped = groupRows(rows);
    const many = grouped.length > 12 ? " dock-many" : "";
    return `
      <section class="dock-section">
        <h4>${esc(title)}</h4>
        <div class="dock-list${many}">
          ${grouped.length ? grouped.map(r => `
            <div class="dock-row ${r.level && r.level === lvlNow ? "dock-current" : ""}">
              <span class="dock-level">${r.level ? `L${esc(r.level)}` : "◆"}</span>
              <div class="dock-name"><b title="${esc(r.name)}">${esc(r.name)}</b></div>
            </div>`).join("") : `<div class="dock-empty">${esc(emptyText)}</div>`}
        </div>
      </section>`;
  };

  const raceRows = [
    ...(race.ability_scores ? Object.entries(race.ability_scores).map(([a,n]) =>
      ({name:`+${n} ${a}`,description:"ability score",source:raceLabel})) : []),
    ..._rewardItems(race.traits).map(r => ({...r,source:raceLabel})),
    ...(race.skill_proficiencies || []).map(s => ({name:`${s} proficiency`,source:raceLabel})),
  ];
  const subRows = subrace ? [
    ...(subrace.ability_scores ? Object.entries(subrace.ability_scores).map(([a,n]) =>
      ({name:`+${n} ${a}`,description:"ability score",source:subraceLabel})) : []),
    ..._rewardItems(subrace.traits).map(r => ({...r,source:subraceLabel})),
  ] : [];
  const clsRows = _rewardItems(cls?.features || cls?.features_by_level || cls?.level_rewards)
    .map(r => ({...r,source:classLabel}));
  const scRows = _rewardItems(subclass?.features || subclass?.features_by_level || subclass?.level_rewards)
    .map(r => ({...r,source:subclassLabel}));

  body.innerHTML =
    section(`${raceLabel} — ${race.name || "none"}`, raceRows, `No ${raceLabel.toLowerCase()} rewards loaded.`) +
    section(`${subraceLabel} — ${subrace?.name || "none selected"}`, subRows,
      subrace ? `No ${subraceLabel.toLowerCase()} rewards loaded.` : `This system has no ${subraceLabel.toLowerCase()} selected yet.`) +
    section(`${classLabel} — ${cls?.name || "none"}`, clsRows, `No ${classLabel.toLowerCase()} rewards loaded.`) +
    section(`${subclassLabel} — ${subclass?.name || "none selected"}`, scRows,
      subclass ? `No ${subclassLabel.toLowerCase()} rewards loaded.` : `Choose a ${subclassLabel.toLowerCase()} when this system offers one.`);
}

function refreshAcquireCount() {
  const el = $("#acquire-count");
  if (el) {
    const n = Object.values(S.prof).filter(v => v).length
      + S.spells.size + Object.keys(S.spellLevels).length;
    el.textContent = n ? `${n} acquired` : "what you gain, by level";
  }
  const p = $("#acquire-panel");
  if (p && p.style.display !== "none") renderAcquire();
  renderBuildDock();
}

function renderAcquire() {
  const list = $("#acquire-list");
  if (!list) return;

  const race = S.race || {};
  const subrace = S.subrace || null;
  const cls = S.class || {};
  const subclass = S.subclass || null;

  const col = (title, items, html) =>
    `<div class="acquire-col"><h5>${esc(title)}</h5>${
      items && items.length
        ? items.map(i => `<div class="aitem">${html(i)}</div>`).join("")
        : '<div class="empty">—</div>'
    }</div>`;

  // Race column: traits + skill proficiencies
  const raceItems = [
    ...(race.traits || []).map(t => t.name || t),
    ...(race.skill_proficiencies || []).map(s => `${s} (proficient)`),
  ];
  const raceCol = (race.name
    ? col("🩸 " + race.name, raceItems, i => `${esc(String(i))}`)
    : col("🩸 Race", null, i => ""));

  // Subrace column
  const subItems = (subrace && subrace.traits || []).map(t => t.name || t);
  const subCol = (subrace
    ? col("🧬 " + subrace.name, subItems, i => `${esc(String(i))}`)
    : col("🧬 Subrace", null, i => ""));

  // Class column: starting features + skill proficiencies
  const classSkillNames = (cls.skills || []).map(s => s.name).filter(Boolean);
  const classItems = [
    ...(cls.starting_features || []).map(f => f.name),
    ...classSkillNames,
  ];
  const classCol = (cls.name
    ? col("⚔ " + cls.name, classItems, i => `${esc(String(i))}`)
    : col("⚔ Class", null, i => ""));

  // Subclass column
  const subClassItems = subclass ? [subclass.description || "specialization"] : [];
  const subClassCol = (subclass
    ? col("🌀 " + subclass.name, subClassItems, i => `${esc(String(i))}`)
    : col("🌀 Subclass", null, i => ""));

  list.innerHTML = raceCol + subCol + classCol + subClassCol;

  const total = raceItems.length + subItems.length + classItems.length + subClassItems.length;
  $("#acquire-count").textContent = total ? `${total} tracked` : "what you gain, by level";
  renderBuildDock();
}

function updateRail() {
  const rail = $("#rail");
  if (!rail) return;
  [...rail.querySelectorAll("a")].forEach((a, j) => {
    a.classList.toggle("active", j === curStep);
    a.classList.toggle("done", j < curStep || isStepDone(j));
  });
}

let curStep = 0;
const stepCount = () => document.querySelectorAll(".step-panel").length;

function goStep(i) {
  if (i < 0) i = 0;
  const n = stepCount();
  if (i >= n) i = n - 1;
  curStep = i;
  document.querySelectorAll(".step-panel").forEach((p, j) =>
    p.classList.toggle("active", j === i));
  updateRail();
  $("#nav-back").style.visibility = i === 0 ? "hidden" : "visible";
  $("#nav-next").textContent = i === n - 1 ? "Done ✓" : "Next →";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function isStepDone(j) {
  // a step counts "done" if its key input is filled
  switch (j) {
    case 0: return !!S.system;
    case 1: return !!S.race;
    case 2: return !!S.class;
    case 3: return !!S.class;
    default: return false;
  }
}

function nextStep() {
  if (curStep === 0 && !S.system) return;   // must pick a system first
  if (curStep === stepCount() - 1) return;
  goStep(curStep + 1);
}
function prevStep() { goStep(curStep - 1); }

function bindEvents() {
  $("#nav-next").onclick = nextStep;
  /* ---- Skills & Build overview ------------------------------------- */
  const buildToggle = $("#build-toggle");
  const buildDock = $("#build-dock");
  const buildClose = $("#build-close");
  const setBuildOpen = open => {
    buildDock.classList.toggle("open", open);
    buildDock.setAttribute("aria-hidden", open ? "false" : "true");
    buildToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderBuildDock();
  };
  buildToggle.onclick = () => setBuildOpen(!buildDock.classList.contains("open"));
  buildClose.onclick = () => setBuildOpen(false);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && buildDock.classList.contains("open")) setBuildOpen(false); });
  $("#nav-back").onclick = prevStep;

  /* ---- Modal ---- */
  $("#modal-close").onclick = () => $("#modal-bg").classList.remove("show");
  $("#modal-bg").onclick = e => { if (e.target === $("#modal-bg")) closeModal(); };

  /* ---- kv / secrets ---- */
  $("#kv-add-btn").onclick = addKV;
  $("#agenda-add").onclick = () => addSecretRow("agenda-list");
  $("#secret-add").onclick = () => addSecretRow("secret-list");
  addSecretRow("agenda-list"); addSecretRow("secret-list");

  /* ---- manage (inventory / xp / messages / party) ---- */
  $("#mg-item-add").onclick = mgAddItem;
  $("#mg-xp-award").onclick = mgAwardXp;
  $("#mg-msg-send").onclick = mgSendMessage;
  $("#mg-whisper-send").onclick = mgWhisper;

  /* ---- save ---- */
  $("#save-btn").onclick = saveCharacter;

  /* ---- field wiring ---- */
  const _on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  _on("f-bg", "input", renderBackground);
  _on("f-level", "input", renderLevels);
}

/* ---------------------------------------------------------------------- */
/*  Modal                                                                 */
/* ---------------------------------------------------------------------- */
function modalOpen(html) { $("#modal-content").innerHTML = html; $("#modal-bg").classList.add("show"); }
function closeModal() { $("#modal-bg").classList.remove("show"); }

/* ---------------------------------------------------------------------- */
/*  Boot                                                                  */
/* ---------------------------------------------------------------------- */
async function boot() {
  buildStepDots();
  await loadGames();
  await refreshSavedStrip();
  renderPortraits();
}

async function loadGames() {
  const r = await fetch("/api/games");
  S.games = await r.json();
  renderSystemGrid();
  // pick dnd5e by default (the SRD-rich system) but don't auto-advance
  selectSystem("dnd5e");
}

function selectSystem(id) {
  S.system = S.games[id] || null;
  S.race = S.subrace = S.class = S.subclass = S.background = null;
  S.abilities = {};   // reset scores (points-buy & defaults re-seed below)
  renderSystemGrid();
  renderSystemNarrate();
  renderBuildDock();
  loadRules(id);
  loadCampaigns(id);
  renderAbilities();
}

async function loadRules(systemId) {
  S.rules = null;
  try {
    const kb = await (await fetch(`/api/rules/${encodeURIComponent(systemId)}`)).json();
    const has = (kb.skills || []).length || (kb.classes || []).length || (kb.races || []).length;
    S.rules = has ? kb : null;
  } catch (e) { S.rules = null; }
  // re-render anything that depends on rules
  if (S.system) renderRaceGrid(); renderClassGrid(); renderBuildDock();
}

async function loadCampaigns(systemId) {
  const sel = $("#f-campaign");
  try {
    S.campaigns = await (await fetch(`/api/campaigns?system=${encodeURIComponent(systemId)}`)).json();
  } catch (e) { S.campaigns = []; }
  const ai = S.campaigns.filter(c => c.ai_generated);
  const premade = S.campaigns.filter(c => !c.ai_generated);
  let html = '<option value="">— no campaign (open-ended) —</option>';
  html += '<optgroup label="✨ AI-generated (invented fresh)">';
  ai.forEach(c => html += `<option value="${esc(c.id)}">${esc(c.title)}</option>`);
  html += '</optgroup><optgroup label="📚 Premade / database campaigns">';
  premade.forEach(c => {
    const t = c.source === "5etools" ? " · 5etools" : (c.source === "local" ? " · local" : "");
    html += `<option value="${esc(c.id)}">${esc(c.title)}${t}</option>`;
  });
  html += "</optgroup>";
  sel.innerHTML = html;
  sel.onchange = () => {
    S.campaign = S.campaigns.find(c => c.id === sel.value) || null;
    renderCampaign();
  };
  S.campaign = null;
  renderCampaign();
}

/* ====================================================================== */
/*  System step                                                            */
/* ====================================================================== */
function renderSystemGrid() {
  const grid = $("#system-grid");
  const local = Object.values(S.games).filter(g => g.source === "local");
  const remote = Object.values(S.games).filter(g => g.source === "remote");
  grid.innerHTML = [...local, ...remote].map(g => {
    const sel = S.system && S.system.id === g.id;
    const badge = g.source === "remote"
      ? '<span class="oc-tag">online · DMs API</span>'
      : '<span class="oc-tag">local · games/*.json</span>';
    return `<div class="opt-card ${sel ? "selected" : ""}" onclick="selectSystem('${esc(g.id)}')">
      <div class="oc-name">${esc(g.label)}</div>
      <div class="oc-sub">${esc(g.genre || "")}</div>
      <div class="oc-perks">
        <div class="perk">${esc((g.tldr || g.description || "").slice(0, 70))}…</div>
      </div>
      ${badge}
    </div>`;
  }).join("");
}

function renderSystemNarrate() {
  const box = $("#system-narrate");
  const g = S.system;
  if (!g) { box.innerHTML = ""; return; }
  const links = [];
  const L = g.links || {};
  for (const rule of (Array.isArray(L.rules) ? L.rules : L.rules ? [L.rules] : [])) {
    links.push(`<div class="row"><span class="k">rules</span><span class="v">${linkify(rule)}</span></div>`);
  }
  if (L.wiki) links.push(`<div class="row"><span class="k">wiki</span><span class="v">${linkify(L.wiki)}</span></div>`);
  if (L.data_api) links.push(`<div class="row"><span class="k">data</span><span class="v">${linkify(L.data_api)}</span></div>`);
  box.innerHTML = `
    <h3><span class="ic">🧭</span> ${esc(g.label)}</h3>
    <p>${esc(g.tldr || g.description || "")}</p>
    ${links.join("") || ""}`;
}

function linkify(t) {
  t = esc(t);
  return t.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

/* ====================================================================== */
/*  Race step (narrated perks)                                             */
/* ====================================================================== */
function renderRaceGrid() {
  const grid = $("#race-grid");
  const f = (S.system && S.system.fields && S.system.fields.race) || {};
  const racesLabel = f.label || "Race";
  $("#lbl-race").textContent = racesLabel;

  // live SRD data wins (has traits/subraces); otherwise fall back to the
  // game profile's suggested list so selection ALWAYS works.
  const liveRaces = (S.rules && S.rules.races) || [];
  const flavor = (S.system && S.system.flavor && S.system.flavor.races) || {};
  let entries = liveRaces;
  if (!entries.length) {
    const sug = (f.suggestions || []).filter(s => s !== "Custom...");
    entries = sug.map(name => ({ name }));
  }

  if (!entries.length) {
    grid.innerHTML = `<p class="empty">No ${esc(racesLabel.toLowerCase())} data — enter a name below (free-form).</p>`;
    return;
  }

  grid.innerHTML = entries.map(r => {
    const sel = S.race && S.race.name === r.name;
    const asi = r.ability_scores
      ? Object.entries(r.ability_scores).map(([a, n]) => `+${n} ${a}`).join(", ")
      : null;
    const fl = flavor[r.name] || "";
    const perks = [
      r.speed ? `Speed ${r.speed}` : null,
      asi,
      (r.traits || []).slice(0, 2).map(t => t.name),
      fl,
    ].flat().filter(Boolean).slice(0, 4);
    return `<div class="opt-card ${sel ? "selected" : ""}" onclick="pickRace('${esc(r.name)}')">
      ${r.image ? `<img class="oc-img" src="${esc(r.image)}" alt="">` : ""}
      <div class="oc-name">${esc(r.name)}</div>
      <div class="oc-sub">${(r.subraces || []).length ? (r.subraces.length + " subraces") : (fl ? "see flavor" : "")}</div>
      <div class="oc-perks">${perks.map(p => `<div class="perk">${esc(p)}</div>`).join("")}</div>
    </div>`;
  }).join("");
}

function pickRace(name) {
  const live = (S.rules && S.rules.races || []).find(r => r.name === name);
  // merge in any curated offline profile data (race_data) when live is absent/thin
  const profData = (S.system && S.system.race_data || {})[name] || {};
  const r = live || { name };
  if (!r.skill_proficiencies && profData.skill_proficiencies) r.skill_proficiencies = profData.skill_proficiencies;
  if ((!r.traits || !r.traits.length) && profData.traits) {
    r.traits = profData.traits.map(t =>
      typeof t === "string" ? { name: t, description: "" } : t);
  }
  // subraces: live data wins; otherwise merge from curated subrace_data
  if (!r.subraces || !r.subraces.length) {
    const profSubs = (S.system && S.system.subrace_data || {})[name] || {};
    const subs = Object.entries(profSubs).map(([sn, sd]) => ({
      name: sn,
      traits: (sd.traits || []).map(t =>
        typeof t === "string" ? { name: t, description: "" } : t),
    }));
    if (subs.length) r.subraces = subs;
  }
  S.race = r;
  S.subrace = null;
  renderRaceGrid();
  renderRaceNarrate();
  renderSubrace();
  refreshAcquireCount();
  renderBuildDock();
}

function renderRaceNarrate() {
  const box = $("#race-narrate");
  const r = S.race;
  if (!r) { box.innerHTML = ""; return; }
  const asi = r.ability_scores
    ? Object.entries(r.ability_scores).map(([a, n]) => `<span class="chip"><span class="k">ASI</span>+${n} ${a}</span>`).join("")
    : "";
  const langs = (r.languages || []).join(", ");
  const traits = (r.traits || []).map(t =>
    `<li><b>${esc(t.name)}</b> — ${esc(t.description || "no description")}</li>`).join("");
  const skillProfs = (r.skill_proficiencies || []).map(s =>
    `<span class="chip"><span class="k">proficient</span>${esc(s)}</span>`).join("");
  const flavor = (S.system && S.system.flavor && S.system.flavor.races || {})[r.name] || "";
  box.innerHTML = `<h3><span class="ic">🩸</span> ${esc(r.name)}</h3>
    ${flavor ? `<p class="flavor">${esc(flavor)}</p>` : ""}
    ${r.speed || asi || langs || skillProfs ? `<div class="row">
      ${r.speed ? `<span class="chip"><span class="k">speed</span>${esc(r.speed)}</span>` : ""}
      ${asi}
      ${langs ? `<span class="chip"><span class="k">languages</span>${esc(langs)}</span>` : ""}
      ${skillProfs}
    </div>` : ""}
    ${traits ? `<ul>${traits}</ul>` : ""}
    ${r.skill_proficiencies && r.skill_proficiencies.length
      ? `<p class="hint" style="margin-top:8px">${esc(r.name)} grants skill/tool proficiencies above — they're added to your build automatically.</p>` : ""}`;
}

function renderSubrace() {
  const card = $("#subrace-card");
  const r = S.race;
  const subraces = (r && r.subraces) || [];
  if (!subraces.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  $("#subrace-grid").innerHTML = subraces.map(sr => {
    const sel = S.subrace && S.subrace.name === sr.name;
    const asi = sr.ability_scores
      ? Object.entries(sr.ability_scores).map(([a, n]) => `+${n} ${a}`).join(", ") : null;
    const perks = [asi, (sr.traits || []).slice(0, 2).map(t => t.name)].flat().filter(Boolean).slice(0, 3);
    return `<div class="opt-card ${sel ? "selected" : ""}" onclick="pickSubrace('${esc(sr.name)}')">
      <div class="oc-name">${esc(sr.name)}</div>
      <div class="oc-perks">${perks.map(p => `<div class="perk">${esc(p)}</div>`).join("")}</div>
    </div>`;
  }).join("");
  const box = $("#subrace-narrate");
  box.innerHTML = S.subrace
    ? `<h3><span class="ic">🧬</span> ${esc(S.subrace.name)}</h3>
       ${S.subrace.traits && S.subrace.traits.length
         ? `<ul>${S.subrace.traits.map(t => `<li><b>${esc(t.name)}</b> — ${esc(t.description || "")}</li>`).join("")}</ul>`
         : '<p class="empty">no additional traits listed</p>'}`
    : `<p class="empty">Pick a subrace to see what it adds.</p>`;
}
function pickSubrace(name) {
  S.subrace = (S.race.subraces || []).find(sr => sr.name === name);
  renderSubrace();
  refreshAcquireCount();
  renderBuildDock();
}

/* ====================================================================== */
/*  Class step (narrated lvl1 buffs)                                       */
/* ====================================================================== */
function renderClassGrid() {
  const grid = $("#class-grid");
  const f = (S.system && S.system.fields && S.system.fields.class) || {};
  const clsLabel = f.label || "Class";
  $("#lbl-class").textContent = clsLabel;

  // live SRD data wins; otherwise fall back to the profile's suggestions.
  const liveClasses = (S.rules && S.rules.classes) || [];
  const flavor = (S.system && S.system.flavor && S.system.flavor.classes) || {};
  let entries = liveClasses;
  if (!entries.length) {
    const sug = (f.suggestions || []).filter(s => s !== "Custom...");
    entries = sug.map(name => ({ name }));
  }

  if (!entries.length) {
    grid.innerHTML = `<p class="empty">No live ${esc(clsLabel.toLowerCase())} data — enter a name below (free-form).</p>`;
    return;
  }
  grid.innerHTML = entries.map(c => {
    const sel = S.class && S.class.name === c.name;
    const fl = flavor[c.name] || "";
    const perks = [
      c.hit_die ? `Hit die ${c.hit_die}` : null,
      c.saving_throws && c.saving_throws.length ? `Saves: ${c.saving_throws.join(", ")}` : null,
      (c.starting_features || []).slice(0, 2).map(f => f.name),
      fl,
    ].flat().filter(Boolean).slice(0, 4);
    return `<div class="opt-card ${sel ? "selected" : ""}" onclick="pickClass('${esc(c.name)}')">
      ${c.image ? `<img class="oc-img" src="${esc(c.image)}" alt="">` : ""}
      <div class="oc-name">${esc(c.name)}</div>
      <div class="oc-sub">${(c.subclasses || []).length ? (c.subclasses.length + " subclasses") : (fl ? "see flavor" : "")}</div>
      <div class="oc-perks">${perks.map(p => `<div class="perk">${esc(p)}</div>`).join("")}</div>
    </div>`;
  }).join("");
}

function pickClass(name) {
  const live = (S.rules && S.rules.classes || []).find(c => c.name === name);
  // merge curated offline profile data (class_data) when live is absent/thin
  const profData = (S.system && S.system.class_data || {})[name] || {};
  const c = live || { name };
  if (profData.spellcaster) {
    c.is_spellcaster = true;
    if (!c.spellcasting_ability) c.spellcasting_ability = c.spell_ability || "";
  }
  if ((!c.skills || !c.skills.length) && profData.skills) {
    c.skills = profData.skills.map(s => ({ name: s, choice: null, options: [] }));
  }
  if ((!c.features || !Object.keys(c.features).length) && profData.features) {
    c.features = {};
    Object.entries(profData.features).forEach(([lvl, names]) => {
      c.features[String(lvl)] = names.map(n => ({ name: n, description: "" }));
    });
    c.starting_features = c.features["1"] || [];
  }
  // subclasses: live data wins; otherwise merge curated subclass_data (list)
  if (!c.subclasses || !c.subclasses.length) {
    const profSubs = (S.system && S.system.subclass_data || {})[name] || [];
    if (Array.isArray(profSubs) && profSubs.length) c.subclasses = profSubs;
  }
  S.class = c;
  S.subclass = null;
  renderClassGrid();
  renderClassNarrate();
  renderAbilities();
  renderLevels();
  renderSubclass();
  renderBuildDock();
}

function renderClassNarrate() {
  const box = $("#class-narrate");
  const c = S.class;
  if (!c) { box.innerHTML = ""; return; }
  const flavor = (S.system && S.system.flavor && S.system.flavor.classes || {})[c.name] || "";
  const starting = c.starting_features || [];
  // class skill proficiencies may be fixed or "choose N from options"
  const skillChips = (c.skills || []).map(s => {
    if (s.choice != null && s.options && s.options.length) {
      return `<span class="chip"><span class="k">choose ${s.choice}</span>${esc(s.options.join(", "))}</span>`;
    }
    return s.name ? `<span class="chip"><span class="k">proficient</span>${esc(s.name)}</span>` : "";
  }).join("");
  const allSkills = (c.skills || []).map(s => s.name).filter(Boolean);
  box.innerHTML = `<h3><span class="ic">⚔</span> ${esc(c.name)}</h3>
    ${flavor ? `<p class="flavor">${esc(flavor)}</p>` : ""}`;
  const extra = c.hit_die || (c.saving_throws && c.saving_throws.length) || c.spellcasting_ability || skillChips
    ? `<div class="row">
      ${c.hit_die ? `<span class="chip"><span class="k">hit die</span>${esc(c.hit_die)}</span>` : ""}
      ${c.saving_throws && c.saving_throws.length ? `<span class="chip"><span class="k">saves</span>${esc(c.saving_throws.join(", "))}</span>` : ""}
      ${c.spellcasting_ability ? `<span class="chip"><span class="k">casting</span>${esc(c.spellcasting_ability)}</span>` : ""}
      ${skillChips}
    </div>` : "";
  box.innerHTML += extra;
  if (starting.length) {
    box.innerHTML += `<ul>${starting.map(f => `<li><b>${esc(f.name)}</b> — ${esc(f.description || "no description")}</li>`).join("")}</ul>`;
  }
  // level-by-level route preview (compact "what you build")
  const lvls = Object.keys(c.features || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (lvls.length) {
    box.innerHTML += `<details class="lvlrow" open style="margin-top:10px">
      <summary><span class="lvb">↗</span><span>What you gain by level</span></summary>
      <div class="feat">${lvls.map(l =>
        `<div><b>L${l}</b> — ${esc((c.features[String(l)] || []).map(f => f.name).join(", ") || "—")}</div>`
      ).join("")}</div>
    </details>`;
  } else if (allSkills.length) {
    box.innerHTML += `<p><b>Skill proficiencies:</b> ${esc(allSkills.join(", "))}</p>`;
  }
}

/* ====================================================================== */
/*  Abilities (shared by class step + manage)                              */
/* ====================================================================== */
function renderAbilities() {
  const g = S.system;
  const ab = (g && g.abilities) || { enabled: true, scores: STD6, default: 10 };
  const wrap = $("#ability-grid");
  const scores = ab.scores || [];
  if (!ab.enabled || !scores.length) {
    wrap.innerHTML = '<p class="empty">No fixed ability scores — use extra fields.</p>';
    $("#ab-points").style.display = "none";
    return;
  }
  const dflt = ab.default ?? 10, maxV = ab.max ?? 30, minV = ab.min ?? 1;
  const isStd6 = scores.length === 6 && scores.every((s, i) => s === STD6[i]);
  const byAb = skillsOnAbilities();

  // points-buy (D&D 5e style): per-score point cost table + a pool to spend
  const pb = ab.points_buy;
  const usePB = !!pb && pb.costs;
  if (usePB && !S.abilities._init) {
    // seed each score to the points-buy base so the +/- stepper is valid
    const base = pb.base ?? pb.lo ?? pb.min ?? 8;
    scores.forEach(k => { if (S.abilities[k] == null) S.abilities[k] = base; });
    S.abilities._init = true;
  }

  wrap.innerHTML = scores.map(k => {
    const cur = S.abilities[k] ?? dflt;
    const mod = isStd6 ? fmtMod(Math.floor((cur - 10) / 2)) : "";
    const skills = (byAb[k] || []).slice(0, 3).join(", ");

    if (usePB) {
      const spent = _pbSpent(pb, scores);
      const costNow = _pbCost(pb, cur), costNext = _pbCost(pb, cur + 1);
      const canUp = (cur < (pb.max ?? maxV)) && (costNext - costNow <= (pb.total - spent));
      const canDown = cur > (pb.min ?? pb.base ?? pb.lo ?? minV);
      return `<div class="ab-tile" data-ab="${esc(k)}">
        <div class="abname"><span>${esc(k)}</span><span>${ABILITY_ICONS[k] || "🎲"}</span></div>
        <div class="pb-stepper">
          <button onclick="abStep('${esc(k)}',-1)" ${canDown ? "" : "disabled"}>−</button>
          <span class="val">${cur}</span>
          <button onclick="abStep('${esc(k)}',+1)" ${canUp ? "" : "disabled"}>+</button>
        </div>
        <div class="modline">${isStd6 ? `mod <b>${mod}</b>` : ""}</div>
        <div class="skills-hint" title="${esc(skills)}">${esc(skills) || "—"}</div>
      </div>`;
    }

    return `<div class="ab-tile" data-ab="${esc(k)}">
      <div class="abname"><span>${esc(k)}</span><span>${ABILITY_ICONS[k] || "🎲"}</span></div>
      <input type="number" min="${minV}" max="${maxV}" value="${cur}"
             oninput="abInput('${esc(k)}', this.value)" onfocus="this.select()">
      <div class="modline">${isStd6 ? `mod <b>${mod}</b>` : `<i style="color:var(--faint)">${minV}–${maxV}</i>`}</div>
      <div class="skills-hint" title="${esc(skills)}">${esc(skills) || "—"}</div>
    </div>`;
  }).join("");

  // points meter
  const meter = $("#ab-points");
  if (usePB) {
    const spent = _pbSpent(pb, scores);
    const left = pb.total - spent;
    const pct = Math.max(0, Math.min(100, (spent / pb.total) * 100));
    meter.style.display = "flex";
    meter.className = "pb-meter" + (left < 0 ? " low" : "");
    meter.innerHTML = `<span>Points: <b>${left}</b> / ${pb.total} left</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="cost">${_pbRange(pb)}</span>`;
  } else {
    meter.style.display = "none";
  }

  $("#ab-hint").textContent = usePB
    ? `${g ? g.label : ""} points-buy — spend ${pb.total} points; each step has a cost (check the +/− buttons).`
    : isStd6
      ? "D&D-style modifiers shown for the standard six."
      : `${g ? g.label : ""} uses ${scores.length} scores (${minV}–${maxV}).`;
}

function _pbCost(pb, n) {
  const c = pb.costs;
  if (c && c[String(n)] != null) return c[String(n)];
  // fall back to a flat +1 per step above base
  return Math.max(0, n - (pb.base ?? pb.lo ?? 0));
}
function _pbSpent(pb, scores) {
  return scores.reduce((sum, k) => sum + _pbCost(pb, S.abilities[k] ?? (pb.base ?? 0)), 0);
}
function _pbRange(pb) {
  const ks = Object.keys(pb.costs || {}).map(Number).sort((a, b) => a - b);
  const lo = ks[0], hi = ks[ks.length - 1];
  const costLo = pb.costs[String(lo)], costHi = pb.costs[String(hi)];
  return lo != null && hi != null ? `${lo}→${hi} = ${costLo}…${costHi} pts` : "";
}

function abStep(k, dir) {
  const ab = (S.system && S.system.abilities) || {};
  const pb = ab.points_buy;
  if (!pb || !pb.costs) return;
  const cur = Math.round(S.abilities[k] ?? (pb.base ?? 0));
  const next = cur + dir;
  const min = pb.min ?? pb.base ?? pb.lo ?? 1;
  const max = pb.max ?? ab.max ?? 30;
  if (next < min || next > max) return;
  // budget check when increasing
  if (dir > 0) {
    const scores = ab.scores || [];
    const spent = _pbSpent(pb, scores);
    const delta = _pbCost(pb, next) - _pbCost(pb, cur);
    if (spent + delta > pb.total) return;
  }
  S.abilities[k] = next;
  renderAbilities();
}

function abInput(k, v) {
  const ab = (S.system && S.system.abilities) || {};
  const n = parseInt(v);
  if (!isNaN(n)) S.abilities[k] = Math.max(ab.min ?? 1, Math.min(ab.max ?? 30, n));
  renderAbilities();
}

function skillsOnAbilities() {
  const map = {};
  (S.rules && S.rules.skills || []).forEach(sk => {
    const full = { str: "strength", dex: "dexterity", con: "constitution",
                   int: "intelligence", wis: "wisdom", cha: "charisma" }[(sk.ability || "").toLowerCase().slice(0, 3)];
    if (full) (map[full] = map[full] || []).push(sk.name);
  });
  return map;
}

/* ====================================================================== */
/*  Skill tree                                                             */
/* ====================================================================== */
function renderLevels() {
  const body = $("#levels-body");
  const badge = $("#levels-class");
  const c = S.class;
  badge.textContent = (c && c.name) || "—";
  const casterCard = $("#caster-select-card");
  if (casterCard) {
    // only show spell/cantrip picker for spellcasting classes
    const isCaster = c && (c.is_spellcaster || c.spellcasting_ability);
    casterCard.style.display = isCaster ? "block" : "none";
    if (isCaster) renderCasterSelect(c);
  }
  if (!c || !c.features) {
    body.innerHTML = '<p class="empty">Pick a class (with live data) to see every feature level-by-level.</p>';
    renderTreeLevels([]);
    return;
  }
  const lvlNow = parseInt(val("f-level")) || 1;
  const feats = c.features || {};
  const keys = Object.keys(feats).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  body.innerHTML = keys.map(lvl => {
    const list = feats[String(lvl)] || [];
    return `<details class="lvlrow ${lvl === lvlNow ? "now" : ""}" ${lvl <= lvlNow ? "open" : ""}>
      <summary><span class="lvb">L${lvl}</span><span>${list.map(f => esc(f.name)).join(" · ") || "—"}</span></summary>
      <div class="feat">${list.map(f =>
        `<div><b>${esc(f.name)}</b>${f.prerequisite ? ` <span class="prereq">(req ${esc(f.prerequisite)})</span>` : ""}
        <p>${esc(f.description || "no description")}</p></div>`).join("")}</div>
    </details>`;
  }).join("") || '<p class="empty">no features in data source</p>';
  renderTreeLevels(keys);
}

function renderTreeLevels(keys) {
  const box = $("#tree-levels");
  const lvlNow = parseInt(val("f-level")) || 1;
  box.innerHTML = Array.from({ length: 20 }, (_, i) => i + 1).map(lvl => {
    const cls = keys.includes(lvl) ? "has" : "";
    const on = lvl === lvlNow ? "on" : "";
    return `<button class="${cls} ${on}" onclick="setLevel(${lvl})">${lvl}</button>`;
  }).join("");
}

function setLevel(lvl) {
  $("#f-level").value = lvl;
  renderLevels();
  renderBuildDock();
  $("#f-level").oninput = () => { renderLevels(); renderBuildDock(); };
}

/* ---------------------------------------------------------------------- */
/*  Spell / cantrip selection (spellcasting classes)                       */
/* ---------------------------------------------------------------------- */
// Spell-slot ladder for a "full" caster (bard/cleric/druid/sorcerer/wizard).
// Level N unlocks spell levels up to the ceiling below; the UI groups the
// picker by spell level and marks which unlock at the character's level.
const CASTER_LEVEL_UNLOCK = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4,
  9: 5, 10: 5, 11: 6, 12: 6, 13: 7, 14: 7, 15: 8, 16: 8, 17: 9, 18: 9,
  19: 9, 20: 9 };
// "half" casters (ranger/paladin) get spell levels at roughly half pace.
const HALF_CASTER_CLASSES = ["ranger", "paladin", "artificer"];
const THIRD_CASTER_CLASSES = ["eldritch knight", "arcane trickster"];

function casterProg(c) {
  const name = (c && c.name || "").toLowerCase();
  if (HALF_CASTER_CLASSES.some(h => name.includes(h))) return 0.5;
  if (THIRD_CASTER_CLASSES.some(t => name.includes(t))) return 0.33;
  // warlocks use pact magic — treat as full for UI purposes
  return 1;
}

function maxSpellLevelAt(charLevel, c) {
  const prog = casterProg(c);
  // non-full casters: round down the unlock ladder scaled by prog
  const scaleLvl = Math.max(1, Math.ceil(charLevel * prog));
  const base = CASTER_LEVEL_UNLOCK[Math.min(20, scaleLvl)] || 1;
  return base;
}

function renderCasterSelect(c) {
  const box = $("#caster-select-body");
  const badge = $("#caster-badge");
  const lvlNow = parseInt(val("f-level")) || 1;
  badge.textContent = `lvl ${lvlNow} · up to spell level ${maxSpellLevelAt(lvlNow, c)}`;
  const spells = (S.rules && S.rules.spells) || [];
  if (!spells.length) {
    box.innerHTML = '<p class="empty">No live spell data (offline) — list spells in the Proficiencies step.</p>';
    return;
  }
  // group by spell level; mark which groups are unlocked at lvlNow
  const groups = {};
  spells.forEach(sp => {
    const l = sp.level ?? 0;
    (groups[l] = groups[l] || []).push(sp);
  });
  const maxLvl = maxSpellLevelAt(lvlNow, c);
  const levels = Object.keys(groups).map(Number).sort((a, b) => a - b);
  box.innerHTML = levels.map(l => {
    const groupSpells = groups[l];
    const unlocked = l <= maxLvl;
    const lockTag = l === 0 ? "cantrips" : `level ${l}`;
    const lockNote = unlocked ? "" : `<span class="tag" style="color:var(--red)">locked</span>`;
    return `<details class="lvlrow" ${unlocked ? "open" : ""}>
      <summary><span class="lvb">${l === 0 ? "0" : l}</span><span>${esc(lockTag)} (${groupSpells.length}) ${lockNote}</span></summary>
      <div class="kb-list">${groupSpells.map(sp => {
        const known = S.spellLevels[sp.name] != null;
        const knownLvl = S.spellLevels[sp.name];
        return `<div class="kb-item">
          <div class="ti" onclick="lookupSpell('${esc(sp.name)}')">${esc(sp.name)}
            <span class="tag">${esc(sp.school || "")}</span>
            ${knownLvl ? `<span class="tag">@lvl${esc(knownLvl)}</span>` : ""}</div>
          <div class="act"><button class="${known ? "on" : ""}" ${unlocked ? "" : "disabled"}
            onclick="toggleCasterSpell('${esc(sp.name)}',${sp.level ?? 0},${lvlNow})">${known ? "✓" : "+"}</button></div>
          <div class="sub">${esc((sp.description || "").slice(0, 80))}</div>
        </div>`;
      }).join("")}</div>
    </details>`;
  }).join("");
}

function toggleCasterSpell(name, spellLevel, charLevel) {
  if (S.spellLevels[name] != null) {
    delete S.spellLevels[name];
    S.spells.delete(name);
  } else {
    S.spellLevels[name] = charLevel;     // level at which this was acquired
    if (spellLevel === 0) {
      S.spells.add(name);                 // cantrips count as known spells too
    } else {
      S.spells.add(name);
    }
  }
  renderCasterSelect(S.class);
  refreshAcquireCount();
}

/* ====================================================================== */
/*  Subclass                                                               */
/* ====================================================================== */
function renderSubclass() {
  const card = $("#subclass-card2");
  const c = S.class;
  const subclasses = (c && c.subclasses) || [];
  if (!subclasses.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  $("#subclass-grid").innerHTML = subclasses.map(sc => {
    const sel = S.subclass && S.subclass.name === sc.name;
    return `<div class="opt-card ${sel ? "selected" : ""}" onclick="pickSubclass('${esc(sc.name)}')">
      <div class="oc-name">${esc(sc.name)}</div>
      <div class="oc-perks"><div class="perk">${esc((sc.description || "").slice(0, 80))}</div></div>
    </div>`;
  }).join("");
  const b = $("#subclass-narrate");
  b.innerHTML = S.subclass
    ? `<h3><span class="ic">🌀</span> ${esc(S.subclass.name)}</h3><p>${esc(S.subclass.description || "no overview")}</p>`
    : '<p class="empty">Pick a subclass to see its overview.</p>';
}

function pickSubclass(name) {
  S.subclass = (S.class.subclasses || []).find(sc => sc.name === name);
  renderSubclass();
  refreshAcquireCount();
  renderBuildDock();
}

/* ====================================================================== */
/*  Proficiencies + spells                                                 */
/* ====================================================================== */
function renderSkills() {
  const wrap = $("#skills-body");
  if (!S.rules || !S.rules.skills.length) {
    wrap.innerHTML = '<p class="empty">No live skill data (offline) — add proficiencies below.</p>';
    return;
  }
  wrap.innerHTML = '<div class="kb-toolbar">' +
    '<input type="text" id="skill-filter" placeholder="filter skills…" oninput="renderSkillList()">' +
    '</div><div class="kb-list" id="skill-list"></div>';
  renderSkillList();
}
function renderSkillList() {
  const q = (val("skill-filter") || "").toLowerCase();
  const rows = S.rules.skills.filter(s => !q || s.name.toLowerCase().includes(q));
  $("#skill-list").innerHTML = rows.map(sk => {
    const p = S.prof[sk.name];
    return `<div class="kb-item">
      <div class="ti" onclick="lookupSkill('${esc(sk.name)}')">${esc(sk.name)}
        <span class="tag">${esc(sk.ability_label || sk.ability || "—")}</span></div>
      <div class="act">
        <button class="${p === "base" ? "on" : ""}" onclick="setProf('${esc(sk.name)}','base')">base</button>
        <button class="${p === "expert" ? "on" : ""}" onclick="setProf('${esc(sk.name)}','expert')">exp</button>
      </div>
      <div class="sub">${esc((sk.description || "").slice(0, 90))}</div>
    </div>`;
  }).join("") || '<p class="empty">no skills match</p>';
}
function setProf(name, lvl) {
  S.prof[name] = S.prof[name] === lvl ? "" : lvl;
  renderSkillList();
  refreshAcquireCount();
}

function renderSpells() {
  const wrap = $("#spells-body");
  if (!S.rules || !S.rules.spells.length) {
    wrap.innerHTML = '<p class="empty">No live spell data (offline) — list powers in Details → Equipment.</p>';
    return;
  }
  const schools = [...new Set(S.rules.spells.map(s => s.school).filter(Boolean))].sort();
  wrap.innerHTML = '<div class="kb-toolbar">' +
    `<input type="text" id="spell-filter" placeholder="search…" oninput="renderSpellList()">` +
    `<select id="spell-level" onchange="renderSpellList()"><option value="">any level</option>` +
    [0,1,2,3,4,5,6,7,8,9].map(n => `<option value="${n}">${n ? n : "cantrip"}</option>`).join("") + `</select>` +
    `<select id="spell-school" onchange="renderSpellList()"><option value="">any school</option>` +
    schools.map(s => `<option>${esc(s)}</option>`).join("") + `</select>` +
    `<label style="display:inline-flex;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="spell-known-only" onchange="renderSpellList()" style="width:auto"> known only</label>` +
    '</div><div class="kb-list" id="spell-list"></div>';
  renderSpellList();
}
function renderSpellList() {
  const q = (val("spell-filter") || "").toLowerCase();
  const lvl = $("spell-level").value, school = $("spell-school").value;
  const knownOnly = $("spell-known-only") && $("spell-known-only").checked;
  const rows = S.rules.spells.filter(s =>
    (!q || s.name.toLowerCase().includes(q)) &&
    (!lvl || String(s.level) === lvl) &&
    (!school || s.school === school) &&
    (!knownOnly || S.spells.has(s.name)));
  $("#spell-list").innerHTML = rows.slice(0, 120).map(sp => {
    const known = S.spells.has(sp.name);
    return `<div class="kb-item">
      <div class="ti" onclick="lookupSpell('${esc(sp.name)}')">${esc(sp.name)}
        <span class="tag">${esc(sp.level_name || sp.level)}</span><span class="tag">${esc(sp.school)}</span></div>
      <div class="act"><button class="${known ? "on" : ""}" onclick="toggleSpell('${esc(sp.name)}')">${known ? "✓" : "+"}</button></div>
      <div class="sub">${esc((sp.description || "").slice(0, 80))}</div>
    </div>`;
  }).join("") || '<p class="empty">no spells match</p>';
}
function toggleSpell(name) {
  S.spells.has(name) ? S.spells.delete(name) : S.spells.add(name);
  renderSpellList();
  refreshAcquireCount();
}

/* ====================================================================== */
/*  Background + campaign                                                  */
/* ====================================================================== */
function renderBackground() {
  const box = $("#bg-detail");
  const bgName = val("f-bg");
  const bg = (S.rules && S.rules.backgrounds || []).find(b => b.name.toLowerCase() === bgName.toLowerCase());
  if (!bg) { box.innerHTML = ""; return; }
  const skills = (bg.skills || []).map(s => s.name || (s.options || []).join(" / ")).filter(Boolean).join(", ");
  box.innerHTML = `<div class="worldnotes" style="border-left-color:var(--green)">
    <b style="color:var(--green)">${esc(bg.name)}</b>
    ${bg.description ? `<p>${esc(bg.description)}</p>` : ""}
    ${bg.features ? `<p><b>Feature:</b> ${esc(bg.features)}</p>` : ""}
    ${skills ? `<p><b>Skills:</b> ${esc(skills)}</p>` : ""}</div>`;
  S.background = bg || null;
}

function renderCampaign() {
  const c = S.campaign;
  $("#ai-seed-box").style.display = (c && c.ai_generated) ? "block" : "none";
  $("#camp-badge").textContent = c ? (c.source === "5etools" ? "5etools" : c.source === "local" ? "local" : "AI") : "";
  const box = $("#camp-detail");
  if (!c || c.id === "ai-generated") { box.innerHTML = ""; return; }
  const notes = c.world_notes ? `<div class="worldnotes">${esc(c.world_notes)}</div>`
    : (c.description ? `<div class="worldnotes" style="border-left-color:var(--line2)">${esc(c.description)}</div>` : "");
  box.innerHTML = `<div class="camp-meta">
      ${c.setting ? `<div class="row"><b>setting</b>${esc(c.setting)}</div>` : ""}
      ${c.tone ? `<div class="row"><b>tone</b>${esc(c.tone)}</div>` : ""}
      ${c.recommended_level ? `<div class="row"><b>levels</b>${esc(c.recommended_level)}</div>` : ""}
    </div>${notes}
    ${c.source === "5etools" ? `<button class="btn small" id="adv-load" onclick="loadAdventure('${esc(c.id)}')">📖 load full adventure</button><div id="adv-detail"></div>` : ""}`;
}

async function loadAdventure(id) {
  const slot = $("#adv-detail") || document.createElement("div");
  try {
    const r = await fetch(`/api/adventure/${encodeURIComponent(id)}`);
    const a = await r.json();
    if (!r.ok) throw new Error(a.error || "HTTP " + r.status);
    slot.innerHTML = `<div class="worldnotes" style="border-left-color:var(--purple)">
      <b style="color:var(--purple)">${esc(a.title)}</b> — ${(a.chapters || []).length} chapters · ${(a.npcs || []).length} NPCs
      ${a.url ? `<p><a href="${esc(a.url)}" target="_blank" rel="noopener">open on 5etools ↗</a></p>` : ""}</div>`;
  } catch (e) { slot.innerHTML = `<p class="empty">${esc(String(e))}</p>`; }
}

/* ====================================================================== */
/*  Portraits + kv + hidden items                                          */
/* ====================================================================== */
function renderPortraits() {
  $("#portrait").textContent = S.portrait;
  $("#portrait-pick").innerHTML = PORTRAITS.map(p =>
    `<button class="${p === S.portrait ? "on" : ""}" onclick="setPortrait('${p}')">${p}</button>`).join("");
}
function setPortrait(p) { S.portrait = p; renderPortraits(); }

function renderKV() {
  $("#kv-list").innerHTML = S.kv.map((kv, i) =>
    `<span class="chip"><span class="k">${esc(kv.k)}</span> ${esc(kv.v)}
      <span class="del" onclick="dropKV(${i})">✕</span></span>`).join("");
}
function dropKV(i) { S.kv.splice(i, 1); renderKV(); }
function addKV() {
  const k = val("kv-key"), v = val("kv-val");
  if (!k) return;
  S.kv.push({ k, v }); $("#kv-key").value = ""; $("#kv-val").value = "";
  renderKV();
}

function addSecretRow(listId, item) {
  const row = document.createElement("div");
  row.className = "secret-row";
  row.innerHTML = `<input type="text" placeholder="Title" value="${esc((item && item.title) || "")}">
    <textarea placeholder="Description" style="min-height:44px">${esc((item && item.description) || "")}</textarea>
    <button onclick="this.parentNode.remove()">✕</button>`;
  $(listId).appendChild(row);
}
function readSecretRows(id) {
  return [...document.querySelectorAll(`#${id} .secret-row`)].map(r => ({
    title: r.querySelector("input").value.trim(),
    description: r.querySelector("textarea").value.trim(),
    revealed: false,
  })).filter(s => s.title || s.description);
}

/* ====================================================================== */
/*  Lookups (modal)                                                        */
/* ====================================================================== */
function _byName(list, name) { return list.find(x => x.name.toLowerCase() === name.toLowerCase()); }
function lookupSkill(name) {
  const s = _byName(S.rules.skills || [], name);
  if (!s) return;
  modalOpen(`<h3>${esc(s.name)}</h3>
    <div class="msub">${esc(s.ability_label || s.ability || "")} · ${esc(s.sourcebook || "SRD")}</div>
    <p>${esc(s.description || "no description")}</p>`);
}
function lookupSpell(name) {
  const s = _byName(S.rules.spells || [], name);
  if (!s) return;
  const comps = [s.verbal && "V", s.somatic && "S", s.material && "M"].filter(Boolean).join(",");
  modalOpen(`<h3>${esc(s.name)}</h3>
    <div class="msub">${esc(s.level_name || s.level)} · ${esc(s.school)}</div>
    <div class="facts">
      ${s.time ? `<span class="chip"><span class="k">cast</span>${esc(s.time)}</span>` : ""}
      ${s.range ? `<span class="chip"><span class="k">range</span>${esc(s.range)}</span>` : ""}
      ${s.duration ? `<span class="chip"><span class="k">dur</span>${esc(s.duration)}</span>` : ""}
      ${comps ? `<span class="chip"><span class="k">comp</span>${esc(comps)}</span>` : ""}
    </div>
    <p>${esc(s.description || "no description")}</p>`);
}

/* ====================================================================== */
/*  Collect + save                                                         */
/* ====================================================================== */
function collect() {
  const g = S.system, ab = (g && g.abilities) || {};
  const abilities = {};
  const abBase = (ab.points_buy && ab.points_buy.base) ?? ab.default ?? 10;
  (ab.scores || []).forEach(k => abilities[k] = S.abilities[k] ?? abBase);

  const profNames = Object.keys(S.prof).filter(k => S.prof[k]);
  const skillsText = [...profNames.map(k => `${k} (${S.prof[k]})`), val("f-skills-extra")].filter(Boolean).join(", ");
  const spellsText = [...S.spells].join(", ");

  const campaign = {};
  if (S.campaign) {
    campaign.id = S.campaign.id;
    if (S.campaign.id === "ai-generated") {
      campaign.title = val("ai-title") || "";
      campaign.seed = val("ai-seed");
      campaign.tone = "";
    }
  }

  const custom = {};
  S.kv.forEach(kv => { if (kv.k) custom[kv.k] = kv.v; });

  // identity knows race/class/subrace/subclass (as free-form strings the
  // sheet already supports) — plus our richer picks via details.custom
  custom.race_detail = S.race ? S.race.name : "";
  if (S.subrace) custom.subrace = S.subrace.name;
  custom.class_detail = S.class ? S.class.name : "";
  if (S.subclass) custom.subclass = S.subclass.name;
  if (S.background && S.background.name) custom.background = S.background.name;

  // ---- build record: race/class picks + every level-up upgrade ----
  const race = S.race || {};
  const cls = S.class || {};
  const rulesSpells = (S.rules && S.rules.spells) || [];
  const knownSpells = [...S.spells];
  const build = {
    race_traits: (race.traits || []).map(t => t.name),
    race_skills: (race.skill_proficiencies || []).slice(),
    class_features_by_level: cls.features || {},
    proficiencies: Object.entries(S.prof)
      .filter(([, v]) => v)
      .map(([skill, lvl]) => ({ skill, level: lvl })),
    spells: knownSpells.map(name => ({
      name, level: S.spellLevels[name] != null ? S.spellLevels[name] : 0,
    })),
    cantrips: knownSpells.filter(name => {
      const sp = rulesSpells.find(s => s.name === name);
      return sp && sp.level === 0;
    }).map(name => ({ name, acquired_at: S.spellLevels[name] || 1 })),
  };

  return {
    system: S.system ? S.system.id : "dnd5e",
    visibility: { hidden_revealed: $("#h-revealed").checked },
    campaign,
    build,
    identity: {
      name: val("f-name"), race: S.race ? S.race.name : val("f-race"),
      class: S.class ? S.class.name : val("f-class"),
      level: parseInt(val("f-level")) || 1, gender: val("f-gender"),
      age: val("f-age"), appearance: val("f-appearance"),
      player_name: val("f-player"), portrait: S.portrait,
    },
    abilities: { ...abilities, notes: val("f-abil-notes") },
    background: { seed: val("f-bg"), summary: val("f-bgs"), details: val("f-bgdetail") },
    details: {
      personality: val("f-personality"), goals: val("f-goals"),
      fears_flaws: val("f-flaws"), traits: val("f-traits"),
      alignment: val("f-align"), skills: skillsText,
      equipment: val("f-equipment"), spells: spellsText,
      languages: val("f-languages"), custom,
    },
    public: {
      known_identity: val("p-identity"), known_backstory: val("p-backstory"),
      known_relationships: val("p-relations"), known_items: val("p-items"),
      rumors: val("p-rumors"),
    },
    hidden: {
      hidden_agendas: readSecretRows("agenda-list"),
      secrets: readSecretRows("secret-list"),
      dm_notes: val("h-dmnotes"),
    },
  };
}

async function saveCharacter() {
  const btn = $("#save-btn"), msg = $("#save-msg");
  btn.disabled = true; msg.className = ""; msg.textContent = "Saving…";
  try {
    const payload = collect();
    if (!payload.identity.name) {
      msg.className = "err"; msg.textContent = "Give your character a name.";
      btn.disabled = false; return;
    }
    const r = await fetch("/api/characters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const sheet = await r.json();
    if (!r.ok) throw new Error(sheet.error || "HTTP " + r.status);
    S.loadedId = sheet.id;
    msg.className = "ok";
    msg.textContent = `Saved → char_sheet_${sheet.id}.json — load it from the top-right chip to manage it.`;
    $("#preview").style.display = "block";
    $("#preview").textContent = JSON.stringify(sheet, null, 2);
    await refreshSavedStrip();
  } catch (e) {
    msg.className = "err"; msg.textContent = "Error: " + e;
  }
  btn.disabled = false;
}

/* ====================================================================== */
/*  Saved character strip + load                                           */
/* ====================================================================== */
async function refreshSavedStrip() {
  const strip = $("#saved-strip");
  try {
    const list = await (await fetch("/api/characters")).json();
    strip.innerHTML = list.map(c =>
      `<span class="chip" onclick="loadSheet('${esc(c.id)}')" title="load & manage">
        <b>${esc(c.name || "?")}</b> ${esc(c.system_label || "")}
        <span class="del" onclick="event.stopPropagation();deleteSheet('${esc(c.id)}')">✕</span>
      </span>`).join("");
  } catch (e) { strip.innerHTML = ""; }
}

async function loadSheet(id) {
  try {
    const s = await (await fetch(`/api/characters/${id}`)).json();
    S.loadedId = id;
    fillFromSheet(s);
    goStep(8);   // jump to Manage step
  } catch (e) { alert("load failed: " + e); }
}

function fillFromSheet(s) {
  // identity
  $("#f-name").value = (s.identity || {}).name || "";
  $("#f-player").value = (s.identity || {}).player_name || "";
  S.portrait = (s.identity || {}).portrait || "🧙";
  S.race = { name: (s.identity || {}).race || "" };
  S.class = { name: (s.identity || {}).class || "" };
  renderPortraits();
  // system + rules
  if (s.system && S.games[s.system]) { selectSystem(s.system); }
  // abilities
  S.abilities = Object.assign({}, s.abilities || {});
  delete S.abilities.notes; delete S.abilities.modifiers;
  $("#f-abil-notes").value = (s.abilities || {}).notes || "";
  // details
  $("#f-bg").value = (s.background || {}).seed || "";
  $("#f-bgs").value = (s.background || {}).summary || "";
  $("#f-bgdetail").value = (s.background || {}).details || "";
  $("#f-personality").value = (s.details || {}).personality || "";
  $("#f-goals").value = (s.details || {}).goals || "";
  $("#f-flaws").value = (s.details || {}).fears_flaws || "";
  $("#f-traits").value = (s.details || {}).traits || "";
  $("#f-align").value = (s.details || {}).alignment || "";
  $("#f-appearance").value = (s.identity || {}).appearance || "";
  $("#f-gender").value = (s.identity || {}).gender || "";
  $("#f-age").value = (s.identity || {}).age || "";
  $("#f-equipment").value = (s.details || {}).equipment || "";
  $("#f-languages").value = (s.details || {}).languages || "";
  $("#f-skills-extra").value = (s.details || {}).skills || "";
  $("#f-level").value = (s.identity || {}).level || 1;
  S.kv = Object.entries((s.details || {}).custom || {}).map(([k, v]) => ({ k, v })).filter(({k}) => !["race_detail","subrace","class_detail","subclass","background"].includes(k));
  // public/hidden
  $("#p-identity").value = (s.public || {}).known_identity || "";
  $("#p-backstory").value = (s.public || {}).known_backstory || "";
  $("#p-relations").value = (s.public || {}).known_relationships || "";
  $("#p-items").value = (s.public || {}).known_items || "";
  $("#p-rumors").value = (s.public || {}).rumors || "";
  $("#h-dmnotes").value = (s.hidden || {}).dm_notes || "";
  $("#h-revealed").checked = (s.visibility || {}).hidden_revealed || false;
  $("#agenda-list").innerHTML = ""; (s.hidden || {}).hidden_agendas?.forEach(a => addSecretRow("agenda-list", a));
  $("#secret-list").innerHTML = ""; (s.hidden || {}).secrets?.forEach(a => addSecretRow("secret-list", a));
  S.spells = new Set(((s.details || {}).spells || "").split(",").map(x => x.trim()).filter(Boolean));
  // restore build state (spell levels, proficiencies) from the saved sheet
  S.spellLevels = {};
  (s.build && s.build.spells || []).forEach(sp => {
    if (sp.name) { S.spells.add(sp.name); S.spellLevels[sp.name] = sp.level; }
  });
  S.prof = (s.build && s.build.proficiencies || []).reduce((m, p) => { m[p.skill] = p.level; return m; }, {});
  renderKV();
  // live manage panels
  renderManage(s);
}

/* ====================================================================== */
/*  Manage step (live character view)                                      */
/* ====================================================================== */
function renderManage(s) {
  $("#manage-empty-card").style.display = "none";
  $("#manage-body").style.display = "block";
  const iden = s.identity || {}, det = s.details || {}, prog = s.progression || {};

  $("#mg-name").textContent = iden.name || "?";
  $("#mg-system").textContent = s.system_label || s.system || "";
  $("#mg-level").textContent = "level " + (iden.level || 1);
  $("#mg-chips").innerHTML = [
    iden.race ? `<span class="chip"><span class="k">race</span>${esc(iden.race)}</span>` : "",
    iden.class ? `<span class="chip"><span class="k">class</span>${esc(iden.class)}</span>` : "",
    det.alignment ? `<span class="chip"><span class="k">align</span>${esc(det.alignment)}</span>` : "",
    s.campaign && s.campaign.title ? `<span class="chip"><span class="k">campaign</span>${esc(s.campaign.title)}</span>` : "",
  ].join("");

  // stats (read-only tiles)
  const ab = s.abilities || {};
  const scores = Object.keys(ab).filter(k => !["notes", "modifiers"].includes(k));
  const mods = ab.modifiers || {};
  $("#mg-abilities").innerHTML = scores.map(k => {
    const mod = mods[k] != null ? fmtMod(mods[k]) : "";
    return `<div class="ab-tile"><div class="abname"><span>${esc(k)}</span><span>${ABILITY_ICONS[k] || "🎲"}</span></div>
      <div class="modline" style="font-size:26px;color:var(--gold2)"><b>${esc(String(ab[k]))}</b></div>
      <div class="modline">${mod ? `mod ${mod}` : ""}</div></div>`;
  }).join("") || '<p class="empty">no ability scores</p>';

  // buffs = race traits + class lvl1 features + level features up to current
  const buffs = [];
  if (S.rules && S.race) {
    const r = S.rules.races.find(x => x.name.toLowerCase() === (S.race.name || "").toLowerCase());
    (r && r.traits || []).forEach(t => buffs.push({ src: "race", name: t.name, desc: t.description }));
  }
  if (S.rules && S.class) {
    const c = S.rules.classes.find(x => x.name.toLowerCase() === (S.class.name || "").toLowerCase());
    const lvl = parseInt(iden.level) || 1;
    Object.entries(c && c.features || {}).forEach(([l, fs]) => {
      if (parseInt(l) <= lvl) (fs || []).forEach(f => buffs.push({ src: `L${l}`, name: f.name, desc: f.description }));
    });
  }
  $("#mg-buffs").innerHTML = buffs.length
    ? `<div class="kb-list">${buffs.map(b => `<div class="kb-item">
        <div class="ti">${esc(b.name)} <span class="tag">${esc(b.src)}</span></div>
        <div class="sub">${esc((b.desc || "").slice(0, 120))}</div></div>`).join("")}</div>`
    : '<p class="empty">no buffs/features resolved (needs live rules data)</p>';

  // inventory
  renderInventory(s.inventory || []);

  // progression
  $("#mg-level-val").textContent = iden.level || 1;
  $("#mg-xp-val").textContent = prog.xp || 0;
  const table = (S.games[s.system] || {}).progression?.xp_levels || [];
  const next = table.find(t => t > (prog.xp || 0));
  $("#mg-xp-next").textContent = next != null ? `next level at ${next} xp` : "max level";

  // messages
  renderMessages(s.hidden || {});

  // party (other characters) — async, no need to block
  loadParty(s.id);
}

async function loadParty(sheetId) {
  const badge = $("#mg-party-badge");
  try {
    S.party = await (await fetch(`/api/characters/${sheetId}/party`)).json();
  } catch (e) { S.party = []; }
  badge.textContent = `${S.party.length} other`;
  S.whisperTarget = null;
  renderParty();
}

function renderParty() {
  const box = $("#mg-party");
  if (!S.party.length) {
    box.innerHTML = '<p class="empty">no other characters saved yet — create more sheets to enable whispers.</p>';
    return;
  }
  box.innerHTML = S.party.map(p =>
    `<div class="opt-card ${S.whisperTarget === p.id ? "selected" : ""}" onclick="pickWhisperTarget('${esc(p.id)}')">
      <div class="oc-name">${esc(p.portrait)} ${esc(p.name || "?")}</div>
      <div class="oc-sub">${esc(p.race || "")}${p.race && p.class ? " · " : ""}${esc(p.class || "")}${p.level ? ` · level ${p.level}` : ""}</div>
      ${p.player ? `<div class="oc-sub" style="color:var(--muted)">played by ${esc(p.player)}</div>` : ""}
    </div>`).join("");
}

function pickWhisperTarget(id) {
  S.whisperTarget = id;
  renderParty();
  const target = S.party.find(p => p.id === id);
  $("#mg-whisper-text").placeholder = target
    ? `whisper to ${target.name}…` : "private note to send…";
}

async function mgWhisper() {
  if (!S.loadedId) return;
  if (!S.whisperTarget) {
    $("#mg-whisper-msg").textContent = "pick a party member first";
    $("#mg-whisper-msg").style.color = "var(--red)";
    return;
  }
  const text = val("mg-whisper-text");
  if (!text) return;
  const r = await fetch(`/api/characters/${S.loadedId}/whisper`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: S.whisperTarget, text, kind: "whisper" }),
  });
  const res = await r.json();
  const msgEl = $("#mg-whisper-msg");
  if (r.ok) {
    msgEl.textContent = "whispered ✓";
    msgEl.style.color = "var(--green)";
  } else {
    msgEl.textContent = "error: " + (res.error || r.status);
    msgEl.style.color = "var(--red)";
  }
  $("#mg-whisper-text").value = "";
}

function renderInventory(inv) {
  const box = $("#mg-inventory");
  box.innerHTML = inv.map((it, i) =>
    `<span class="chip">${esc(it.name)}${it.qty > 1 ? ` <b>x${it.qty}</b>` : ""}
      <span class="del" onclick="removeItem(${i})">✕</span></span>`).join("") ||
    '<span class="empty">empty</span>';
}
async function mgAddItem() {
  const name = val("mg-item-name");
  if (!name || !S.loadedId) return;
  await fetch(`/api/characters/${S.loadedId}/inventory`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, qty: parseInt(val("mg-item-qty")) || 1 }),
  });
  $("#mg-item-name").value = "";
  reloadLoaded();
}
async function removeItem(index) {
  if (!S.loadedId) return;
  await fetch(`/api/characters/${S.loadedId}/inventory/${index}`, { method: "DELETE" });
  reloadLoaded();
}

async function mgAwardXp() {
  if (!S.loadedId) return;
  const amt = parseInt(val("mg-xp-amount")) || 0;
  const r = await fetch(`/api/characters/${S.loadedId}/xp`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amt }),
  });
  const res = await r.json();
  $("#mg-xp-msg").textContent = res.leveled_up ? `🎉 leveled up to ${res.level}!` : `xp ${res.xp}`;
  $("#mg-xp-msg").style.color = res.leveled_up ? "var(--green)" : "var(--muted)";
  reloadLoaded();
}

async function mgSendMessage() {
  if (!S.loadedId) return;
  const text = val("mg-msg-text");
  if (!text) return;
  await fetch(`/api/characters/${S.loadedId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, from: "DM", kind: "note" }),
  });
  $("#mg-msg-text").value = "";
  reloadLoaded();
}

function renderMessages(hidden) {
  const msgs = hidden.messages || [];
  const unread = msgs.filter(m => !m.read).length;
  $("#mg-msg-badge").textContent = `${msgs.length} msg${msgs.length === 1 ? "" : "s"}` + (unread ? ` · ${unread} unread` : "");
  $("#mg-messages").innerHTML = msgs.slice().reverse().map(m => {
    const ico = m.kind === "levelup" ? "🎉" : (m.kind === "whisper" ? "🗣" : "🕯");
    const who = m.kind === "whisper" && m.to ? `→ ${esc(m.to)}` : "";
    return `<div class="kb-item" onclick="markRead('${esc(m.id)}')" style="${m.read ? "opacity:.55" : ""}">
      <div class="ti">${ico} <b>${esc(m.from)}</b> ${who}
        <span class="tag">${esc(m.kind)}</span>${m.read ? "" : ' <span class="tag" style="color:var(--gold)">new</span>'}</div>
      <div class="sub">${esc(m.text)} <i style="color:var(--faint)">— ${esc((m.created_at || "").slice(0, 16))}</i></div>
    </div>`;
  }).join("") || '<p class="empty">no hidden messages yet</p>';
}
async function markRead(id) {
  if (!S.loadedId) return;
  await fetch(`/api/characters/${S.loadedId}/messages/${id}/read`, { method: "POST" });
  reloadLoaded();
}

async function reloadLoaded() {
  if (!S.loadedId) return;
  const s = await (await fetch(`/api/characters/${S.loadedId}`)).json();
  renderManage(s);
}

async function deleteSheet(id) {
  if (!confirm("Delete this character sheet?")) return;
  await fetch(`/api/characters/${id}`, { method: "DELETE" });
  if (S.loadedId === id) { S.loadedId = null; $("#manage-body").style.display = "none"; $("#manage-empty-card").style.display = "block"; }
  refreshSavedStrip();
}

/* ---- boot on DOM ready -------------------------------------------------- */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { bindEvents(); boot(); });
} else {
  bindEvents();
  boot();
}