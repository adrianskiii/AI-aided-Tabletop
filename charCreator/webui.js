(() => {
  "use strict";

  const $ = selector =>
    typeof selector === "string"
      ? document.querySelector(
          selector.startsWith("#") ||
          selector.startsWith(".") ||
          selector.startsWith("[")
            ? selector
            : `#${selector}`
        )
      : selector || null;

  const $$ = selector =>
    Array.from(
      document.querySelectorAll(selector)
    );

  const safeArray = value =>
    Array.isArray(value)
      ? value
      : [];

  const clone = value => {
    if (value == null) return value;
    try {
      return JSON.parse(
        JSON.stringify(value)
      );
    } catch {
      return value;
    }
  };

  const numberOr = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? number
      : fallback;
  };

  const val = id => {
    const element = $(
      id.startsWith("#")
        ? id
        : `#${id}`
    );

    return element?.value ?? "";
  };

  const esc = value =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const titleCase = value =>
    String(value ?? "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, c =>
        c.toUpperCase()
      );

  const slugify = value =>
    String(value ?? "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const PORTRAITS = [
    "🧙",
    "🧝",
    "🧛",
    "🧟",
    "🧞",
    "🧜",
    "🧚",
    "🧑‍🚀",
    "🧑‍🔬",
    "🧑‍🎤",
    "🧑‍🌾",
    "🧑‍🏫",
    "🗡️",
    "🛡️",
    "🐉",
    "👤"
  ];

  const ABILITY_ICONS = {
    strength: "💪",
    dexterity: "🏃",
    constitution: "❤️",
    intelligence: "🧠",
    wisdom: "👁️",
    charisma: "✨"
  };

  const S = {
    games: {},
    campaigns: [],
    rules: null,
    system: null,
    campaign: null,

    choices: {},
    selections: {
      skills: {},
      spells: new Set(),
      feats: new Set(),
      items: new Set(),
      talents: new Set()
    },

    abilities: {},
    abilityMeta: {},
    abilityMetaInitialized: false,

    prof: {},
    spells: new Set(),
    spellLevels: {},
    resources: {},

    portrait: "🧙",
    kv: [],

    loadedId: null,
    party: [],
    whisperTarget: null,

    step: 0,
    pendingSheet: null,
    currentSheet: null,

    loadToken: 0,
    rulesToken: 0
  };

  function normalizeResponseData(data) {
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data)
    ) {
      if (
        data.data &&
        typeof data.data === "object"
      ) {
        return data.data;
      }

      if (
        data.rules &&
        typeof data.rules === "object"
      ) {
        return data.rules;
      }
    }

    return data;
  }

  async function getJSON(url, options = {}) {
    const response =
      await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body
            ? {
                "Content-Type":
                  "application/json"
              }
            : {}),
          ...(options.headers || {})
        }
      });

    const text =
      await response.text();

    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof data === "object" &&
        data?.error
          ? data.error
          : typeof data === "string" &&
            data.trim()
            ? data
            : `${response.status} ${response.statusText}`;

      throw new Error(message);
    }

    return normalizeResponseData(data);
  }

  async function postJSON(url, payload) {
    return getJSON(url, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  function normalizeSystem(system, id) {
    if (!system) {
      return {
        id,
        name: id,
        label: id
      };
    }

    if (typeof system === "string") {
      return {
        id,
        name: system,
        label: system
      };
    }

    return {
      ...system,
      id:
        system.id ||
        id,
      name:
        system.name ||
        system.label ||
        id,
      label:
        system.label ||
        system.name ||
        id
    };
  }

  function normalizeEntity(entity, type = "") {
    if (!entity) return null;

    if (typeof entity === "string") {
      return {
        id: slugify(entity),
        name: entity,
        type
      };
    }

    const result = {
      ...entity
    };

    result.id =
      entity.id ??
      entity.key ??
      entity.uid ??
      entity.slug ??
      entity.name ??
      `${type}-${Math.random()}`;

    result.name =
      entity.name ??
      entity.label ??
      entity.title ??
      result.id;

    if (type && !result.type) {
      result.type = type;
    }

    if (
      !result.description &&
      result.desc
    ) {
      result.description =
        result.desc;
    }

    return result;
  }

  function normalizeEntityList(
    value,
    type
  ) {
    if (Array.isArray(value)) {
      return value
        .map(item =>
          normalizeEntity(item, type)
        )
        .filter(Boolean);
    }

    if (
      value &&
      typeof value === "object"
    ) {
      return Object.entries(value)
        .map(([key, item]) => {
          if (
            item &&
            typeof item === "object"
          ) {
            return normalizeEntity(
              {
                ...item,
                id:
                  item.id ??
                  key
              },
              type
            );
          }

          return normalizeEntity(
            {
              id: key,
              name: String(item ?? key)
            },
            type
          );
        })
        .filter(Boolean);
    }

    return [];
  }

  function legacyComponents(source) {
    const components = {};

    const mappings = {
      ancestry: [
        "ancestry",
        "ancestries",
        "race",
        "races"
      ],
      heritage: [
        "heritage",
        "heritages",
        "subrace",
        "subraces"
      ],
      class: [
        "class",
        "classes"
      ],
      subclass: [
        "subclass",
        "subclasses"
      ],
      background: [
        "background",
        "backgrounds"
      ],
      skill: [
        "skill",
        "skills"
      ],
      spell: [
        "spell",
        "spells",
        "power",
        "powers"
      ],
      feat: [
        "feat",
        "feats"
      ],
      item: [
        "item",
        "items"
      ],
      condition: [
        "condition",
        "conditions"
      ],
      damage: [
        "damage",
        "damages"
      ],
      talent: [
        "talent",
        "talents"
      ]
    };

    Object.entries(
      mappings
    ).forEach(
      ([canonical, keys]) => {
        for (const key of keys) {
          if (
            source[key] != null
          ) {
            const rows =
              normalizeEntityList(
                source[key],
                canonical
              );

            if (rows.length) {
              components[canonical] =
                rows;
              break;
            }
          }
        }
      }
    );

    return components;
  }

  function mergeNestedComponents(
    components
  ) {
    const output = {
      ...components
    };

    const classes =
      output.class || [];

    const subclasses =
      output.subclass || [];

    classes.forEach(cls => {
      const parentId =
        getEntityId(cls);

      safeArray(
        cls.subclasses
      ).forEach(subclass => {
        const entity =
          normalizeEntity(
            {
              ...subclass,
              parent_id:
                subclass.parent_id ??
                subclass.class_id ??
                parentId,
              class_id:
                subclass.class_id ??
                parentId
            },
            "subclass"
          );

        if (
          entity &&
          !subclasses.some(
            existing =>
              getEntityId(existing) ===
              getEntityId(entity)
          )
        ) {
          subclasses.push(entity);
        }
      });
    });

    if (subclasses.length) {
      output.subclass =
        subclasses;
    }

    const ancestries =
      output.ancestry || [];

    const heritages =
      output.heritage || [];

    ancestries.forEach(ancestry => {
      const parentId =
        getEntityId(ancestry);

      safeArray(
        ancestry.subraces
      ).concat(
        safeArray(
          ancestry.heritages
        )
      ).forEach(heritage => {
        const entity =
          normalizeEntity(
            {
              ...heritage,
              parent_id:
                heritage.parent_id ??
                heritage.ancestry_id ??
                parentId,
              ancestry_id:
                heritage.ancestry_id ??
                parentId
            },
            "heritage"
          );

        if (
          entity &&
          !heritages.some(
            existing =>
              getEntityId(existing) ===
              getEntityId(entity)
          )
        ) {
          heritages.push(entity);
        }
      });
    });

    if (heritages.length) {
      output.heritage =
        heritages;
    }

    return output;
  }

  function normalizeRules(raw) {
    const source =
      raw &&
      typeof raw === "object"
        ? raw
        : {};

    const components = {
      ...legacyComponents(source),
      ...(source.components || {})
    };

    Object.keys(components)
      .forEach(type => {
        components[type] =
          normalizeEntityList(
            components[type],
            type
          );
      });

    const merged =
      mergeNestedComponents(
        components
      );

    const system =
      normalizeSystem(
        source.system ||
          source.game ||
          source.metadata?.system,
        source.system_id ||
          source.id ||
          S.system?.id ||
          ""
      );

    const abilities =
      safeArray(
        source.abilities
      ).length
        ? safeArray(
            source.abilities
          ).map(item => {
            if (
              typeof item ===
              "string"
            ) {
              return {
                id: slugify(item),
                name: item,
                type: "numeric"
              };
            }

            return {
              id:
                item.id ??
                slugify(
                  item.name
                ),
              name:
                item.name ??
                item.label ??
                item.id,
              type:
                item.type ||
                "numeric",
              default:
                item.default ??
                0,
              min:
                item.min,
              max:
                item.max,
              formula:
                item.formula,
              icon:
                item.icon
            };
          })
        : inferLegacyAbilities(
            source
          );

    const capabilities = {
      levels:
        !!(
          source.capabilities?.levels ??
          source.progression?.levels ??
          source.max_level ??
          source.progression?.max_level
        ),
      abilities:
        !!(
          source.capabilities?.abilities ??
          abilities.length
        ),
      skills:
        !!(
          source.capabilities?.skills ??
          merged.skill?.length
        ),
      equipment:
        !!(
          source.capabilities?.equipment ??
          merged.item?.length
        ),
      spells:
        !!(
          source.capabilities?.spells ??
          merged.spell?.length
        ),
      conditions:
        !!(
          source.capabilities?.conditions ??
          merged.condition?.length
        ),
      resources:
        !!(
          source.capabilities?.resources ??
          source.resources
        ),
      subclasses:
        !!(
          source.capabilities?.subclasses ??
          merged.subclass?.length
        ),
      feats:
        !!(
          source.capabilities?.feats ??
          merged.feat?.length
        ),
      backgrounds:
        !!(
          source.capabilities?.backgrounds ??
          merged.background?.length
        )
    };

    const creation =
      source.creation &&
      typeof source.creation ===
        "object"
        ? clone(source.creation)
        : {
            steps:
              inferCreationSteps(
                merged,
                capabilities
              )
          };

    const entities =
      safeArray(
        source.entities
      ).map(entity =>
        normalizeEntity(
          entity,
          entity?.type || ""
        )
      );

    return {
      ...source,
      schema_version:
        source.schema_version ||
        1,
      system,
      capabilities: {
        ...(source.capabilities || {}),
        ...capabilities
      },
      abilities,
      components: merged,
      creation,
      entities,
      progression:
        source.progression || {},
      spellcasting:
        source.spellcasting || {},
      resources:
        source.resources || {},
      raw:
        source.raw || source
    };
  }

  function inferLegacyAbilities(
    source
  ) {
    const six = [
      ["strength", "Strength"],
      ["dexterity", "Dexterity"],
      ["constitution", "Constitution"],
      ["intelligence", "Intelligence"],
      ["wisdom", "Wisdom"],
      ["charisma", "Charisma"]
    ];

    if (
      source.ability_names &&
      Array.isArray(
        source.ability_names
      )
    ) {
      return source.ability_names.map(
        name => ({
          id: slugify(name),
          name,
          type: "numeric"
        })
      );
    }

    return six.map(
      ([id, name]) => ({
        id,
        name,
        type: "numeric"
      })
    );
  }

  function inferCreationSteps(
    components,
    capabilities
  ) {
    const steps = [];

    if (
      components.ancestry?.length
    ) {
      steps.push({
        id: "ancestry",
        component: "choice",
        source: "ancestry",
        required: true,
        multiple: false
      });
    } else if (
      components.race?.length
    ) {
      steps.push({
        id: "race",
        component: "choice",
        source: "race",
        required: true,
        multiple: false
      });
    }

    if (
      components.heritage?.length
    ) {
      steps.push({
        id: "heritage",
        component: "choice",
        source: "heritage",
        required: false,
        multiple: false
      });
    }

    if (
      components.class?.length
    ) {
      steps.push({
        id: "class",
        component: "choice",
        source: "class",
        required: true,
        multiple: false
      });
    }

    if (
      components.subclass?.length
    ) {
      steps.push({
        id: "subclass",
        component: "choice",
        source: "subclass",
        required: false,
        multiple: false
      });
    }

    if (
      components.background?.length
    ) {
      steps.push({
        id: "background",
        component: "choice",
        source: "background",
        required: false,
        multiple: false
      });
    }

    if (capabilities.abilities) {
      steps.push({
        id: "abilities",
        component:
          "ability_assignment"
      });
    }

    if (capabilities.skills) {
      steps.push({
        id: "skills",
        component:
          "skill_selection",
        source: "skill"
      });
    }

    if (capabilities.equipment) {
      steps.push({
        id: "equipment",
        component:
          "equipment_selection",
        source: "item"
      });
    }

    if (capabilities.spells) {
      steps.push({
        id: "spells",
        component:
          "power_selection",
        source: "spell"
      });
    }

    return steps;
  }

  function rulesComponent(type) {
    if (!S.rules) return [];

    const components =
      S.rules.components || {};

    if (
      components[type]
    ) {
      return safeArray(
        components[type]
      );
    }

    if (
      type === "ancestry" &&
      components.race
    ) {
      return safeArray(
        components.race
      );
    }

    if (
      type === "heritage" &&
      components.subrace
    ) {
      return safeArray(
        components.subrace
      );
    }

    if (
      type === "power" &&
      components.spell
    ) {
      return safeArray(
        components.spell
      );
    }

    if (
      S.rules.entities
    ) {
      return S.rules.entities.filter(
        entity =>
          entity.type === type
      );
    }

    return [];
  }

  function rulesCapability(
    capability
  ) {
    return !!(
      S.rules?.capabilities?.[
        capability
      ]
    );
  }

  function rulesMaxLevel() {
    const values = [
      S.rules?.progression?.max_level,
      S.rules?.progression?.maxLevel,
      S.rules?.max_level,
      S.rules?.maxLevel,
      S.system?.progression?.max_level
    ];

    for (const value of values) {
      const number =
        Number(value);

      if (
        Number.isFinite(number) &&
        number > 0
      ) {
        return number;
      }
    }

    return 20;
  }

  function getEntityId(entity) {
    if (!entity) return "";

    if (
      typeof entity ===
      "string"
    ) {
      return entity;
    }

    return String(
      entity.id ??
      entity.key ??
      entity.uid ??
      entity.slug ??
      entity.name ??
      ""
    );
  }

  function getEntityName(entity) {
    if (!entity) return "";

    if (
      typeof entity ===
      "string"
    ) {
      return entity;
    }

    return String(
      entity.name ??
      entity.label ??
      entity.title ??
      entity.id ??
      ""
    );
  }

  function entityDescription(
    entity
  ) {
    if (!entity) return "";

    if (
      typeof entity ===
      "string"
    ) {
      return "";
    }

    const value =
      entity.description ??
      entity.desc ??
      entity.summary ??
      entity.text ??
      "";

    if (
      Array.isArray(value)
    ) {
      return value
        .map(item =>
          typeof item ===
          "string"
            ? item
            : item?.text ||
              item?.description ||
              ""
        )
        .join(" ");
    }

    return String(value);
  }

  function findEntity(
    type,
    idOrName
  ) {
    if (
      idOrName == null ||
      idOrName === ""
    ) {
      return null;
    }

    const needle =
      String(idOrName)
        .toLowerCase();

    return rulesComponent(type)
      .find(entity => {
        const id =
          getEntityId(entity)
            .toLowerCase();

        const name =
          getEntityName(entity)
            .toLowerCase();

        return (
          id === needle ||
          name === needle
        );
      }) || null;
  }

  function componentLabel(type) {
    const step =
      safeArray(
        S.rules?.creation?.steps
      ).find(
        item =>
          item.id === type ||
          item.source === type
      );

    return (
      step?.label ||
      step?.title ||
      S.rules?.labels?.[
        type
      ] ||
      titleCase(type)
    );
  }

  function getAbilityRules() {
    return (
      S.rules?.ability_assignment ||
      S.rules?.abilities_config ||
      {}
    );
  }

  function getAbilityKeys() {
    return safeArray(
      S.rules?.abilities
    ).map(
      ability =>
        ability.id
    );
  }

  function getAbilityDefinition(
    key
  ) {
    return (
      safeArray(
        S.rules?.abilities
      ).find(
        ability =>
          String(
            ability.id
          ) === String(key)
      ) || {
        id: key,
        name: titleCase(key),
        default: 0
      }
    );
  }

  function getCurrentLevel() {
    const input =
      $("#f-level");

    const value =
      Number(
        input?.value ||
        S.currentSheet?.identity?.level ||
        1
      );

    return Math.max(
      1,
      Math.min(
        rulesMaxLevel(),
        Number.isFinite(value)
          ? value
          : 1
      )
    );
  }

  function fmtMod(value) {
    const number =
      Number(value);

    if (
      !Number.isFinite(number)
    ) {
      return "—";
    }

    return (
      number >= 0
        ? `+${number}`
        : String(number)
    );
  }

  function abilityModifier(
    score,
    definition
  ) {
    const formula =
      definition?.modifier_formula ||
      definition?.formula ||
      S.rules?.ability_assignment
        ?.modifier_formula;

    if (
      typeof formula ===
      "function"
    ) {
      try {
        return formula(score);
      } catch {}
    }

    if (
      typeof formula ===
      "string"
    ) {
      try {
        const fn =
          Function(
            "score",
            `"use strict"; return (${formula});`
          );

        return fn(
          Number(score)
        );
      } catch {}
    }

    const number =
      Number(score);

    if (
      !Number.isFinite(number)
    ) {
      return null;
    }

    return Math.floor(
      (number - 10) / 2
    );
  }

  function syncLegacyState() {
    const ancestryType =
      S.rules?.components?.ancestry
        ? "ancestry"
        : "race";

    const heritageType =
      S.rules?.components?.heritage
        ? "heritage"
        : "subrace";

    S.race =
      findEntity(
        ancestryType,
        S.choices?.[
          ancestryType
        ]
      );

    S.subrace =
      findEntity(
        heritageType,
        S.choices?.[
          heritageType
        ]
      );

    S.class =
      findEntity(
        "class",
        S.choices?.class
      );

    S.subclass =
      findEntity(
        "subclass",
        S.choices?.subclass
      );

    S.background =
      findEntity(
        "background",
        S.choices?.background
      );

    S.prof =
      S.selections.skills;

    S.spells =
      S.selections.spells;
  }

  function resetSelections() {
    S.choices = {};

    S.selections = {
      skills: {},
      spells: new Set(),
      feats: new Set(),
      items: new Set(),
      talents: new Set()
    };

    S.prof =
      S.selections.skills;

    S.spells =
      S.selections.spells;

    S.spellLevels = {};
    S.resources = {};
  }

  function stepDefinitions() {
    const configured =
      safeArray(
        S.rules?.creation?.steps
      );

    if (configured.length) {
      return configured;
    }

    return [
      {
        id: "system",
        component: "system"
      },
      ...inferCreationSteps(
        S.rules?.components || {},
        S.rules?.capabilities || {}
      ),
      {
        id: "details",
        component: "details"
      },
      {
        id: "manage",
        component: "manage"
      }
    ];
  }

  function stepCount() {
    const panels =
      $$(".step-panel");

    const definitions =
      stepDefinitions();

    return Math.max(
      panels.length,
      definitions.length,
      1
    );
  }

  function panelForStep(index) {
    return $$(".step-panel")[index] || null;
  }

  function renderRail() {
    const rail =
      $("#rail");

    if (!rail) return;

    const definitions =
      stepDefinitions();

    const labels =
      definitions.map(
        (step, index) =>
          step.label ||
          step.title ||
          (
            step.id === "system"
              ? "Game"
              : componentLabel(
                  step.source ||
                  step.id
                )
          )
      );

    rail.innerHTML =
      labels.map(
        (label, index) => `
          <button
            type="button"
            class="${
              index === S.step
                ? "on"
                : ""
            }"
            data-step="${index}"
          >
            <span class="rail-num">
              ${index + 1}
            </span>
            <span>
              ${esc(label)}
            </span>
          </button>
        `
      ).join("");

    rail.querySelectorAll(
      "[data-step]"
    ).forEach(button => {
      button.addEventListener(
        "click",
        () =>
          goStep(
            Number(
              button.dataset.step
            )
          )
      );
    });
  }

  function goStep(index) {
    const count =
      stepCount();

    S.step =
      Math.max(
        0,
        Math.min(
          count - 1,
          Number(index) || 0
        )
      );

    $$(".step-panel")
      .forEach(
        (panel, panelIndex) => {
          panel.style.display =
            panelIndex === S.step
              ? ""
              : "none";

          panel.classList.toggle(
            "active",
            panelIndex === S.step
          );
        }
      );

    const back =
      $("#nav-back");

    const next =
      $("#nav-next");

    if (back) {
      back.disabled =
        S.step <= 0;
    }

    if (next) {
      next.disabled =
        S.step >= count - 1;
      next.textContent =
        S.step >= count - 1
          ? "finish"
          : "next →";
    }

    renderRail();
    renderCurrentStep();
  }

  function renderCurrentStep() {
    const definitions =
      stepDefinitions();

    const definition =
      definitions[S.step];

    if (!definition) {
      renderAll();
      return;
    }

    const source =
      definition.source ||
      definition.id;

    switch (
      definition.component
    ) {
      case "system":
        renderSystems();
        break;

      case "choice":
        renderDynamicChoice(
          source,
          definition
        );
        break;

      case "ability_assignment":
        renderAbilities();
        break;

      case "skill_selection":
        renderSkills();
        break;

      case "equipment_selection":
        renderEquipment();
        break;

      case "power_selection":
      case "spell_selection":
        renderSpells();
        break;

      case "details":
        renderPortraits();
        renderKV();
        break;

      case "manage":
        if (S.currentSheet) {
          renderManage(
            S.currentSheet
          );
        }
        break;

      default:
        renderAll();
        break;
    }
  }

  function renderAll() {
    renderSystems();
    renderDynamicPanels();
    renderRaceGrid();
    renderSubrace();
    renderClassGrid();
    renderClassNarrate();
    renderSubclass();
    renderAbilities();
    renderLevels();
    renderSkills();
    renderEquipment();
    renderSpells();
    renderBackground();
    renderCampaign();
    renderPortraits();
    renderKV();
    renderBuildDock();
    refreshAcquireCount();
  }

  function renderDynamicPanels() {
    const definitions =
      stepDefinitions();

    definitions.forEach(
      definition => {
        if (
          definition.component ===
          "choice"
        ) {
          renderDynamicChoice(
            definition.source ||
              definition.id,
            definition
          );
        }
      }
    );
  }

  function renderSystems() {
    const grid =
      $("#system-grid");

    if (!grid) return;

    const games =
      Object.values(
        S.games || {}
      );

    grid.innerHTML =
      games.map(game => {
        const id =
          game.id;

        const selected =
          String(
            S.system?.id || ""
          ) ===
          String(id);

        return `
          <div
            class="opt-card ${
              selected
                ? "selected"
                : ""
            }"
            data-system-id="${esc(id)}"
          >
            <div class="oc-name">
              ${esc(
                game.name ||
                game.label ||
                id
              )}
            </div>

            <div class="oc-sub">
              ${esc(
                game.version ||
                game.system_version ||
                ""
              )}
            </div>

            ${
              game.description
                ? `
                  <div class="oc-perks">
                    <div class="perk">
                      ${esc(
                        game.description
                      )}
                    </div>
                  </div>
                `
                : ""
            }
          </div>
        `;
      }).join("") ||
      '<p class="empty">No game systems are available.</p>';

    grid.querySelectorAll(
      "[data-system-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          selectSystem(
            element.dataset.systemId
          )
      );
    });

    const narrative =
      $("#system-narrate");

    if (narrative) {
      narrative.innerHTML =
        S.system
          ? `
            <h3>
              ${esc(
                S.system.name ||
                S.system.label ||
                S.system.id
              )}
            </h3>

            <p>
              ${esc(
                S.system.description ||
                "Rules loaded."
              )}
            </p>
          `
          : `
            <p class="empty">
              Choose a game system.
            </p>
          `;
    }
  }

  async function loadGames() {
    const result =
      await getJSON(
        "/api/games"
      );

    const rows =
      Array.isArray(result)
        ? result
        : Array.isArray(result?.games)
          ? result.games
          : result && typeof result === "object"
            ? Object.values(result)
            : [];

    S.games = {};

    rows.forEach(game => {
      if (!game) return;

      const id =
        game.id ||
        game.system ||
        game.key;

      if (!id) return;

      S.games[id] = {
        ...game,
        id
      };
    });

    renderSystems();

    return S.games;
  }

  async function loadCampaigns(
    systemId
  ) {
    const box =
      $("#f-campaign");

    try {
      const result =
        await getJSON(
          `/api/campaigns?system=${encodeURIComponent(
            systemId || ""
          )}`
        );

      S.campaigns =
        Array.isArray(result)
          ? result
          : safeArray(
              result?.campaigns
            );
    } catch {
      S.campaigns = [];
    }

    if (!box) return;

    const current =
      S.campaign?.id || "";

    box.innerHTML = `
      <option value="">
        no campaign
      </option>

      ${S.campaigns.map(
        campaign => `
          <option
            value="${esc(
              campaign.id
            )}"
            ${
              String(
                campaign.id
              ) ===
              String(current)
                ? "selected"
                : ""
            }
          >
            ${esc(
              campaign.title ||
              campaign.name ||
              campaign.id
            )}
          </option>
        `
      ).join("")}
    `;

    box.onchange = () => {
      const id =
        box.value;

      S.campaign =
        S.campaigns.find(
          campaign =>
            String(
              campaign.id
            ) === String(id)
        ) || null;

      renderCampaign();
      renderBuildDock();
    };
  }

  async function loadRules(
    systemId
  ) {
    const token =
      ++S.rulesToken;

    if (!systemId) {
      S.rules = null;
      return null;
    }

    const raw =
      await getJSON(
        `/api/rules/${encodeURIComponent(
          systemId
        )}`
      );

    if (
      token !== S.rulesToken
    ) {
      return null;
    }

    S.rules =
      normalizeRules(
        raw
      );

    return S.rules;
  }

  async function selectSystem(
    systemId
  ) {
    if (!systemId) return;

    const token =
      ++S.loadToken;

    const game =
      S.games[systemId] || {
        id: systemId,
        name: systemId
      };

    S.system =
      normalizeSystem(
        game,
        systemId
      );

    S.rules = null;
    S.campaign = null;

    resetSelections();

    renderSystems();

    try {
      const rules =
        await loadRules(
          systemId
        );

      if (
        token !== S.loadToken
      ) {
        return;
      }

      if (!rules) {
        throw new Error(
          "Rules could not be loaded."
        );
      }

      await loadCampaigns(
        systemId
      );

      if (
        token !== S.loadToken
      ) {
        return;
      }

      initializeAbilities();

      syncLegacyState();
      renderAll();

      if (
        S.pendingSheet &&
        S.pendingSheet.system ===
          systemId
      ) {
        const pending =
          S.pendingSheet;

        S.pendingSheet = null;

        restoreSelections(
          pending
        );

        restoreChoiceFields(
          pending
        );

        renderAll();
      }
    } catch (error) {
      if (
        token !== S.loadToken
      ) {
        return;
      }

      console.error(
        "Rules load failed:",
        error
      );

      S.rules = normalizeRules({
        system:
          S.system,
        components: {},
        capabilities: {}
      });

      renderAll();
    }
  }

  function initializeAbilities() {
    const keys =
      getAbilityKeys();

    const existing =
      S.abilities || {};

    const result = {};

    keys.forEach(key => {
      const definition =
        getAbilityDefinition(key);

      result[key] =
        existing[key] ??
        definition.default ??
        0;
    });

    S.abilities =
      result;

    S.abilityMetaInitialized =
      true;
  }

  function renderDynamicChoice(
    type,
    definition = {}
  ) {
    const grid =
      $(
        `#${type}-grid`
      );

    if (!grid) return;

    const entities =
      rulesComponent(type);

    const selected =
      S.choices?.[type];

    grid.innerHTML =
      entities.map(entity => {
        const id =
          getEntityId(entity);

        const isSelected =
          Array.isArray(selected)
            ? selected.includes(id)
            : String(
                selected || ""
              ).toLowerCase() ===
              id.toLowerCase();

        return `
          <div
            class="opt-card ${
              isSelected
                ? "selected"
                : ""
            }"
            data-dynamic-choice="${esc(
              type
            )}"
            data-dynamic-choice-id="${esc(
              id
            )}"
          >
            <div class="oc-name">
              ${esc(
                getEntityName(entity)
              )}
            </div>

            ${
              entity.tags?.length
                ? `
                  <div class="oc-sub">
                    ${esc(
                      entity.tags.join(
                        " · "
                      )
                    )}
                  </div>
                `
                : ""
            }

            <div class="oc-perks">
              <div class="perk">
                ${esc(
                  entityDescription(
                    entity
                  ).slice(
                    0,
                    180
                  )
                )}
              </div>
            </div>
          </div>
        `;
      }).join("") ||
      '<p class="empty">No choices are available.</p>';

    grid.querySelectorAll(
      "[data-dynamic-choice]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          selectDynamicChoice(
            type,
            element.dataset
              .dynamicChoiceId,
            definition
          )
      );
    });
  }

  function selectDynamicChoice(
    type,
    id,
    definition = {}
  ) {
    if (!S.choices) {
      S.choices = {};
    }

    if (
      definition.multiple
    ) {
      const current =
        Array.isArray(
          S.choices[type]
        )
          ? [
              ...S.choices[type]
            ]
          : [];

      if (
        current.includes(id)
      ) {
        S.choices[type] =
          current.filter(
            value =>
              value !== id
          );
      } else {
        S.choices[type] =
          [
            ...current,
            id
          ];
      }
    } else {
      S.choices[type] =
        id;
    }

    syncLegacyState();
    renderDynamicChoice(
      type,
      definition
    );
    renderSubrace();
    renderSubclass();
    renderLevels();
    renderBackground();
    renderBuildDock();
    refreshAcquireCount();
  }

  function renderRaceGrid() {
    const ancestryType =
      S.rules?.components?.ancestry
        ? "ancestry"
        : "race";

    const grid =
      $("#race-grid");

    if (!grid) return;

    const entities =
      rulesComponent(
        ancestryType
      );

    grid.innerHTML =
      entities.map(entity => {
        const id =
          getEntityId(entity);

        const selected =
          String(
            S.choices?.[
              ancestryType
            ] || ""
          ).toLowerCase() ===
          id.toLowerCase();

        return `
          <div
            class="opt-card ${
              selected
                ? "selected"
                : ""
            }"
            data-race-id="${esc(id)}"
          >
            <div class="oc-name">
              ${esc(
                getEntityName(
                  entity
                )
              )}
            </div>

            <div class="oc-perks">
              <div class="perk">
                ${esc(
                  entityDescription(
                    entity
                  ).slice(
                    0,
                    180
                  )
                )}
              </div>
            </div>
          </div>
        `;
      }).join("") ||
      '<p class="empty">No ancestry/race data is available.</p>';

    grid.querySelectorAll(
      "[data-race-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          pickRace(
            element.dataset.raceId
          )
      );
    });

    const label =
      $("#lbl-race");

    if (label) {
      label.textContent =
        componentLabel(
          ancestryType
        );
    }

    const narrative =
      $("#race-narrate");

    const selected =
      findEntity(
        ancestryType,
        S.choices?.[
          ancestryType
        ]
      );

    if (narrative) {
      narrative.innerHTML =
        selected
          ? `
            <h3>
              ${esc(
                getEntityName(
                  selected
                )
              )}
            </h3>
            <p>
              ${esc(
                entityDescription(
                  selected
                ) ||
                "No overview."
              )}
            </p>
          `
          : `
            <p class="empty">
              Choose an ancestry/race.
            </p>
          `;
    }
  }

  function pickRace(id) {
    const type =
      S.rules?.components?.ancestry
        ? "ancestry"
        : "race";

    S.choices[type] =
      id;

    syncLegacyState();
    renderRaceGrid();
    renderSubrace();
    renderBuildDock();
    refreshAcquireCount();
  }

  function renderSubrace() {
    const card =
      $("#subrace-card");

    if (!card) return;

    const type =
      S.rules?.components?.heritage
        ? "heritage"
        : "subrace";

    const parentType =
      S.rules?.components?.ancestry
        ? "ancestry"
        : "race";

    if (
      !rulesComponent(type).length
    ) {
      card.style.display =
        "none";
      return;
    }

    const parent =
      findEntity(
        parentType,
        S.choices?.[
          parentType
        ]
      );

    let entities =
      rulesComponent(type);

    if (parent) {
      const parentId =
        getEntityId(parent);

      const filtered =
        entities.filter(
          entity =>
            String(
              entity.parent_id ??
              entity.ancestry_id ??
              entity.race_id ??
              ""
            ) ===
            String(parentId)
        );

      if (filtered.length) {
        entities = filtered;
      }
    }

    card.style.display =
      entities.length
        ? "block"
        : "none";

    const grid =
      $("#subrace-grid");

    if (!grid) return;

    grid.innerHTML =
      entities.map(entity => {
        const id =
          getEntityId(entity);

        const selected =
          String(
            S.choices?.[type] ||
            ""
          ).toLowerCase() ===
          id.toLowerCase();

        return `
          <div
            class="opt-card ${
              selected
                ? "selected"
                : ""
            }"
            data-subrace-id="${esc(id)}"
          >
            <div class="oc-name">
              ${esc(
                getEntityName(
                  entity
                )
              )}
            </div>

            <div class="oc-perks">
              <div class="perk">
                ${esc(
                  entityDescription(
                    entity
                  ).slice(
                    0,
                    160
                  )
                )}
              </div>
            </div>
          </div>
        `;
      }).join("");

    grid.querySelectorAll(
      "[data-subrace-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          pickSubrace(
            element.dataset
              .subraceId
          )
      );
    });

    const narrative =
      $("#subrace-narrate");

    const selected =
      findEntity(
        type,
        S.choices?.[type]
      );

    if (narrative) {
      narrative.innerHTML =
        selected
          ? `
            <h3>
              ${esc(
                getEntityName(
                  selected
                )
              )}
            </h3>
            <p>
              ${esc(
                entityDescription(
                  selected
                ) ||
                "No overview."
              )}
            </p>
          `
          : `
            <p class="empty">
              Pick a heritage/subrace if applicable.
            </p>
          `;
    }
  }

  function pickSubrace(id) {
    const type =
      S.rules?.components?.heritage
        ? "heritage"
        : "subrace";

    S.choices[type] =
      id;

    syncLegacyState();
    renderSubrace();
    renderBuildDock();
    refreshAcquireCount();
  }

  function renderClassGrid() {
    const grid =
      $("#class-grid");

    if (!grid) return;

    const classes =
      rulesComponent("class");

    grid.innerHTML =
      classes.map(entity => {
        const id =
          getEntityId(entity);

        const selected =
          String(
            S.choices?.class ||
            ""
          ).toLowerCase() ===
          id.toLowerCase();

        return `
          <div
            class="opt-card ${
              selected
                ? "selected"
                : ""
            }"
            data-class-id="${esc(id)}"
          >
            <div class="oc-name">
              ${esc(
                getEntityName(
                  entity
                )
              )}
            </div>

            <div class="oc-perks">
              <div class="perk">
                ${esc(
                  entityDescription(
                    entity
                  ).slice(
                    0,
                    180
                  )
                )}
              </div>
            </div>
          </div>
        `;
      }).join("") ||
      '<p class="empty">No class/profession data is available.</p>';

    grid.querySelectorAll(
      "[data-class-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          pickClass(
            element.dataset.classId
          )
      );
    });

    const label =
      $("#lbl-class");

    if (label) {
      label.textContent =
        componentLabel(
          "class"
        );
    }
  }

  function pickClass(id) {
    S.choices.class =
      id;

    delete S.choices.subclass;

    syncLegacyState();
    renderClassGrid();
    renderClassNarrate();
    renderSubclass();
    renderLevels();
    renderBuildDock();
    refreshAcquireCount();
  }

  function renderClassNarrate() {
    const box =
      $("#class-narrate");

    if (!box) return;

    const entity =
      findEntity(
        "class",
        S.choices?.class
      );

    box.innerHTML =
      entity
        ? `
          <h3>
            ${esc(
              getEntityName(
                entity
              )
            )}
          </h3>
          <p>
            ${esc(
              entityDescription(
                entity
              ) ||
              "No overview."
            )}
          </p>
        `
        : `
          <p class="empty">
            Choose a class/profession.
          </p>
        `;
  }

  function renderAbilities() {
    const grid =
      $("#ability-grid");

    if (!grid) return;

    if (
      !rulesCapability(
        "abilities"
      )
    ) {
      grid.innerHTML =
        '<p class="empty">This game does not define an ability system.</p>';

      const points =
        $("#ab-points");

      if (points) {
        points.textContent =
          "";
      }

      return;
    }

    initializeAbilities();

    const assignment =
      getAbilityRules();

    const pointBudget =
      numberOr(
        assignment.point_budget,
        NaN
      );

    let spent = 0;

    grid.innerHTML =
      getAbilityKeys()
        .map(key => {
          const definition =
            getAbilityDefinition(
              key
            );

          const value =
            S.abilities[key] ??
            definition.default ??
            0;

          const min =
            definition.min ??
            assignment.min ??
            0;

          const max =
            definition.max ??
            assignment.max ??
            30;

          const modifier =
            abilityModifier(
              value,
              definition
            );

          spent +=
            Number(value) || 0;

          return `
            <div class="ab-tile">
              <div class="abname">
                <span>
                  ${esc(
                    definition.name ||
                    titleCase(key)
                  )}
                </span>
                <span>
                  ${esc(
                    definition.icon ||
                    ABILITY_ICONS[key] ||
                    "🎲"
                  )}
                </span>
              </div>

              <input
                type="number"
                min="${esc(min)}"
                max="${esc(max)}"
                step="${esc(
                  definition.step ||
                  1
                )}"
                value="${esc(value)}"
                data-ability="${esc(key)}"
              >

              <div class="modline">
                ${esc(
                  modifier == null
                    ? ""
                    : `modifier ${fmtMod(
                        modifier
                      )}`
                )}
              </div>
            </div>
          `;
        })
        .join("");

    grid.querySelectorAll(
      "[data-ability]"
    ).forEach(input => {
      input.addEventListener(
        "input",
        () => {
          const key =
            input.dataset.ability;

          const definition =
            getAbilityDefinition(
              key
            );

          let value =
            Number(
              input.value
            );

          if (
            !Number.isFinite(
              value
            )
          ) {
            value =
              definition.default ||
              0;
          }

          if (
            definition.min !=
            null
          ) {
            value =
              Math.max(
                Number(
                  definition.min
                ),
                value
              );
          }

          if (
            definition.max !=
            null
          ) {
            value =
              Math.min(
                Number(
                  definition.max
                ),
                value
              );
          }

          S.abilities[key] =
            value;

          input.value =
            value;

          renderAbilities();
          renderBuildDock();
        }
      );
    });

    const points =
      $("#ab-points");

    if (points) {
      points.textContent =
        Number.isFinite(
          pointBudget
        )
          ? `${spent} / ${pointBudget}`
          : `${spent} points`;
    }

    const hint =
      $("#ab-hint");

    if (hint) {
      hint.textContent =
        assignment.description ||
        (
          Number.isFinite(
            pointBudget
          )
            ? `Allocate ${pointBudget} points.`
            : ""
        );
    }
  }

  function renderSkills() {
    const body =
      $("#skills-body");

    if (!body) return;

    if (
      !rulesCapability("skills")
    ) {
      body.innerHTML =
        '<p class="empty">This game does not define skills.</p>';
      return;
    }

    const skills =
      rulesComponent("skill");

    body.innerHTML =
      skills.map(skill => {
        const id =
          getEntityId(skill);

        const level =
          S.selections.skills[
            id
          ];

        const selected =
          !!level;

        return `
          <div class="kb-item">
            <div
              class="ti"
              data-skill-id="${esc(id)}"
            >
              ${esc(
                getEntityName(
                  skill
                )
              )}

              ${
                skill.ability_label ||
                skill.ability
                  ? `
                    <span class="tag">
                      ${esc(
                        skill.ability_label ||
                        skill.ability
                      )}
                    </span>
                  `
                  : ""
              }
            </div>

            <div class="act">
              <button
                class="${
                  selected
                    ? "on"
                    : ""
                }"
                data-toggle-skill="${esc(id)}"
              >
                ${selected ? "✓" : "+"}
              </button>
            </div>

            <div class="sub">
              ${esc(
                entityDescription(
                  skill
                ).slice(
                  0,
                  120
                )
              )}
            </div>
          </div>
        `;
      }).join("") ||
      '<p class="empty">No skills are available.</p>';

    body.querySelectorAll(
      "[data-skill-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          lookupSkill(
            element.dataset.skillId
          )
      );
    });

    body.querySelectorAll(
      "[data-toggle-skill]"
    ).forEach(button => {
      button.addEventListener(
        "click",
        event => {
          event.stopPropagation();

          toggleSkill(
            button.dataset
              .toggleSkill
          );
        }
      );
    });
  }

  function toggleSkill(id) {
    if (
      S.selections.skills[id]
    ) {
      delete S.selections.skills[
        id
      ];
    } else {
      const entity =
        findEntity(
          "skill",
          id
        );

      S.selections.skills[id] =
        entity?.proficiency_level ||
        "trained";
    }

    S.prof =
      S.selections.skills;

    renderSkills();
    renderBuildDock();
    refreshAcquireCount();
  }

  function renderEquipment() {
    const container =
      $("#acquire-list");

    if (!container) return;

    if (
      !rulesCapability(
        "equipment"
      )
    ) {
      return;
    }
  }

  function renderSpells() {
    const body =
      $("#spells-body");

    if (!body) return;

    if (
      !rulesCapability("spells")
    ) {
      body.innerHTML =
        '<p class="empty">This game does not use spells or powers.</p>';
      return;
    }

    const spells =
      rulesComponent("spell");

    const categories =
      [
        ...new Set(
          spells
            .map(spell =>
              spell.school ||
              spell.category ||
              spell.tradition ||
              spell.type ||
              ""
            )
            .filter(Boolean)
        )
      ].sort();

    body.innerHTML = `
      <div
        class="spell-tools"
        style="
          display:flex;
          flex-wrap:wrap;
          gap:8px;
          align-items:center;
          margin-bottom:10px
        "
      >
        <input
          id="spell-filter"
          type="search"
          placeholder="search powers…"
        >

        <select id="spell-level">
          <option value="">
            any level
          </option>

          ${[
            ...new Set(
              spells
                .map(
                  spell =>
                    spell.level
                )
                .filter(
                  level =>
                    level != null
                )
            )
          ]
            .sort(
              (a, b) =>
                Number(a) -
                Number(b)
            )
            .map(
              level => `
                <option value="${esc(
                  level
                )}">
                  ${esc(level)}
                </option>
              `
            )
            .join("")}
        </select>

        <select id="spell-school">
          <option value="">
            any category
          </option>

          ${categories.map(
            category => `
              <option value="${esc(
                category
              )}">
                ${esc(
                  category
                )}
              </option>
            `
          ).join("")}
        </select>

        <label
          style="
            display:inline-flex;
            gap:6px;
            align-items:center;
            font-size:12px
          "
        >
          <input
            type="checkbox"
            id="spell-known-only"
            style="width:auto"
          >
          known only
        </label>
      </div>

      <div
        class="kb-list"
        id="spell-list"
      ></div>
    `;

    $("#spell-filter")
      ?.addEventListener(
        "input",
        renderSpellList
      );

    $("#spell-level")
      ?.addEventListener(
        "change",
        renderSpellList
      );

    $("#spell-school")
      ?.addEventListener(
        "change",
        renderSpellList
      );

    $("#spell-known-only")
      ?.addEventListener(
        "change",
        renderSpellList
      );

    renderSpellList();
  }

  function renderSpellList() {
    const list =
      $("#spell-list");

    if (!list) return;

    const spells =
      rulesComponent("spell");

    const q =
      val("spell-filter")
        .toLowerCase();

    const level =
      val("spell-level");

    const category =
      val("spell-school");

    const knownOnly =
      !!$("#spell-known-only")
        ?.checked;

    const selectedSpells =
      S.selections?.spells ||
      S.spells ||
      new Set();

    const rows =
      spells.filter(spell => {
        const name =
          getEntityName(spell)
            .toLowerCase();

        const spellCategory =
          spell.school ||
          spell.category ||
          spell.tradition ||
          spell.type ||
          "";

        return (
          (!q ||
            name.includes(q)) &&
          (
            !level ||
            String(
              spell.level
            ) === level
          ) &&
          (
            !category ||
            spellCategory ===
              category
          ) &&
          (
            !knownOnly ||
            selectedSpells.has(
              getEntityId(
                spell
              )
            )
          )
        );
      });

    list.innerHTML =
      rows.slice(0, 200)
        .map(spell => {
          const id =
            getEntityId(
              spell
            );

          const known =
            selectedSpells.has(id);

          return `
            <div class="kb-item">
              <div
                class="ti"
                data-power-id="${esc(id)}"
              >
                ${esc(
                  getEntityName(
                    spell
                  )
                )}

                ${
                  spell.level != null
                    ? `
                      <span class="tag">
                        ${esc(
                          spell.level_name ||
                          spell.level
                        )}
                      </span>
                    `
                    : ""
                }

                ${
                  spell.school ||
                  spell.category
                    ? `
                      <span class="tag">
                        ${esc(
                          spell.school ||
                          spell.category
                        )}
                      </span>
                    `
                    : ""
                }
              </div>

              <div class="act">
                <button
                  class="${
                    known
                      ? "on"
                      : ""
                  }"
                  data-toggle-spell="${esc(
                    id
                  )}"
                >
                  ${known ? "✓" : "+"}
                </button>
              </div>

              <div class="sub">
                ${esc(
                  entityDescription(
                    spell
                  ).slice(
                    0,
                    120
                  )
                )}
              </div>
            </div>
          `;
        })
        .join("") ||
      '<p class="empty">no powers match</p>';

    list.querySelectorAll(
      "[data-power-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          lookupPower(
            element.dataset
              .powerId
          )
      );
    });

    list.querySelectorAll(
      "[data-toggle-spell]"
    ).forEach(button => {
      button.addEventListener(
        "click",
        event => {
          event.stopPropagation();

          toggleSpell(
            button.dataset
              .toggleSpell
          );
        }
      );
    });
  }

  function toggleSpell(id) {
    if (
      !S.selections.spells
    ) {
      S.selections.spells =
        new Set();
    }

    if (
      S.selections.spells.has(id)
    ) {
      S.selections.spells.delete(
        id
      );

      delete S.spellLevels[id];
    } else {
      S.selections.spells.add(
        id
      );

      S.spellLevels[id] =
        getCurrentLevel();
    }

    S.spells =
      S.selections.spells;

    renderSpellList();
    refreshAcquireCount();
    renderBuildDock();
  }

  function renderCasterSelect() {
    const box =
      $("#caster-select-body");

    const card =
      $("#caster-select-card");

    if (!box) return;

    if (
      !rulesCapability("spells")
    ) {
      if (card) {
        card.style.display =
          "none";
      }

      return;
    }

    const spells =
      rulesComponent("spell");

    if (!spells.length) {
      box.innerHTML =
        '<p class="empty">No spell/power data is available.</p>';
      return;
    }

    if (card) {
      card.style.display =
        "block";
    }

    const progression =
      S.rules?.spellcasting
        ?.progression ||
      S.rules?.progression
        ?.spellcasting ||
      null;

    const level =
      getCurrentLevel();

    let maxLevel = null;

    if (
      progression?.max_spell_level !=
      null
    ) {
      maxLevel =
        typeof progression
          .max_spell_level ===
        "object"
          ? progression
              .max_spell_level[
              level
            ]
          : progression
              .max_spell_level;
    }

    const badge =
      $("#caster-badge");

    if (badge) {
      badge.textContent =
        maxLevel != null
          ? `level ${level} · up to power level ${maxLevel}`
          : `level ${level}`;
    }

    const groups = {};

    spells.forEach(spell => {
      const spellLevel =
        Number(
          spell.level ?? 0
        );

      if (!groups[spellLevel]) {
        groups[spellLevel] =
          [];
      }

      groups[spellLevel].push(
        spell
      );
    });

    const levels =
      Object.keys(groups)
        .map(Number)
        .sort(
          (a, b) => a - b
        );

    box.innerHTML =
      levels.map(
        spellLevel => {
          const unlocked =
            maxLevel == null ||
            spellLevel === 0 ||
            spellLevel <=
              Number(
                maxLevel
              );

          const label =
            spellLevel === 0
              ? "Level 0"
              : `Level ${spellLevel}`;

          return `
            <details
              class="lvlrow"
              ${
                unlocked
                  ? "open"
                  : ""
              }
            >
              <summary>
                <span class="lvb">
                  ${esc(
                    spellLevel
                  )}
                </span>

                <span>
                  ${esc(label)}
                  (${groups[
                    spellLevel
                  ].length})

                  ${
                    unlocked
                      ? ""
                      : `
                        <span
                          class="tag"
                          style="color:var(--red)"
                        >
                          locked
                        </span>
                      `
                  }
                </span>
              </summary>

              <div class="kb-list">
                ${groups[
                  spellLevel
                ].map(spell => {
                  const id =
                    getEntityId(
                      spell
                    );

                  const known =
                    S.selections
                      .spells
                      .has(id);

                  return `
                    <div class="kb-item">
                      <div
                        class="ti"
                        data-caster-power="${esc(
                          id
                        )}"
                      >
                        ${esc(
                          getEntityName(
                            spell
                          )
                        )}

                        ${
                          spell.school
                            ? `
                              <span class="tag">
                                ${esc(
                                  spell.school
                                )}
                              </span>
                            `
                            : ""
                        }
                      </div>

                      <div class="act">
                        <button
                          class="${
                            known
                              ? "on"
                              : ""
                          }"
                          ${
                            unlocked
                              ? ""
                              : "disabled"
                          }
                          data-caster-toggle="${esc(
                            id
                          )}"
                        >
                          ${
                            known
                              ? "✓"
                              : "+"
                          }
                        </button>
                      </div>

                      <div class="sub">
                        ${esc(
                          entityDescription(
                            spell
                          ).slice(
                            0,
                            100
                          )
                        )}
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </details>
          `;
        }
      ).join("");

    box.querySelectorAll(
      "[data-caster-power]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          lookupPower(
            element.dataset
              .casterPower
          )
      );
    });

    box.querySelectorAll(
      "[data-caster-toggle]"
    ).forEach(button => {
      button.addEventListener(
        "click",
        event => {
          event.stopPropagation();

          toggleSpell(
            button.dataset
              .casterToggle
          );
        }
      );
    });
  }

  function renderLevels() {
    const body =
      $("#levels-body");

    const badge =
      $("#levels-class");

    if (!body) return;

    if (
      !rulesCapability("levels")
    ) {
      body.innerHTML =
        '<p class="empty">This game does not use level-based progression.</p>';

      if (badge) {
        badge.textContent =
          "—";
      }

      renderTreeLevels([]);

      return;
    }

    const current =
      getCurrentLevel();

    const selectedClass =
      findEntity(
        "class",
        S.choices?.class
      ) ||
      S.class;

    if (badge) {
      badge.textContent =
        selectedClass
          ? getEntityName(
              selectedClass
            )
          : "—";
    }

    if (
      rulesCapability("spells")
    ) {
      const casterCard =
        $("#caster-select-card");

      if (casterCard) {
        const spellcaster =
          selectedClass?.is_spellcaster ||
          selectedClass?.spellcasting ||
          selectedClass?.spellcasting_ability ||
          safeArray(
            selectedClass?.resources
          ).some(
            resource =>
              resource?.type ===
              "spellcasting"
          );

        casterCard.style.display =
          spellcaster
            ? "block"
            : "none";

        if (spellcaster) {
          renderCasterSelect();
        }
      }
    }

    if (!selectedClass) {
      body.innerHTML =
        '<p class="empty">Choose a progression component to see level-by-level features.</p>';

      renderTreeLevels([]);

      return;
    }

    const features =
      selectedClass.features ||
      selectedClass.features_by_level ||
      selectedClass.level_rewards ||
      {};

    const keys =
      Object.keys(features)
        .map(Number)
        .filter(
          Number.isFinite
        )
        .sort(
          (a, b) => a - b
        );

    if (!keys.length) {
      body.innerHTML =
        '<p class="empty">No level progression data is available for this choice.</p>';

      renderTreeLevels([]);

      return;
    }

    body.innerHTML =
      keys.map(level => {
        const list =
          Array.isArray(
            features[
              String(level)
            ]
          )
            ? features[
                String(level)
              ]
            : [];

        return `
          <details
            class="lvlrow ${
              level === current
                ? "now"
                : ""
            }"
            ${
              level <= current
                ? "open"
                : ""
            }
          >
            <summary>
              <span class="lvb">
                L${esc(level)}
              </span>

              <span>
                ${
                  list.map(
                    feature =>
                      esc(
                        getEntityName(
                          feature
                        )
                      )
                  ).join(" · ") ||
                  "—"
                }
              </span>
            </summary>

            <div class="feat">
              ${list.map(
                feature => `
                  <div>
                    <b>
                      ${esc(
                        getEntityName(
                          feature
                        )
                      )}
                    </b>

                    ${
                      feature.prerequisite
                        ? `
                          <span class="prereq">
                            (req ${esc(
                              feature.prerequisite
                            )})
                          </span>
                        `
                        : ""
                    }

                    <p>
                      ${esc(
                        entityDescription(
                          feature
                        ) ||
                        "no description"
                      )}
                    </p>
                  </div>
                `
              ).join("")}
            </div>
          </details>
        `;
      }).join("");

    renderTreeLevels(
      keys
    );
  }

  function renderTreeLevels(
    keys
  ) {
    const box =
      $("#tree-levels");

    if (!box) return;

    if (
      !rulesCapability("levels")
    ) {
      box.innerHTML = "";
      return;
    }

    const current =
      getCurrentLevel();

    const max =
      rulesMaxLevel();

    box.innerHTML =
      Array.from(
        {
          length: max
        },
        (_, i) =>
          i + 1
      )
        .map(
          level => `
            <button
              class="${
                keys.includes(level)
                  ? "has"
                  : ""
              } ${
                level === current
                  ? "on"
                  : ""
              }"
              data-level="${level}"
              type="button"
            >
              ${level}
            </button>
          `
        )
        .join("");

    box.querySelectorAll(
      "[data-level]"
    ).forEach(button => {
      button.addEventListener(
        "click",
        () =>
          setLevel(
            Number(
              button.dataset
                .level
            )
          )
      );
    });
  }

  function setLevel(level) {
    const input =
      $("#f-level");

    if (!input) return;

    input.value =
      Math.max(
        1,
        Math.min(
          rulesMaxLevel(),
          Number(level) || 1
        )
      );

    renderLevels();
    renderBuildDock();
  }

  function renderSubclass() {
    const card =
      $("#subclass-card2");

    if (!card) return;

    if (
      !rulesCapability(
        "subclasses"
      )
    ) {
      card.style.display =
        "none";
      return;
    }

    const cls =
      findEntity(
        "class",
        S.choices?.class
      ) ||
      S.class;

    if (!cls) {
      card.style.display =
        "none";
      return;
    }

    let subclasses =
      safeArray(
        cls.subclasses
      );

    if (!subclasses.length) {
      const classId =
        getEntityId(cls);

      subclasses =
        rulesComponent(
          "subclass"
        ).filter(
          subclass =>
            String(
              subclass.parent_id ??
              subclass.class_id ??
              ""
            ) ===
            String(classId)
        );
    }

    if (!subclasses.length) {
      card.style.display =
        "none";
      return;
    }

    card.style.display =
      "block";

    const grid =
      $("#subclass-grid");

    if (!grid) return;

    grid.innerHTML =
      subclasses.map(
        subclass => {
          const id =
            getEntityId(
              subclass
            );

          const selected =
            String(
              S.choices?.subclass ||
              ""
            ).toLowerCase() ===
            id.toLowerCase();

          return `
            <div
              class="opt-card ${
                selected
                  ? "selected"
                  : ""
              }"
              data-subclass-id="${esc(id)}"
            >
              <div class="oc-name">
                ${esc(
                  getEntityName(
                    subclass
                  )
                )}
              </div>

              <div class="oc-perks">
                <div class="perk">
                  ${esc(
                    entityDescription(
                      subclass
                    ).slice(
                      0,
                      120
                    )
                  )}
                </div>
              </div>
            </div>
          `;
        }
      ).join("");

    grid.querySelectorAll(
      "[data-subclass-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          pickSubclass(
            element.dataset
              .subclassId
          )
      );
    });

    const selected =
      findEntity(
        "subclass",
        S.choices?.subclass
      );

    const narrative =
      $("#subclass-narrate");

    if (narrative) {
      narrative.innerHTML =
        selected
          ? `
            <h3>
              ${esc(
                getEntityName(
                  selected
                )
              )}
            </h3>

            <p>
              ${esc(
                entityDescription(
                  selected
                ) ||
                "No overview."
              )}
            </p>
          `
          : `
            <p class="empty">
              Pick a specialization to see its overview.
            </p>
          `;
    }
  }

  function pickSubclass(id) {
    S.choices.subclass =
      id;

    syncLegacyState();
    renderSubclass();
    renderLevels();
    refreshAcquireCount();
    renderBuildDock();
  }

  function renderBackground() {
    const box =
      $("#bg-detail");

    if (!box) return;

    const input =
      val("f-bg");

    if (!input) {
      S.choices.background =
        null;

      S.background =
        null;

      box.innerHTML = "";
      return;
    }

    const bg =
      findEntity(
        "background",
        input
      );

    if (!bg) {
      S.choices.background =
        input;

      S.background = {
        name: input
      };

      box.innerHTML =
        `<div class="worldnotes">
          <b>${esc(input)}</b>
          <p>Custom background.</p>
        </div>`;

      return;
    }

    S.choices.background =
      getEntityId(bg);

    S.background =
      bg;

    const skills =
      safeArray(bg.skills)
        .map(skill =>
          typeof skill ===
          "string"
            ? skill
            : skill.name ||
              safeArray(
                skill.options
              ).join(" / ")
        )
        .filter(Boolean)
        .join(", ");

    box.innerHTML = `
      <div
        class="worldnotes"
        style="border-left-color:var(--green)"
      >
        <b style="color:var(--green)">
          ${esc(
            getEntityName(bg)
          )}
        </b>

        ${
          entityDescription(bg)
            ? `<p>${esc(
                entityDescription(bg)
              )}</p>`
            : ""
        }

        ${
          bg.features
            ? `<p>
                <b>Feature:</b>
                ${esc(
                  typeof bg.features ===
                  "string"
                    ? bg.features
                    : JSON.stringify(
                        bg.features
                      )
                )}
              </p>`
            : ""
        }

        ${
          skills
            ? `<p>
                <b>Skills:</b>
                ${esc(skills)}
              </p>`
            : ""
        }
      </div>
    `;
  }

  function renderCampaign() {
    const campaign =
      S.campaign;

    const aiBox =
      $("#ai-seed-box");

    if (aiBox) {
      aiBox.style.display =
        campaign?.ai_generated
          ? "block"
          : "none";
    }

    const badge =
      $("#camp-badge");

    if (badge) {
      badge.textContent =
        campaign
          ? campaign.source ===
            "5etools"
            ? "5etools"
            : campaign.source ===
              "local"
              ? "local"
              : campaign.ai_generated
                ? "AI"
                : ""
          : "";
    }

    const box =
      $("#camp-detail");

    if (!box) return;

    if (!campaign) {
      box.innerHTML = "";
      return;
    }

    box.innerHTML = `
      ${
        campaign.setting
          ? `<div class="row">
               <b>setting</b>
               ${esc(
                 campaign.setting
               )}
             </div>`
          : ""
      }

      ${
        campaign.tone
          ? `<div class="row">
               <b>tone</b>
               ${esc(
                 campaign.tone
               )}
             </div>`
          : ""
      }

      ${
        campaign.recommended_level
          ? `<div class="row">
               <b>levels</b>
               ${esc(
                 campaign.recommended_level
               )}
             </div>`
          : ""
      }

      ${
        campaign.world_notes
          ? `<div class="worldnotes">
               ${esc(
                 campaign.world_notes
               )}
             </div>`
          : campaign.description
            ? `<div class="worldnotes">
                 ${esc(
                   campaign.description
                 )}
               </div>`
            : ""
      }

      ${
        campaign.source ===
        "5etools"
          ? `
            <button
              class="btn small"
              id="adv-load"
              type="button"
            >
              📖 load full adventure
            </button>

            <div id="adv-detail"></div>
          `
          : ""
      }
    `;

    $("#adv-load")
      ?.addEventListener(
        "click",
        () =>
          loadAdventure(
            campaign.id
          )
      );
  }

  async function loadAdventure(
    id
  ) {
    const slot =
      $("#adv-detail");

    if (!slot) return;

    try {
      const adventure =
        await getJSON(
          `/api/adventure/${encodeURIComponent(
            id
          )}`
        );

      slot.innerHTML = `
        <div
          class="worldnotes"
          style="border-left-color:var(--purple)"
        >
          <b style="color:var(--purple)">
            ${esc(
              adventure.title ||
              adventure.name ||
              id
            )}
          </b>

          · ${
            safeArray(
              adventure.chapters
            ).length
          } chapters

          · ${
            safeArray(
              adventure.npcs
            ).length
          } NPCs

          ${
            adventure.url
              ? `
                <p>
                  <a
                    href="${esc(
                      adventure.url
                    )}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    open source ↗
                  </a>
                </p>
              `
              : ""
          }
        </div>
      `;
    } catch (error) {
      slot.innerHTML =
        `<p class="empty">
          ${esc(
            String(error)
          )}
        </p>`;
    }
  }

  function renderPortraits() {
    const portrait =
      $("#portrait");

    const picker =
      $("#portrait-pick");

    if (portrait) {
      portrait.textContent =
        S.portrait;
    }

    if (!picker) return;

    picker.innerHTML =
      PORTRAITS.map(
        item => `
          <button
            type="button"
            class="${
              item ===
              S.portrait
                ? "on"
                : ""
            }"
            data-portrait="${esc(
              item
            )}"
          >
            ${esc(item)}
          </button>
        `
      ).join("");

    picker.querySelectorAll(
      "[data-portrait]"
    ).forEach(button => {
      button.addEventListener(
        "click",
        () =>
          setPortrait(
            button.dataset
              .portrait
          )
      );
    });
  }

  function setPortrait(
    portrait
  ) {
    S.portrait =
      portrait ||
      "🧙";

    renderPortraits();
  }

  function renderKV() {
    const list =
      $("#kv-list");

    if (!list) return;

    list.innerHTML =
      S.kv.map(
        (item, index) => `
          <span class="chip">
            <span class="k">
              ${esc(item.k)}
            </span>

            ${esc(item.v)}

            <span
              class="del"
              data-kv-delete="${index}"
            >
              ✕
            </span>
          </span>
        `
      ).join("");

    list.querySelectorAll(
      "[data-kv-delete]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          dropKV(
            Number(
              element.dataset
                .kvDelete
            )
          )
      );
    });
  }

  function dropKV(index) {
    S.kv.splice(
      index,
      1
    );

    renderKV();
  }

  function addKV() {
    const key =
      val("kv-key");

    const value =
      val("kv-val");

    if (!key) return;

    S.kv.push({
      k: key,
      v: value
    });

    const keyInput =
      $("#kv-key");

    const valueInput =
      $("#kv-val");

    if (keyInput) {
      keyInput.value = "";
    }

    if (valueInput) {
      valueInput.value = "";
    }

    renderKV();
  }

  function addSecretRow(
    listId,
    item = null
  ) {
    const parent =
      $(listId);

    if (!parent) return;

    const row =
      document.createElement(
        "div"
      );

    row.className =
      "secret-row";

    row.innerHTML = `
      <input
        type="text"
        placeholder="Title"
        value="${esc(
          item?.title || ""
        )}"
      >

      <textarea
        placeholder="Description"
        style="min-height:44px"
      >${esc(
        item?.description ||
        ""
      )}</textarea>

      <button
        type="button"
        class="secret-remove"
      >
        ✕
      </button>
    `;

    row.querySelector(
      ".secret-remove"
    )?.addEventListener(
      "click",
      () =>
        row.remove()
    );

    parent.appendChild(
      row
    );
  }

  function readSecretRows(
    id
  ) {
    const parent =
      $(id);

    if (!parent) return [];

    return [
      ...parent.querySelectorAll(
        ".secret-row"
      )
    ]
      .map(row => ({
        title:
          row.querySelector(
            "input"
          )?.value.trim() || "",

        description:
          row.querySelector(
            "textarea"
          )?.value.trim() || "",

        revealed: false
      }))
      .filter(
        item =>
          item.title ||
          item.description
      );
  }

  function byName(
    list,
    name
  ) {
    const needle =
      String(name || "")
        .toLowerCase();

    return safeArray(list)
      .find(
        entity =>
          getEntityName(entity)
            .toLowerCase() ===
          needle
      );
  }

  function lookupSkill(id) {
    const skill =
      findEntity(
        "skill",
        id
      );

    if (!skill) return;

    modalOpen(`
      <h3>
        ${esc(
          getEntityName(skill)
        )}
      </h3>

      <div class="msub">
        ${esc(
          skill.ability_label ||
          skill.ability ||
          skill.ability_id ||
          ""
        )}
        ${
          skill.sourcebook
            ? ` · ${esc(
                skill.sourcebook
              )}`
            : ""
        }
      </div>

      <p>
        ${esc(
          entityDescription(
            skill
          ) ||
          "no description"
        )}
      </p>
    `);
  }

  function lookupSpell(id) {
    lookupPower(id);
  }

  function lookupPower(id) {
    const power =
      findEntity(
        "spell",
        id
      );

    if (!power) return;

    const mechanics =
      power.mechanics || {};

    const components =
      [
        power.verbal
          ? "V"
          : null,
        power.somatic
          ? "S"
          : null,
        power.material
          ? "M"
          : null
      ].filter(Boolean);

    modalOpen(`
      <h3>
        ${esc(
          getEntityName(power)
        )}
      </h3>

      <div class="msub">
        ${esc(
          power.level_name ||
          power.level ||
          power.category ||
          ""
        )}

        ${
          power.school
            ? ` · ${esc(
                power.school
              )}`
            : ""
        }
      </div>

      <div class="facts">
        ${
          mechanics.casting_time ||
          power.time
            ? `
              <span class="chip">
                <span class="k">cast</span>
                ${esc(
                  mechanics.casting_time ||
                  power.time
                )}
              </span>
            `
            : ""
        }

        ${
          mechanics.range ||
          power.range
            ? `
              <span class="chip">
                <span class="k">range</span>
                ${esc(
                  mechanics.range ||
                  power.range
                )}
              </span>
            `
            : ""
        }

        ${
          mechanics.duration ||
          power.duration
            ? `
              <span class="chip">
                <span class="k">dur</span>
                ${esc(
                  mechanics.duration ||
                  power.duration
                )}
              </span>
            `
            : ""
        }

        ${
          components.length
            ? `
              <span class="chip">
                <span class="k">comp</span>
                ${esc(
                  components.join(",")
                )}
              </span>
            `
            : ""
        }
      </div>

      <p>
        ${esc(
          entityDescription(
            power
          ) ||
          "no description"
        )}
      </p>
    `);
  }

  function rewardItems(value) {
    if (!value) return [];

    if (
      Array.isArray(value)
    ) {
      return value
        .flatMap(
          rewardItems
        );
    }

    if (
      typeof value ===
      "string"
    ) {
      return [
        {
          name: value,
          description: ""
        }
      ];
    }

    if (
      typeof value ===
      "object"
    ) {
      return [
        {
          name:
            value.name ||
            value.label ||
            value.id ||
            "reward",
          description:
            value.description ||
            value.desc ||
            value.text ||
            ""
        }
      ];
    }

    return [];
  }

  function collectEntityRewards(
    entity,
    type
  ) {
    if (!entity) return [];

    const output = [];

    [
      entity.features,
      entity.feature,
      entity.rewards,
      entity.effects,
      entity.benefits,
      entity.traits,
      entity.bonuses
    ].forEach(value => {
      rewardItems(value)
        .forEach(item =>
          output.push({
            ...item,
            source:
              type
          })
        );
    });

    return output;
  }

  function renderBuildDock() {
    const dock =
      $("#build-dock");

    const body =
      $("#dock-body");

    const meta =
      $("#dock-meta");

    if (!body) return;

    const selected =
      Object.entries(
        S.choices || {}
      ).flatMap(
        ([type, value]) => {
          const values =
            Array.isArray(value)
              ? value
              : [value];

          return values
            .filter(Boolean)
            .map(id => {
              const entity =
                findEntity(
                  type,
                  id
                );

              return {
                type,
                id,
                entity
              };
            });
        }
      );

    const rewards =
      selected.flatMap(
        item =>
          collectEntityRewards(
            item.entity,
            item.type
          )
      );

    const rows = [
      ...selected.map(
        item => ({
          label:
            componentLabel(
              item.type
            ),
          value:
            getEntityName(
              item.entity
            ) ||
            item.id
        })
      ),
      ...Object.entries(
        S.abilities || {}
      ).map(
        ([key, value]) => ({
          label:
            getAbilityDefinition(
              key
            ).name ||
            titleCase(key),
          value
        })
      )
    ];

    if (meta) {
      meta.textContent =
        `${rows.length} choices · ${rewards.length} resolved features`;
    }

    body.innerHTML = `
      ${
        rows.length
          ? `
            <div class="kb-list">
              ${rows.map(
                row => `
                  <div class="kb-item">
                    <div class="ti">
                      ${esc(
                        row.label
                      )}
                    </div>
                    <div class="sub">
                      ${esc(
                        row.value
                      )}
                    </div>
                  </div>
                `
              ).join("")}
            </div>
          `
          : '<p class="empty">Nothing selected yet.</p>'
      }

      ${
        rewards.length
          ? `
            <div class="kb-list">
              ${rewards.map(
                reward => `
                  <div class="kb-item">
                    <div class="ti">
                      ${esc(
                        reward.name
                      )}
                    </div>
                    <div class="sub">
                      ${esc(
                        reward.description
                      )}
                    </div>
                  </div>
                `
              ).join("")}
            </div>
          `
          : ""
      }
    `;

    if (dock) {
      dock.style.display =
        rows.length ||
        rewards.length
          ? ""
          : "none";
    }
  }

  function refreshAcquireCount() {
    const count =
      $("#acquire-count");

    if (!count) return;

    let total = 0;

    total += Object.keys(
      S.choices || {}
    ).length;

    total += Object.keys(
      S.selections?.skills ||
      {}
    ).length;

    total +=
      S.selections?.spells
        ?.size || 0;

    total +=
      S.selections?.feats
        ?.size || 0;

    total +=
      S.selections?.items
        ?.size || 0;

    total +=
      S.selections?.talents
        ?.size || 0;

    count.textContent =
      String(total);
  }

  function collectAbilities() {
    const rules =
      getAbilityRules();

    const result = {};

    getAbilityKeys()
      .forEach(key => {
        const definition =
          getAbilityDefinition(
            key
          );

        result[key] =
          S.abilities[key] ??
          definition.default ??
          rules.default ??
          0;
      });

    return result;
  }

  function collectSelections() {
    return {
      choices: clone(
        S.choices || {}
      ),

      skills: Object.entries(
        S.selections?.skills ||
        {}
      )
        .filter(
          ([, value]) =>
            value
        )
        .map(
          ([id, level]) => ({
            id,
            level
          })
        ),

      spells: [
        ...(S.selections?.spells ||
          [])
      ],

      feats: [
        ...(S.selections?.feats ||
          [])
      ],

      items: [
        ...(S.selections?.items ||
          [])
      ],

      talents: [
        ...(S.selections?.talents ||
          [])
      ]
    };
  }

  function collectCampaign() {
    if (!S.campaign) {
      return null;
    }

    return {
      id:
        S.campaign.id,
      title:
        S.campaign.title ||
        S.campaign.name ||
        "",
      source:
        S.campaign.source ||
        "",
      ai_generated:
        !!S.campaign.ai_generated,
      seed:
        S.campaign.ai_generated
          ? val("ai-seed")
          : undefined
    };
  }

  function collect() {
    const custom = {};

    S.kv.forEach(item => {
      if (item.k) {
        custom[item.k] =
          item.v;
      }
    });

    const ancestryType =
      S.rules?.components?.ancestry
        ? "ancestry"
        : "race";

    const heritageType =
      S.rules?.components?.heritage
        ? "heritage"
        : "subrace";

    const selectedAncestry =
      S.choices?.[
        ancestryType
      ] || "";

    const selectedHeritage =
      S.choices?.[
        heritageType
      ] || "";

    const selectedClass =
      S.choices?.class || "";

    const selectedSubclass =
      S.choices?.subclass ||
      "";

    const selectedBackground =
      S.choices?.background ||
      "";

    custom.race_detail =
      getEntityName(
        findEntity(
          ancestryType,
          selectedAncestry
        ) || {
          name:
            selectedAncestry
        }
      );

    if (selectedHeritage) {
      custom.subrace =
        getEntityName(
          findEntity(
            heritageType,
            selectedHeritage
          ) || {
            name:
              selectedHeritage
          }
        );
    }

    custom.class_detail =
      getEntityName(
        findEntity(
          "class",
          selectedClass
        ) || {
          name:
            selectedClass
        }
      );

    if (selectedSubclass) {
      custom.subclass =
        getEntityName(
          findEntity(
            "subclass",
            selectedSubclass
          ) || {
            name:
              selectedSubclass
          }
        );
    }

    if (selectedBackground) {
      custom.background =
        getEntityName(
          findEntity(
            "background",
            selectedBackground
          ) || {
            name:
              selectedBackground
          }
        );
    }

    const abilities =
      collectAbilities();

    const skillsText =
      Object.entries(
        S.selections?.skills ||
        {}
      )
        .map(
          ([id, level]) =>
            `${getEntityName(
              findEntity(
                "skill",
                id
              ) || {
                name: id
              }
            )} (${level})`
        )
        .concat(
          val(
            "f-skills-extra"
          )
            ? [
                val(
                  "f-skills-extra"
                )
              ]
            : []
        )
        .join(", ");

    const powerIds = [
      ...(S.selections?.spells ||
        [])
    ];

    const powerText =
      powerIds
        .map(id =>
          getEntityName(
            findEntity(
              "spell",
              id
            ) || {
              name: id
            }
          )
        )
        .join(", ");

    const level =
      rulesCapability("levels")
        ? getCurrentLevel()
        : null;

    return {
      schema_version: 2,

      system:
        S.system?.id ||
        S.rules?.system?.id ||
        "",

      system_version:
        S.rules?.system?.version ||
        S.system?.version ||
        null,

      system_label:
        S.system?.label ||
        S.system?.name ||
        S.rules?.system?.name ||
        "",

      visibility: {
        hidden_revealed:
          !!$("#h-revealed")
            ?.checked
      },

      campaign:
        collectCampaign(),

      choices:
        clone(
          S.choices || {}
        ),

      selections:
        collectSelections(),

      resources:
        clone(
          S.resources || {}
        ),

      abilities: {
        scores: abilities,
        notes:
          val(
            "f-abil-notes"
          )
      },

      identity: {
        name:
          val("f-name"),
        player_name:
          val("f-player"),
        level,
        portrait:
          S.portrait,
        gender:
          val("f-gender"),
        age:
          val("f-age"),
        appearance:
          val("f-appearance")
      },

      background: {
        id:
          selectedBackground ||
          null,
        seed:
          val("f-bg"),
        summary:
          val("f-bgs"),
        details:
          val("f-bgdetail")
      },

      details: {
        personality:
          val(
            "f-personality"
          ),
        goals:
          val("f-goals"),
        fears_flaws:
          val("f-flaws"),
        traits:
          val("f-traits"),
        alignment:
          val("f-align"),
        skills:
          skillsText,
        equipment:
          val("f-equipment"),
        spells:
          powerText,
        languages:
          val("f-languages"),
        custom
      },

      public: {
        known_identity:
          val("p-identity"),
        known_backstory:
          val("p-backstory"),
        known_relationships:
          val("p-relations"),
        known_items:
          val("p-items"),
        rumors:
          val("p-rumors")
      },

      hidden: {
        hidden_agendas:
          readSecretRows(
            "agenda-list"
          ),
        secrets:
          readSecretRows(
            "secret-list"
          ),
        dm_notes:
          val("h-dmnotes")
      },

      build: {
        choices:
          clone(
            S.choices || {}
          ),

        proficiencies:
          Object.entries(
            S.selections?.skills ||
            {}
          )
            .filter(
              ([, value]) =>
                value
            )
            .map(
              ([skill, level]) => ({
                skill,
                level
              })
            ),

        spells:
          powerIds.map(id => ({
            id,
            name:
              getEntityName(
                findEntity(
                  "spell",
                  id
                ) || {
                  name: id
                }
              ),
            level:
              findEntity(
                "spell",
                id
              )?.level ??
              0,
            acquired_at:
              S.spellLevels[id] ||
              level ||
              1
          }))
      }
    };
  }

  async function saveCharacter() {
    const button =
      $("#save-btn");

    const message =
      $("#save-msg");

    if (button) {
      button.disabled =
        true;
    }

    if (message) {
      message.className = "";
      message.textContent =
        "Saving…";
    }

    try {
      const payload =
        collect();

      if (
        !payload.identity.name
      ) {
        if (message) {
          message.className =
            "err";
          message.textContent =
            "Give your character a name.";
        }

        return;
      }

      const sheet =
        await postJSON(
          "/api/characters",
          payload
        );

      S.loadedId =
        sheet.id;

      S.currentSheet =
        sheet;

      if (message) {
        message.className =
          "ok";

        message.textContent =
          `Saved → character ${sheet.id}.`;
      }

      const preview =
        $("#preview");

      if (preview) {
        preview.style.display =
          "block";

        preview.textContent =
          JSON.stringify(
            sheet,
            null,
            2
          );
      }

      await refreshSavedStrip();
    } catch (error) {
      console.error(
        "Save failed:",
        error
      );

      if (message) {
        message.className =
          "err";

        message.textContent =
          "Error: " +
          error.message;
      }
    } finally {
      if (button) {
        button.disabled =
          false;
      }
    }
  }

  async function refreshSavedStrip() {
    const strip =
      $("#saved-strip");

    if (!strip) return;

    try {
      const result =
        await getJSON(
          "/api/characters"
        );

      const list =
        Array.isArray(result)
          ? result
          : safeArray(
              result?.characters
            );

      strip.innerHTML =
        list.map(
          character => `
            <span
              class="chip"
              data-load-character="${esc(
                character.id
              )}"
              title="load & manage"
            >
              <b>
                ${esc(
                  character.name ||
                  character.identity
                    ?.name ||
                  "?"
                )}
              </b>

              ${esc(
                character.system_label ||
                character.system ||
                ""
              )}

              <span
                class="del"
                data-delete-character="${esc(
                  character.id
                )}"
              >
                ✕
              </span>
            </span>
          `
        ).join("");

      strip.querySelectorAll(
        "[data-load-character]"
      ).forEach(element => {
        element.addEventListener(
          "click",
          event => {
            if (
              event.target.closest(
                "[data-delete-character]"
              )
            ) {
              return;
            }

            loadSheet(
              element.dataset
                .loadCharacter
            );
          }
        );
      });

      strip.querySelectorAll(
        "[data-delete-character]"
      ).forEach(element => {
        element.addEventListener(
          "click",
          event => {
            event.stopPropagation();

            deleteSheet(
              element.dataset
                .deleteCharacter
            );
          }
        );
      });
    } catch (error) {
      console.error(
        "Could not load saved characters:",
        error
      );

      strip.innerHTML = "";
    }
  }

  async function loadSheet(id) {
    try {
      const sheet =
        await getJSON(
          `/api/characters/${encodeURIComponent(
            id
          )}`
        );

      S.loadedId =
        id;

      S.currentSheet =
        sheet;

      await fillFromSheet(
        sheet
      );

      goStep(
        Math.min(
          stepCount() - 1,
          8
        )
      );
    } catch (error) {
      alert(
        "load failed: " +
        error.message
      );
    }
  }

  function restoreSelections(
    sheet
  ) {
    resetSelections();

    S.choices = {
      ...(sheet.choices || {})
    };

    const selections =
      sheet.selections || {};

    safeArray(
      selections.skills
    ).forEach(skill => {
      if (!skill) return;

      if (
        typeof skill ===
        "string"
      ) {
        S.selections.skills[
          skill
        ] = "trained";
      } else if (skill.id) {
        S.selections.skills[
          skill.id
        ] =
          skill.level ||
          "trained";
      }
    });

    safeArray(
      selections.spells
    ).forEach(power => {
      const id =
        typeof power ===
        "string"
          ? power
          : power?.id ||
            power?.name;

      if (!id) return;

      S.selections.spells.add(
        id
      );

      if (
        typeof power ===
          "object" &&
        power.acquired_at
      ) {
        S.spellLevels[id] =
          power.acquired_at;
      }
    });

    safeArray(
      selections.feats
    ).forEach(feat => {
      const id =
        typeof feat ===
        "string"
          ? feat
          : feat?.id ||
            feat?.name;

      if (id) {
        S.selections.feats.add(
          id
        );
      }
    });

    safeArray(
      selections.items
    ).forEach(item => {
      const id =
        typeof item ===
        "string"
          ? item
          : item?.id ||
            item?.name;

      if (id) {
        S.selections.items.add(
          id
        );
      }
    });

    safeArray(
      selections.talents
    ).forEach(talent => {
      const id =
        typeof talent ===
        "string"
          ? talent
          : talent?.id ||
            talent?.name;

      if (id) {
        S.selections.talents.add(
          id
        );
      }
    });

    if (
      !Object.keys(
        S.choices
      ).length
    ) {
      const identity =
        sheet.identity || {};

      const details =
        sheet.details || {};

      const custom =
        details.custom || {};

      const ancestryType =
        S.rules?.components
          ?.ancestry
          ? "ancestry"
          : "race";

      const heritageType =
        S.rules?.components
          ?.heritage
          ? "heritage"
          : "subrace";

      const race =
        custom.race_detail ||
        identity.race;

      const subrace =
        custom.subrace ||
        "";

      const cls =
        custom.class_detail ||
        identity.class;

      const subclass =
        custom.subclass ||
        "";

      const background =
        custom.background ||
        sheet.background?.seed ||
        "";

      if (race) {
        const entity =
          findEntity(
            ancestryType,
            race
          );

        S.choices[
          ancestryType
        ] =
          entity
            ? getEntityId(
                entity
              )
            : race;
      }

      if (subrace) {
        const entity =
          findEntity(
            heritageType,
            subrace
          );

        S.choices[
          heritageType
        ] =
          entity
            ? getEntityId(
                entity
              )
            : subrace;
      }

      if (cls) {
        const entity =
          findEntity(
            "class",
            cls
          );

        S.choices.class =
          entity
            ? getEntityId(entity)
            : cls;
      }

      if (subclass) {
        const entity =
          findEntity(
            "subclass",
            subclass
          );

        S.choices.subclass =
          entity
            ? getEntityId(entity)
            : subclass;
      }

      if (background) {
        const entity =
          findEntity(
            "background",
            background
          );

        S.choices.background =
          entity
            ? getEntityId(entity)
            : background;
      }
    }

    safeArray(
      sheet.build?.proficiencies
    ).forEach(proficiency => {
      if (
        proficiency?.skill
      ) {
        S.selections.skills[
          proficiency.skill
        ] =
          proficiency.level ||
          "trained";
      }
    });

    safeArray(
      sheet.build?.spells
    ).forEach(spell => {
      const id =
        spell.id ||
        spell.name;

      if (!id) return;

      S.selections.spells.add(
        id
      );

      S.spellLevels[id] =
        spell.acquired_at ||
        spell.level ||
        1;
    });

    if (
      !S.selections.spells.size &&
      sheet.details?.spells
    ) {
      String(
        sheet.details.spells
      )
        .split(",")
        .map(
          item =>
            item.trim()
        )
        .filter(Boolean)
        .forEach(name => {
          const entity =
            findEntity(
              "spell",
              name
            );

          S.selections.spells.add(
            entity
              ? getEntityId(entity)
              : name
          );
        });
    }

    S.prof =
      S.selections.skills;

    S.spells =
      S.selections.spells;

    S.resources = {
      ...(sheet.resources || {})
    };

    if (
      sheet.abilities?.scores
    ) {
      S.abilities = {
        ...sheet.abilities.scores
      };
    } else if (
      sheet.abilities
    ) {
      S.abilities = {
        ...sheet.abilities
      };

      delete S.abilities.notes;
      delete S.abilities.modifiers;
      delete S.abilities._init;
    }

    S.abilityMetaInitialized =
      true;

    syncLegacyState();
  }

  function restoreChoiceFields(
    sheet
  ) {
    const identity =
      sheet.identity || {};

    const details =
      sheet.details || {};

    const background =
      sheet.background || {};

    const publicData =
      sheet.public || {};

    const hidden =
      sheet.hidden || {};

    const fields = {
      "f-name":
        identity.name,
      "f-player":
        identity.player_name,
      "f-level":
        identity.level,
      "f-gender":
        identity.gender,
      "f-age":
        identity.age,
      "f-appearance":
        identity.appearance,
      "f-bg":
        background.seed ||
        background.id,
      "f-bgs":
        background.summary,
      "f-bgdetail":
        background.details,
      "f-personality":
        details.personality,
      "f-goals":
        details.goals,
      "f-flaws":
        details.fears_flaws,
      "f-traits":
        details.traits,
      "f-align":
        details.alignment,
      "f-equipment":
        details.equipment,
      "f-languages":
        details.languages,
      "f-skills-extra":
        details.skills,
      "f-abil-notes":
        sheet.abilities
          ?.notes,
      "p-identity":
        publicData.known_identity,
      "p-backstory":
        publicData.known_backstory,
      "p-relations":
        publicData.known_relationships,
      "p-items":
        publicData.known_items,
      "p-rumors":
        publicData.rumors,
      "h-dmnotes":
        hidden.dm_notes
    };

    Object.entries(
      fields
    ).forEach(
      ([id, value]) => {
        const element =
          $(`#${id}`);

        if (element) {
          element.value =
            value ?? "";
        }
      }
    );

    const revealed =
      $("#h-revealed");

    if (revealed) {
      revealed.checked =
        !!sheet.visibility
          ?.hidden_revealed;
    }

    S.portrait =
      identity.portrait ||
      "🧙";

    S.kv =
      Object.entries(
        details.custom || {}
      )
        .filter(
          ([key]) =>
            ![
              "race_detail",
              "subrace",
              "class_detail",
              "subclass",
              "background"
            ].includes(key)
        )
        .map(
          ([k, v]) => ({
            k,
            v
          })
        );

    const agenda =
      $("#agenda-list");

    if (agenda) {
      agenda.innerHTML = "";

      safeArray(
        hidden.hidden_agendas
      ).forEach(item =>
        addSecretRow(
          "agenda-list",
          item
        )
      );
    }

    const secrets =
      $("#secret-list");

    if (secrets) {
      secrets.innerHTML = "";

      safeArray(
        hidden.secrets
      ).forEach(item =>
        addSecretRow(
          "secret-list",
          item
        )
      );
    }

    const campaign =
      sheet.campaign;

    if (campaign) {
      S.campaign =
        S.campaigns.find(
          item =>
            String(item.id) ===
            String(campaign.id)
        ) || {
          ...campaign
        };
    } else {
      S.campaign = null;
    }
  }

  async function fillFromSheet(
    sheet
  ) {
    if (!sheet) {
      throw new Error(
        "Empty character sheet."
      );
    }

    const systemId =
      sheet.system ||
      sheet.system_id;

    if (
      systemId &&
      !S.games[systemId]
    ) {
      try {
        const games =
          await loadGames();

        if (
          !games[systemId]
        ) {
          S.games[systemId] = {
            id: systemId,
            name:
              sheet.system_label ||
              systemId
          };
        }
      } catch {}
    }

    if (systemId) {
      await selectSystem(
        systemId
      );
    }

    S.currentSheet =
      sheet;

    restoreSelections(
      sheet
    );

    restoreChoiceFields(
      sheet
    );

    initializeAbilities();

    renderAll();

    await renderManage(
      sheet
    );
  }

  async function renderManage(
    sheet
  ) {
    const empty =
      $("#manage-empty-card");

    const body =
      $("#manage-body");

    if (empty) {
      empty.style.display =
        "none";
    }

    if (body) {
      body.style.display =
        "block";
    }

    if (!sheet) return;

    const identity =
      sheet.identity || {};

    const details =
      sheet.details || {};

    const progression =
      sheet.progression || {};

    const mgName =
      $("#mg-name");

    if (mgName) {
      mgName.textContent =
        identity.name ||
        "?";
    }

    const mgSystem =
      $("#mg-system");

    if (mgSystem) {
      mgSystem.textContent =
        sheet.system_label ||
        sheet.system ||
        "";
    }

    const mgLevel =
      $("#mg-level");

    if (mgLevel) {
      mgLevel.textContent =
        identity.level != null
          ? `level ${identity.level}`
          : "";
    }

    const chips =
      $("#mg-chips");

    if (chips) {
      const choiceChips =
        Object.entries(
          sheet.choices || {}
        ).flatMap(
          ([type, value]) => {
            const values =
              Array.isArray(value)
                ? value
                : [value];

            return values
              .filter(Boolean)
              .map(id => `
                <span class="chip">
                  <span class="k">
                    ${esc(
                      componentLabel(
                        type
                      )
                    )}
                  </span>

                  ${esc(
                    getEntityName(
                      findEntity(
                        type,
                        id
                      ) || {
                        name: id
                      }
                    )
                  )}
                </span>
              `);
          }
        );

      if (details.alignment) {
        choiceChips.push(`
          <span class="chip">
            <span class="k">align</span>
            ${esc(
              details.alignment
            )}
          </span>
        `);
      }

      if (
        sheet.campaign?.title
      ) {
        choiceChips.push(`
          <span class="chip">
            <span class="k">campaign</span>
            ${esc(
              sheet.campaign.title
            )}
          </span>
        `);
      }

      chips.innerHTML =
        choiceChips.join("");
    }

    const abilityBox =
      $("#mg-abilities");

    if (abilityBox) {
      let scores =
        sheet.abilities?.scores;

      if (
        !scores ||
        typeof scores !==
          "object"
      ) {
        scores =
          sheet.abilities || {};
      }

      const filtered =
        Object.entries(scores)
          .filter(
            ([key]) =>
              ![
                "notes",
                "modifiers",
                "_init"
              ].includes(key)
          );

      const modifiers =
        sheet.abilities
          ?.modifiers || {};

      abilityBox.innerHTML =
        filtered
          .map(
            ([key, value]) => {
              const definition =
                getAbilityDefinition(
                  key
                );

              const modifier =
                modifiers[key] ??
                abilityModifier(
                  value,
                  definition
                );

              return `
                <div class="ab-tile">
                  <div class="abname">
                    <span>
                      ${esc(
                        definition.name ||
                        titleCase(key)
                      )}
                    </span>

                    <span>
                      ${esc(
                        definition.icon ||
                        ABILITY_ICONS[
                          key
                        ] ||
                        "🎲"
                      )}
                    </span>
                  </div>

                  <div
                    class="modline"
                    style="
                      font-size:26px;
                      color:var(--gold2)
                    "
                  >
                    <b>
                      ${esc(value)}
                    </b>
                  </div>

                  <div class="modline">
                    mod ${esc(
                      fmtMod(
                        modifier
                      )
                    )}
                  </div>
                </div>
              `;
            }
          )
          .join("") ||
        '<p class="empty">no ability scores</p>';
    }

    const buffs = [];

    Object.entries(
      sheet.choices || {}
    ).forEach(
      ([type, value]) => {
        const values =
          Array.isArray(value)
            ? value
            : [value];

        values.forEach(id => {
          const entity =
            findEntity(
              type,
              id
            );

          if (!entity) return;

          collectEntityRewards(
            entity,
            type
          ).forEach(row => {
            buffs.push({
              src:
                componentLabel(
                  type
                ),
              name:
                row.name,
              desc:
                row.description
            });
          });
        });
      }
    );

    const buffsBox =
      $("#mg-buffs");

    if (buffsBox) {
      buffsBox.innerHTML =
        buffs.length
          ? `
            <div class="kb-list">
              ${buffs.map(
                buff => `
                  <div class="kb-item">
                    <div class="ti">
                      ${esc(
                        buff.name
                      )}

                      <span class="tag">
                        ${esc(
                          buff.src
                        )}
                      </span>
                    </div>

                    <div class="sub">
                      ${esc(
                        buff.desc ||
                        ""
                      ).slice(
                        0,
                        160
                      )}
                    </div>
                  </div>
                `
              ).join("")}
            </div>
          `
          : `
            <p class="empty">
              no resolved features
            </p>
          `;
    }

    renderInventory(
      sheet.inventory || []
    );

    const levelValue =
      $("#mg-level-val");

    if (levelValue) {
      levelValue.textContent =
        identity.level ||
        1;
    }

    const xpValue =
      $("#mg-xp-val");

    if (xpValue) {
      xpValue.textContent =
        progression.xp ||
        0;
    }

    const xpNext =
      $("#mg-xp-next");

    if (xpNext) {
      const xpLevels =
        S.rules?.progression
          ?.xp_levels ||
        S.system?.progression
          ?.xp_levels ||
        [];

      const xp =
        numberOr(
          progression.xp,
          0
        );

      const next =
        xpLevels
          .map(item =>
            typeof item ===
            "object"
              ? item.xp
              : item
          )
          .map(Number)
          .filter(
            value =>
              Number.isFinite(
                value
              ) &&
              value > xp
          )
          .sort(
            (a, b) =>
              a - b
          )[0];

      xpNext.textContent =
        next != null
          ? `next level at ${next} xp`
          : "max level";
    }

    renderMessages(
      sheet.hidden || {}
    );

    await loadParty(
      sheet.id
    );
  }

  async function loadParty(
    sheetId
  ) {
    const badge =
      $("#mg-party-badge");

    try {
      const result =
        await getJSON(
          `/api/characters/${encodeURIComponent(
            sheetId
          )}/party`
        );

      S.party =
        Array.isArray(result)
          ? result
          : safeArray(
              result?.party
            );
    } catch (error) {
      console.error(
        "Party load failed:",
        error
      );

      S.party = [];
    }

    if (badge) {
      badge.textContent =
        `${S.party.length} other${
          S.party.length === 1
            ? ""
            : "s"
        }`;
    }

    S.whisperTarget =
      null;

    renderParty();
  }

  function renderParty() {
    const box =
      $("#mg-party");

    if (!box) return;

    if (!S.party.length) {
      box.innerHTML =
        '<p class="empty">no other characters saved yet — create more sheets to enable whispers.</p>';
      return;
    }

    box.innerHTML =
      S.party.map(
        person => `
          <div
            class="opt-card ${
              S.whisperTarget ===
              person.id
                ? "selected"
                : ""
            }"
            data-party-id="${esc(
              person.id
            )}"
          >
            <div class="oc-name">
              ${esc(
                person.portrait ||
                "👤"
              )}

              ${esc(
                person.name ||
                person.identity?.name ||
                "?"
              )}
            </div>

            <div class="oc-sub">
              ${esc(
                person.race ||
                person.ancestry ||
                ""
              )}

              ${
                (
                  person.race ||
                  person.ancestry
                ) &&
                person.class
                  ? " · "
                  : ""
              }

              ${esc(
                person.class ||
                ""
              )}

              ${
                person.level
                  ? ` · level ${esc(
                      person.level
                    )}`
                  : ""
              }
            </div>

            ${
              person.player
                ? `
                  <div
                    class="oc-sub"
                    style="color:var(--muted)"
                  >
                    played by
                    ${esc(
                      person.player
                    )}
                  </div>
                `
                : ""
            }
          </div>
        `
      ).join("");

    box.querySelectorAll(
      "[data-party-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          pickWhisperTarget(
            element.dataset
              .partyId
          )
      );
    });
  }

  function pickWhisperTarget(
    id
  ) {
    S.whisperTarget =
      id;

    renderParty();

    const target =
      S.party.find(
        person =>
          String(person.id) ===
          String(id)
      );

    const input =
      $("#mg-whisper-text");

    if (input) {
      input.placeholder =
        target
          ? `whisper to ${target.name}…`
          : "private note to send…";
    }
  }

  async function mgWhisper() {
    if (!S.loadedId) return;

    const message =
      $("#mg-whisper-msg");

    if (!S.whisperTarget) {
      if (message) {
        message.textContent =
          "pick a party member first";

        message.style.color =
          "var(--red)";
      }

      return;
    }

    const text =
      val("mg-whisper-text");

    if (!text) return;

    try {
      await postJSON(
        `/api/characters/${encodeURIComponent(
          S.loadedId
        )}/whisper`,
        {
          to:
            S.whisperTarget,
          text,
          kind:
            "whisper"
        }
      );

      if (message) {
        message.textContent =
          "whispered ✓";

        message.style.color =
          "var(--green)";
      }

      const input =
        $("#mg-whisper-text");

      if (input) {
        input.value = "";
      }
    } catch (error) {
      if (message) {
        message.textContent =
          "error: " +
          error.message;

        message.style.color =
          "var(--red)";
      }
    }
  }

  function renderInventory(
    inventory
  ) {
    const box =
      $("#mg-inventory");

    if (!box) return;

    const list =
      safeArray(inventory);

    box.innerHTML =
      list.map(
        (item, index) => `
          <span class="chip">
            ${esc(
              item.name ||
              item.id ||
              "item"
            )}

            ${
              item.qty > 1
                ? ` <b>x${esc(
                    item.qty
                  )}</b>`
                : ""
            }

            <span
              class="del"
              data-remove-item="${index}"
            >
              ✕
            </span>
          </span>
        `
      ).join("") ||
      '<span class="empty">empty</span>';

    box.querySelectorAll(
      "[data-remove-item]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          removeItem(
            Number(
              element.dataset
                .removeItem
            )
          )
      );
    });
  }

  async function mgAddItem() {
    const name =
      val("mg-item-name");

    if (
      !name ||
      !S.loadedId
    ) {
      return;
    }

    try {
      await postJSON(
        `/api/characters/${encodeURIComponent(
          S.loadedId
        )}/inventory`,
        {
          name,
          qty:
            parseInt(
              val("mg-item-qty"),
              10
            ) || 1
        }
      );

      const input =
        $("#mg-item-name");

      if (input) {
        input.value = "";
      }

      await reloadLoaded();
    } catch (error) {
      console.error(
        "Could not add item:",
        error
      );
    }
  }

  async function removeItem(
    index
  ) {
    if (!S.loadedId) return;

    try {
      await getJSON(
        `/api/characters/${encodeURIComponent(
          S.loadedId
        )}/inventory/${index}`,
        {
          method: "DELETE"
        }
      );

      await reloadLoaded();
    } catch (error) {
      console.error(
        "Could not remove item:",
        error
      );
    }
  }

  async function mgAwardXp() {
    if (!S.loadedId) return;

    const amount =
      parseInt(
        val("mg-xp-amount"),
        10
      ) || 0;

    if (!amount) return;

    try {
      const result =
        await postJSON(
          `/api/characters/${encodeURIComponent(
            S.loadedId
          )}/xp`,
          {
            amount
          }
        );

      const message =
        $("#mg-xp-msg");

      if (message) {
        message.textContent =
          result.leveled_up
            ? `🎉 leveled up to ${result.level}!`
            : `xp ${result.xp}`;

        message.style.color =
          result.leveled_up
            ? "var(--green)"
            : "var(--muted)";
      }

      await reloadLoaded();
    } catch (error) {
      const message =
        $("#mg-xp-msg");

      if (message) {
        message.textContent =
          "error: " +
          error.message;

        message.style.color =
          "var(--red)";
      }
    }
  }

  async function mgSendMessage() {
    if (!S.loadedId) return;

    const text =
      val("mg-msg-text");

    if (!text) return;

    try {
      await postJSON(
        `/api/characters/${encodeURIComponent(
          S.loadedId
        )}/messages`,
        {
          text,
          from: "DM",
          kind: "note"
        }
      );

      const input =
        $("#mg-msg-text");

      if (input) {
        input.value = "";
      }

      await reloadLoaded();
    } catch (error) {
      console.error(
        "Could not send message:",
        error
      );
    }
  }

  function renderMessages(
    hidden
  ) {
    const messages =
      safeArray(
        hidden.messages
      );

    const badge =
      $("#mg-msg-badge");

    const unread =
      messages.filter(
        message =>
          !message.read
      ).length;

    if (badge) {
      badge.textContent =
        `${messages.length} msg${
          messages.length === 1
            ? ""
            : "s"
        }` +
        (
          unread
            ? ` · ${unread} unread`
            : ""
        );
    }

    const box =
      $("#mg-messages");

    if (!box) return;

    box.innerHTML =
      messages
        .slice()
        .reverse()
        .map(message => {
          const icon =
            message.kind ===
            "levelup"
              ? "🎉"
              : message.kind ===
                "whisper"
                ? "🗣"
                : "🕯";

          const who =
            message.kind ===
              "whisper" &&
            message.to
              ? `→ ${esc(
                  message.to
                )}`
              : "";

          return `
            <div
              class="kb-item"
              data-message-id="${esc(
                message.id
              )}"
              style="${
                message.read
                  ? "opacity:.55"
                  : ""
              }"
            >
              <div class="ti">
                ${icon}

                <b>
                  ${esc(
                    message.from ||
                    "DM"
                  )}
                </b>

                ${who}

                <span class="tag">
                  ${esc(
                    message.kind ||
                    "note"
                  )}
                </span>

                ${
                  message.read
                    ? ""
                    : `
                      <span
                        class="tag"
                        style="color:var(--gold)"
                      >
                        new
                      </span>
                    `
                }
              </div>

              <div class="sub">
                ${esc(
                  message.text ||
                  ""
                )}

                <i
                  style="color:var(--faint)"
                >
                  — ${esc(
                    String(
                      message.created_at ||
                      ""
                    ).slice(
                      0,
                      16
                    )
                  )}
                </i>
              </div>
            </div>
          `;
        })
        .join("") ||
      '<p class="empty">no hidden messages yet</p>';

    box.querySelectorAll(
      "[data-message-id]"
    ).forEach(element => {
      element.addEventListener(
        "click",
        () =>
          markRead(
            element.dataset
              .messageId
          )
      );
    });
  }

  async function markRead(
    id
  ) {
    if (!S.loadedId) return;

    try {
      await getJSON(
        `/api/characters/${encodeURIComponent(
          S.loadedId
        )}/messages/${encodeURIComponent(
          id
        )}/read`,
        {
          method: "POST"
        }
      );

      await reloadLoaded();
    } catch (error) {
      console.error(
        "Could not mark message read:",
        error
      );
    }
  }

  async function reloadLoaded() {
    if (!S.loadedId) return;

    try {
      const sheet =
        await getJSON(
          `/api/characters/${encodeURIComponent(
            S.loadedId
          )}`
        );

      S.currentSheet =
        sheet;

      if (
        sheet.system &&
        sheet.system !==
          S.system?.id
      ) {
        await fillFromSheet(
          sheet
        );
        return;
      }

      await renderManage(
        sheet
      );
    } catch (error) {
      console.error(
        "Could not reload character:",
        error
      );
    }
  }

  async function deleteSheet(id) {
    if (
      !confirm(
        "Delete this character sheet?"
      )
    ) {
      return;
    }

    try {
      await getJSON(
        `/api/characters/${encodeURIComponent(
          id
        )}`,
        {
          method: "DELETE"
        }
      );

      if (
        String(
          S.loadedId
        ) === String(id)
      ) {
        S.loadedId =
          null;

        S.currentSheet =
          null;

        const manageBody =
          $("#manage-body");

        const manageEmpty =
          $("#manage-empty-card");

        if (manageBody) {
          manageBody.style.display =
            "none";
        }

        if (manageEmpty) {
          manageEmpty.style.display =
            "block";
        }
      }

      await refreshSavedStrip();
    } catch (error) {
      alert(
        "Delete failed: " +
        error.message
      );
    }
  }

  function _classForDock() {
    return (
      findEntity(
        "class",
        S.choices?.class
      ) ||
      S.class ||
      null
    );
  }

  function _subclassForDock() {
    return (
      findEntity(
        "subclass",
        S.choices?.subclass
      ) ||
      S.subclass ||
      null
    );
  }

  function _rewardItems(value) {
    return rewardItems(value);
  }

  function casterProg() {
    return 1;
  }

  function maxSpellLevelAt(
    characterLevel
  ) {
    const progression =
      S.rules?.spellcasting
        ?.progression ||
      S.rules?.progression
        ?.spellcasting;

    if (
      progression?.max_spell_level !=
      null
    ) {
      if (
        typeof progression
          .max_spell_level ===
        "object"
      ) {
        return (
          progression
            .max_spell_level[
            characterLevel
          ] ?? null
        );
      }

      return progression
        .max_spell_level;
    }

    return null;
  }

  function toggleCasterSpell(
    id
  ) {
    toggleSpell(id);
  }

  function modalOpen(html) {
    const background =
      $("#modal-bg");

    const content =
      $("#modal-content");

    if (!background || !content) {
      return;
    }

    content.innerHTML =
      html;

    background.style.display =
      "flex";
  }

  function modalClose() {
    const background =
      $("#modal-bg");

    if (background) {
      background.style.display =
        "none";
    }
  }

  function bindEvents() {
    $("#nav-back")
      ?.addEventListener(
        "click",
        () =>
          goStep(
            S.step - 1
          )
      );

    $("#nav-next")
      ?.addEventListener(
        "click",
        () =>
          goStep(
            S.step + 1
          )
      );

    $("#save-btn")
      ?.addEventListener(
        "click",
        saveCharacter
      );

    $("#kv-add-btn")
      ?.addEventListener(
        "click",
        addKV
      );

    $("#agenda-add")
      ?.addEventListener(
        "click",
        () =>
          addSecretRow(
            "agenda-list"
          )
      );

    $("#secret-add")
      ?.addEventListener(
        "click",
        () =>
          addSecretRow(
            "secret-list"
          )
      );

    $("#mg-item-add")
      ?.addEventListener(
        "click",
        mgAddItem
      );

    $("#mg-xp-award")
      ?.addEventListener(
        "click",
        mgAwardXp
      );

    $("#mg-msg-send")
      ?.addEventListener(
        "click",
        mgSendMessage
      );

    $("#mg-whisper-send")
      ?.addEventListener(
        "click",
        mgWhisper
      );

    $("#build-toggle")
      ?.addEventListener(
        "click",
        () => {
          const dock =
            $("#build-dock");

          if (!dock) return;

          dock.style.display =
            dock.style.display ===
            "none"
              ? ""
              : "none";
        }
      );

    $("#build-close")
      ?.addEventListener(
        "click",
        () => {
          const dock =
            $("#build-dock");

          if (dock) {
            dock.style.display =
              "none";
          }
        }
      );

    $("#modal-close")
      ?.addEventListener(
        "click",
        modalClose
      );

    $("#modal-bg")
      ?.addEventListener(
        "click",
        event => {
          if (
            event.target ===
            event.currentTarget
          ) {
            modalClose();
          }
        }
      );

    $("#f-bg")
      ?.addEventListener(
        "input",
        renderBackground
      );

    $("#f-level")
      ?.addEventListener(
        "change",
        () => {
          renderLevels();
          renderBuildDock();
        }
      );

    [
      "f-name",
      "f-player",
      "f-bgs",
      "f-bgdetail",
      "f-personality",
      "f-goals",
      "f-flaws",
      "f-traits",
      "f-align",
      "f-equipment",
      "f-languages",
      "f-skills-extra",
      "f-abil-notes"
    ].forEach(id => {
      $(`#${id}`)
        ?.addEventListener(
          "input",
          renderBuildDock
        );
    });

    $("#f-campaign")
      ?.addEventListener(
        "change",
        () => {
          const id =
            val(
              "f-campaign"
            );

          S.campaign =
            S.campaigns.find(
              campaign =>
                String(
                  campaign.id
                ) ===
                String(id)
            ) || null;

          renderCampaign();
        }
      );
  }

  async function boot() {
    try {
      await loadGames();

      const gameIds =
        Object.keys(
          S.games
        );

      if (!gameIds.length) {
        S.rules =
          normalizeRules({});

        renderAll();
        goStep(0);
        return;
      }

      const savedSystem =
        S.pendingSheet?.system ||
        null;

      const firstSystem =
        savedSystem &&
        S.games[savedSystem]
          ? savedSystem
          : gameIds[0];

      await selectSystem(
        firstSystem
      );

      await refreshSavedStrip();

      renderAll();
      goStep(0);
    } catch (error) {
      console.error(
        "Boot failed:",
        error
      );

      const narrative =
        $("#system-narrate");

      if (narrative) {
        narrative.innerHTML = `
          <p class="empty">
            Could not load game systems:
            ${esc(
              error.message
            )}
          </p>
        `;
      }
    }
  }

  window.TabletopCharacterForge = {
    state: S,
    normalizeRules,
    rulesComponent,
    rulesCapability,
    findEntity,
    collect,
    saveCharacter,
    loadSheet,
    selectSystem,
    renderAll
  };

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        bindEvents();
        boot();
      },
      {
        once: true
      }
    );
  } else {
    bindEvents();
    boot();
  }
})();