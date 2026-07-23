const STORAGE_KEY = "fridge-leftovers-inventory-v2";

const todayIso = () => new Date().toISOString().slice(0, 10);

const DEFAULT_INVENTORY = [
  { id: "cabbage", name: "キャベツ", quantity: 180, unit: "g", location: "冷蔵", priority: true, active: true, confirmedAt: todayIso(), step: 50 },
  { id: "eggs", name: "卵", quantity: 3, unit: "個", location: "冷蔵", priority: false, active: true, confirmedAt: todayIso(), step: 1 },
  { id: "mushroom", name: "しめじ", quantity: 0.5, unit: "株", location: "冷蔵", priority: false, active: true, confirmedAt: todayIso(), step: 0.25 },
  { id: "pork", name: "豚こま", quantity: 120, unit: "g", location: "冷蔵", priority: false, active: true, confirmedAt: todayIso(), step: 50 },
  { id: "rice", name: "ごはん", quantity: 1, unit: "膳", location: "冷凍", priority: false, active: true, confirmedAt: todayIso(), step: 1 }
];

const RECIPES = [
  {
    id: "miso-stir-fry",
    name: "豚こまとキャベツの味噌炒め",
    minutes: 12,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 150, unit: "g" },
      { id: "pork", name: "豚こま", quantity: 100, unit: "g" }
    ],
    pantry: "味噌・醤油・砂糖・油",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "量と食感が増す" },
      { id: "ginger", name: "しょうが", quantity: 10, unit: "g", benefit: "香りが締まる" },
      { id: "sesame-oil", name: "ごま油", quantity: 1, unit: "小さじ", benefit: "仕上げが香ばしくなる" }
    ]
  },
  {
    id: "egg-bowl",
    name: "ふんわり卵とじ丼",
    minutes: 10,
    required: [
      { id: "eggs", name: "卵", quantity: 2, unit: "個" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" }
    ],
    pantry: "醤油・砂糖・水",
    optional: [
      { id: "cabbage", name: "キャベツ", quantity: 80, unit: "g", benefit: "野菜と食べ応えを足せる" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが出る" }
    ]
  },
  {
    id: "cabbage-pancake",
    name: "キャベツと卵のお好み焼き風",
    minutes: 15,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 160, unit: "g" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "小麦粉・水・油・醤油",
    optional: [
      { id: "pork", name: "豚こま", quantity: 80, unit: "g", benefit: "主菜としての満足感が増す" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクが出る" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "香りとうま味を足せる" }
    ]
  },
  {
    id: "mushroom-soup",
    name: "しめじと卵のとろみスープ",
    minutes: 8,
    required: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "水・醤油・塩・片栗粉",
    optional: [
      { id: "cabbage", name: "キャベツ", quantity: 50, unit: "g", benefit: "野菜の量が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" }
    ]
  }
];

const ALIASES = new Map([
  ["たまご", "eggs"],
  ["卵", "eggs"],
  ["キャベツ", "cabbage"],
  ["しめじ", "mushroom"],
  ["豚こま", "pork"],
  ["豚こま切れ", "pork"],
  ["ごはん", "rice"],
  ["ご飯", "rice"],
  ["豆腐", "tofu"],
  ["木綿豆腐", "tofu"],
  ["絹ごし豆腐", "tofu"],
  ["玉ねぎ", "onion"],
  ["たまねぎ", "onion"],
  ["タマネギ", "onion"],
  ["にんじん", "carrot"],
  ["人参", "carrot"],
  ["ニンジン", "carrot"],
  ["トマト", "tomato"],
  ["鶏むね肉", "chicken"],
  ["鶏胸肉", "chicken"],
  ["とりむね肉", "chicken"],
  ["じゃがいも", "potato"],
  ["ジャガイモ", "potato"],
  ["しょうが", "ginger"],
  ["生姜", "ginger"],
  ["ごま油", "sesame-oil"],
  ["ねぎ", "green-onion"],
  ["ネギ", "green-onion"],
  ["チーズ", "cheese"],
  ["かつお節", "bonito"]
]);

const INGREDIENT_ILLUSTRATIONS = {
  cabbage: [0, 0],
  eggs: [1, 0],
  mushroom: [2, 0],
  pork: [3, 0],
  rice: [0, 1],
  tofu: [1, 1],
  onion: [2, 1],
  carrot: [3, 1],
  tomato: [0, 2],
  chicken: [1, 2],
  potato: [2, 2],
  "green-onion": [3, 2]
};

const state = {
  inventory: [],
  location: "すべて",
  servings: 1,
  priority: "no-shop",
  selectedOptionals: {},
  storageEnabled: true,
  lastUndo: null,
  toastTimer: null
};

const elements = {
  saveStatus: document.querySelector("#save-status"),
  inventoryOverview: document.querySelector("#inventory-overview"),
  fridgeScene: document.querySelector("#fridge-scene"),
  inventoryList: document.querySelector("#inventory-list"),
  finishedSection: document.querySelector("#finished-section"),
  finishedCount: document.querySelector("#finished-count"),
  finishedList: document.querySelector("#finished-list"),
  recipeList: document.querySelector("#recipe-list"),
  inventoryView: document.querySelector("#inventory-view"),
  suggestionsView: document.querySelector("#suggestions-view"),
  dialog: document.querySelector("#ingredient-dialog"),
  form: document.querySelector("#ingredient-form"),
  dialogTitle: document.querySelector("#dialog-title"),
  ingredientId: document.querySelector("#ingredient-id"),
  ingredientName: document.querySelector("#ingredient-name"),
  ingredientQuantity: document.querySelector("#ingredient-quantity"),
  ingredientUnit: document.querySelector("#ingredient-unit"),
  ingredientLocation: document.querySelector("#ingredient-location"),
  ingredientPriority: document.querySelector("#ingredient-priority"),
  deleteIngredient: document.querySelector("#delete-ingredient"),
  toast: document.querySelector("#toast"),
  toastMessage: document.querySelector("#toast-message"),
  toastAction: document.querySelector("#toast-action"),
  prioritySelect: document.querySelector("#priority-select")
};

function cloneDefaults() {
  return DEFAULT_INVENTORY.map((item) => ({ ...item }));
}

function loadInventory() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      state.inventory = cloneDefaults();
      persistInventory();
      return;
    }
    const parsed = JSON.parse(saved);
    state.inventory = Array.isArray(parsed) ? parsed : cloneDefaults();
  } catch {
    state.storageEnabled = false;
    state.inventory = cloneDefaults();
    elements.saveStatus.textContent = "保存できません";
  }
}

function persistInventory() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.inventory));
    elements.saveStatus.textContent = "この端末に保存済み";
  } catch {
    state.storageEnabled = false;
    elements.saveStatus.textContent = "保存できません";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeId(name) {
  const alias = ALIASES.get(name.trim());
  if (alias) return alias;
  if (globalThis.crypto?.randomUUID) return `custom-${crypto.randomUUID()}`;
  return `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function canonicalIngredientId(id, name) {
  if (INGREDIENT_ILLUSTRATIONS[id]) return id;
  return ALIASES.get(String(name).trim()) || id;
}

function renderIngredientIllustration(id, name, small = false) {
  const illustration = INGREDIENT_ILLUSTRATIONS[canonicalIngredientId(id, name)];
  const sizeClass = small ? " ingredient-illustration-small" : "";

  if (!illustration) {
    const initial = String(name).trim().slice(0, 1) || "食";
    return `<span class="ingredient-initial${sizeClass}" aria-hidden="true">${escapeHtml(initial)}</span>`;
  }

  const [column, row] = illustration;
  // Slightly crop inside each atlas cell so a wide illustration never leaks
  // into its neighbour at small display sizes.
  const x = ((4.4 * ((column + 0.5) / 4) - 0.5) / 3.4) * 100;
  const y = ((3.3 * ((row + 0.5) / 3) - 0.5) / 2.3) * 100;
  return `<span class="ingredient-illustration${sizeClass}" style="--atlas-x:${x}%;--atlas-y:${y}%;" aria-hidden="true"></span>`;
}

function stepForUnit(unit) {
  if (unit === "g" || unit === "ml") return 50;
  if (unit === "株") return 0.25;
  return 1;
}

function formatQuantity(quantity, unit) {
  if (unit === "株" && quantity === 0.25) return "1/4株";
  if (unit === "株" && quantity === 0.5) return "1/2株";
  if (unit === "株" && quantity === 0.75) return "3/4株";
  if (unit === "本" && quantity === 0.25) return "1/4本";
  if (unit === "小さじ" || unit === "大さじ") return `${unit}${quantity}`;
  const number = Number.isInteger(quantity) ? quantity : Number(quantity.toFixed(2));
  return `${number}${unit}`;
}

function daysSince(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const today = new Date(`${todayIso()}T00:00:00`);
  return Math.max(0, Math.floor((today - date) / 86400000));
}

function confirmationLabel(item) {
  const days = daysSince(item.confirmedAt || todayIso());
  if (days === 0) return { text: "今日確認", stale: false };
  if (days === 1) return { text: "昨日確認", stale: false };
  if (days <= 3) return { text: `${days}日前に確認`, stale: false };
  return { text: `要確認・${days}日前`, stale: true };
}

function activeInventory() {
  return state.inventory.filter((item) => item.active !== false && item.quantity > 0);
}

function inventoryMap() {
  const map = new Map();
  activeInventory().forEach((item) => {
    map.set(item.id, item);
    const alias = ALIASES.get(item.name.trim());
    if (alias) map.set(alias, item);
  });
  return map;
}

function renderInventory() {
  const active = activeInventory();
  const filtered = active.filter((item) => state.location === "すべて" || item.location === state.location);
  const priorityCount = active.filter((item) => item.priority).length;
  const staleCount = active.filter((item) => confirmationLabel(item).stale).length;

  const notes = [`${active.length}品`];
  if (priorityCount) notes.push(`使い切り優先 ${priorityCount}品`);
  if (staleCount) notes.push(`要確認 ${staleCount}品`);
  elements.inventoryOverview.textContent = notes.join("・");
  renderFridgeScene(active);

  if (!filtered.length) {
    elements.inventoryList.innerHTML = `
      <p class="empty-state">${state.location === "すべて" ? "食材を追加すると、ここに並びます。" : `${escapeHtml(state.location)}の食材はありません。`}</p>
    `;
  } else {
    elements.inventoryList.innerHTML = filtered.map(renderInventoryRow).join("");
  }

  const finished = state.inventory.filter((item) => item.active === false);
  elements.finishedCount.textContent = `${finished.length}品`;
  elements.finishedSection.hidden = finished.length === 0;
  elements.finishedList.innerHTML = finished.map((item) => `
    <div class="finished-row">
      <span>
        <strong>${escapeHtml(item.name)}</strong>
        <span class="item-meta">${escapeHtml(item.location)}・${escapeHtml(item.consumedAt || "")}</span>
      </span>
      <button class="restore-button" type="button" data-action="restore" data-id="${escapeHtml(item.id)}">戻す</button>
    </div>
  `).join("");
}

function renderFridgeFood(item) {
  return `
    <button class="fridge-food${item.priority ? " is-priority" : ""}" type="button" data-fridge-edit="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)} ${formatQuantity(item.quantity, item.unit)}を編集">
      ${renderIngredientIllustration(item.id, item.name)}
      <span class="fridge-food-name">${escapeHtml(item.name)}</span>
      <span class="fridge-food-quantity">${formatQuantity(item.quantity, item.unit)}</span>
    </button>
  `;
}

function renderFridgeShelf(items, emptyText) {
  if (!items.length) return `<p class="fridge-empty">${escapeHtml(emptyText)}</p>`;
  return `<div class="fridge-foods">${items.map(renderFridgeFood).join("")}</div>`;
}

function renderFridgeScene(active) {
  const frozen = active.filter((item) => item.location === "冷凍");
  const chilled = active.filter((item) => item.location === "冷蔵");
  const pantry = active.filter((item) => item.location === "常温");
  const visibleFrozen = frozen.slice(0, 4);
  const visibleChilled = chilled.slice(0, 8);
  const visiblePantry = pantry.slice(0, 4);
  const firstShelfEnd = Math.ceil(visibleChilled.length / 2);
  const hiddenCount = Math.max(0, frozen.length - visibleFrozen.length)
    + Math.max(0, chilled.length - visibleChilled.length)
    + Math.max(0, pantry.length - visiblePantry.length);

  elements.fridgeScene.innerHTML = `
    <div class="fridge-appliance">
      <div class="fridge-freezer">
        <span class="fridge-compartment-label">冷凍室</span>
        ${renderFridgeShelf(visibleFrozen, "冷凍食材はまだありません")}
      </div>
      <div class="fridge-chamber">
        <span class="fridge-light" aria-hidden="true"></span>
        <span class="fridge-compartment-label">冷蔵室</span>
        <div class="fridge-shelf">
          ${renderFridgeShelf(visibleChilled.slice(0, firstShelfEnd), "冷蔵食材を入れてみましょう")}
        </div>
        <div class="fridge-shelf">
          ${renderFridgeShelf(visibleChilled.slice(firstShelfEnd), "この棚は空いています")}
        </div>
      </div>
      <div class="fridge-crisper">
        <span>野菜室</span>
        <span>${chilled.length ? `${chilled.length}品を冷蔵中` : "空いています"}</span>
      </div>
      ${hiddenCount ? `<span class="fridge-overflow">ほか ${hiddenCount}品</span>` : ""}
    </div>
    ${pantry.length ? `
      <div class="pantry-shelf">
        <span class="pantry-label">常温ストック</span>
        ${renderFridgeShelf(visiblePantry, "")}
      </div>
    ` : ""}
  `;
}

function renderInventoryRow(item) {
  const confirmation = confirmationLabel(item);
  return `
    <article class="inventory-row${item.priority ? " is-priority" : ""}">
      <div class="item-heading">
        <div class="item-identity">
          ${renderIngredientIllustration(item.id, item.name)}
          <button class="item-name-button" type="button" data-action="edit" data-id="${escapeHtml(item.id)}">
            <span class="item-name">${escapeHtml(item.name)}</span>
            <span class="item-meta${confirmation.stale ? " is-stale" : ""}">${escapeHtml(item.location)}・${confirmation.text}</span>
          </button>
        </div>
        ${item.priority ? '<span class="priority-label">先に使う</span>' : ""}
      </div>

      <div class="quantity-control" aria-label="${escapeHtml(item.name)}の残量">
        <button class="quantity-button" type="button" data-action="decrease" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を減らす">−</button>
        <output class="quantity-output">${formatQuantity(item.quantity, item.unit)}</output>
        <button class="quantity-button" type="button" data-action="increase" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を増やす">＋</button>
      </div>

      <div class="row-actions">
        <button class="row-action" type="button" data-action="confirm" data-id="${escapeHtml(item.id)}">まだある</button>
        <button class="row-action${item.priority ? " is-priority" : ""}" type="button" data-action="priority" data-id="${escapeHtml(item.id)}">${item.priority ? "優先を解除" : "先に使う"}</button>
        <button class="row-action" type="button" data-action="consume" data-id="${escapeHtml(item.id)}">使い切った</button>
        <button class="row-action is-delete" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">削除</button>
      </div>
    </article>
  `;
}

function itemForRequirement(requirement) {
  const item = inventoryMap().get(requirement.id);
  if (!item || item.unit !== requirement.unit) return null;
  return item;
}

function requiredAmount(requirement) {
  return requirement.quantity * state.servings;
}

function shortageFor(recipe) {
  return recipe.required.filter((requirement) => {
    const item = itemForRequirement(requirement);
    return !item || item.quantity < requiredAmount(requirement);
  });
}

function optionalReady(option) {
  const item = itemForRequirement(option);
  return Boolean(item && item.quantity >= option.quantity * state.servings);
}

function recipeScore(recipe) {
  const shortagePenalty = shortageFor(recipe).length * 100;
  const priorityIds = new Set(activeInventory().filter((item) => item.priority).map((item) => item.id));
  const priorityUse = [...recipe.required, ...recipe.optional].filter((ingredient) => priorityIds.has(ingredient.id)).length;
  if (state.priority === "rescue") return priorityUse * 40 - shortagePenalty - recipe.minutes;
  if (state.priority === "quick") return 30 - recipe.minutes - shortagePenalty;
  return 50 - shortagePenalty - recipe.minutes / 10;
}

function renderRecipes() {
  const ordered = [...RECIPES].sort((a, b) => recipeScore(b) - recipeScore(a)).slice(0, 3);
  elements.recipeList.innerHTML = ordered.map((recipe, index) => renderRecipe(recipe, index)).join("");
}

function renderRecipe(recipe, index) {
  const shortages = shortageFor(recipe);
  const status = shortages.length
    ? `不足：${shortages.map((item) => `${item.name} ${formatQuantity(requiredAmount(item), item.unit)}`).join("、")}`
    : "最低限必要なものが揃っています";

  const requiredLines = recipe.required.map((requirement) => {
    const item = itemForRequirement(requirement);
    const enough = Boolean(item && item.quantity >= requiredAmount(requirement));
    return `
      <li class="ingredient-line">
        <span class="ingredient-with-icon">
          ${renderIngredientIllustration(requirement.id, requirement.name, true)}
          <span>${escapeHtml(requirement.name)} ${formatQuantity(requiredAmount(requirement), requirement.unit)}</span>
        </span>
        <span class="ingredient-state${enough ? " is-ready" : ""}">${enough ? "あります" : "足りません"}</span>
      </li>
    `;
  }).join("");

  const optionalLines = recipe.optional.map((option) => {
    const ready = optionalReady(option);
    const key = `${recipe.id}:${option.id}`;
    const checked = ready && state.selectedOptionals[key] !== false;
    return `
      <li>
        <label class="optional-choice">
          <input type="checkbox" data-optional="${escapeHtml(key)}"${checked ? " checked" : ""}${ready ? "" : " disabled"}>
          <span class="ingredient-with-icon">
            ${renderIngredientIllustration(option.id, option.name, true)}
            <span>
              ${escapeHtml(option.name)} ${formatQuantity(option.quantity * state.servings, option.unit)}
              <small>${escapeHtml(option.benefit)}・${ready ? "冷蔵庫にあります" : "なくても作れます"}</small>
            </span>
          </span>
        </label>
      </li>
    `;
  }).join("");

  return `
    <article class="recipe">
      <p class="recipe-rank">${index + 1}つ目の候補</p>
      <h3>${escapeHtml(recipe.name)}</h3>
      <p class="recipe-meta">調理時間の目安 約${recipe.minutes}分・${state.servings}人分</p>
      <p class="recipe-status${shortages.length ? " is-missing" : ""}">${status}</p>

      <div class="ingredient-groups">
        <section class="ingredient-group">
          <h4>最低限必要</h4>
          <ul>${requiredLines}</ul>
          <p class="recipe-meta">基本調味料：${escapeHtml(recipe.pantry)}</p>
        </section>
        <section class="ingredient-group">
          <h4>あるとより良い</h4>
          <ul>${optionalLines}</ul>
        </section>
      </div>

      <button class="button button-primary cook-button" type="button" data-cook="${escapeHtml(recipe.id)}"${shortages.length ? " disabled" : ""}>
        ${shortages.length ? "材料が足りません" : "これを作る"}
      </button>
    </article>
  `;
}

function showView(viewName) {
  const inventoryActive = viewName === "inventory";
  elements.inventoryView.hidden = !inventoryActive;
  elements.suggestionsView.hidden = inventoryActive;
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  if (!inventoryActive) renderRecipes();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function openIngredientDialog(item = null) {
  elements.form.reset();
  if (item) {
    elements.dialogTitle.textContent = "食材を編集";
    elements.ingredientId.value = item.id;
    elements.ingredientName.value = item.name;
    elements.ingredientQuantity.value = item.quantity;
    elements.ingredientUnit.value = item.unit;
    elements.ingredientLocation.value = item.location;
    elements.ingredientPriority.checked = item.priority;
    elements.deleteIngredient.hidden = false;
  } else {
    elements.dialogTitle.textContent = "食材を追加";
    elements.ingredientId.value = "";
    elements.ingredientQuantity.value = 1;
    elements.ingredientUnit.value = "個";
    elements.ingredientLocation.value = state.location === "すべて" ? "冷蔵" : state.location;
    elements.deleteIngredient.hidden = true;
  }
  elements.dialog.showModal();
  requestAnimationFrame(() => elements.ingredientName.focus());
}

function closeIngredientDialog() {
  elements.dialog.close();
}

function saveIngredient(event) {
  event.preventDefault();
  const name = elements.ingredientName.value.trim();
  const quantity = Number(elements.ingredientQuantity.value);
  const unit = elements.ingredientUnit.value;
  const location = elements.ingredientLocation.value;
  if (!name || !Number.isFinite(quantity) || quantity <= 0) return;

  const editingId = elements.ingredientId.value;
  if (editingId) {
    const item = state.inventory.find((candidate) => candidate.id === editingId);
    if (item) {
      Object.assign(item, {
        name,
        quantity,
        unit,
        location,
        priority: elements.ingredientPriority.checked,
        active: true,
        confirmedAt: todayIso(),
        step: stepForUnit(unit)
      });
      showToast(`${name}を更新しました`);
    }
  } else {
    const canonicalId = ALIASES.get(name) || makeId(name);
    const existing = state.inventory.find((item) =>
      item.id === canonicalId || item.name === name
    );
    if (existing) {
      existing.quantity = existing.active !== false && existing.unit === unit
        ? existing.quantity + quantity
        : quantity;
      existing.unit = unit;
      existing.location = location;
      existing.priority = existing.priority || elements.ingredientPriority.checked;
      existing.active = true;
      existing.confirmedAt = todayIso();
      existing.step = stepForUnit(unit);
      delete existing.consumedAt;
      showToast(`${name}の残量に追加しました`);
    } else {
      state.inventory.push({
        id: canonicalId,
        name,
        quantity,
        unit,
        location,
        priority: elements.ingredientPriority.checked,
        active: true,
        confirmedAt: todayIso(),
        step: stepForUnit(unit)
      });
      showToast(`${name}を追加しました`);
    }
  }

  persistInventory();
  renderAll();
  closeIngredientDialog();
}

function updateItem(id, updater) {
  const item = state.inventory.find((candidate) => candidate.id === id);
  if (!item) return;
  updater(item);
  persistInventory();
  renderAll();
}

function consumeItem(item) {
  const snapshot = { ...item };
  item.active = false;
  item.consumedAt = todayIso();
  state.lastUndo = () => {
    Object.assign(item, snapshot);
    persistInventory();
    renderAll();
  };
  persistInventory();
  renderAll();
  showToast(`${item.name}を使い切りにしました`, true);
}

function deleteItem(item) {
  if (!item) return;
  const index = state.inventory.indexOf(item);
  const snapshot = { ...item };
  state.inventory.splice(index, 1);
  state.lastUndo = () => {
    state.inventory.splice(index, 0, snapshot);
    persistInventory();
    renderAll();
  };
  persistInventory();
  renderAll();
  showToast(`${item.name}を在庫から削除しました`, true);
}

function deleteCurrentIngredient() {
  const item = state.inventory.find((candidate) => candidate.id === elements.ingredientId.value);
  deleteItem(item);
  closeIngredientDialog();
}

function restoreItem(id) {
  updateItem(id, (item) => {
    item.active = true;
    item.confirmedAt = todayIso();
    delete item.consumedAt;
  });
}

function cookRecipe(recipeId) {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe || shortageFor(recipe).length) return;

  const used = [...recipe.required];
  recipe.optional.forEach((option) => {
    const key = `${recipe.id}:${option.id}`;
    if (optionalReady(option) && state.selectedOptionals[key] !== false) used.push(option);
  });

  used.forEach((ingredient) => {
    const item = itemForRequirement(ingredient);
    if (!item) return;
    item.quantity = Math.max(0, item.quantity - ingredient.quantity * state.servings);
    if (item.quantity === 0) {
      item.active = false;
      item.consumedAt = todayIso();
    }
  });

  persistInventory();
  renderAll();
  showView("inventory");
  showToast(`${recipe.name}を作った分だけ在庫を更新しました`);
}

function showToast(message, withUndo = false) {
  clearTimeout(state.toastTimer);
  elements.toastMessage.textContent = message;
  elements.toastAction.hidden = !withUndo;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
    state.lastUndo = null;
  }, 15000);
}

function renderAll() {
  renderInventory();
  renderRecipes();
}

document.querySelector("#add-ingredient").addEventListener("click", () => openIngredientDialog());
document.querySelector("#close-dialog").addEventListener("click", closeIngredientDialog);
document.querySelector("#cancel-dialog").addEventListener("click", closeIngredientDialog);
document.querySelector("#delete-ingredient").addEventListener("click", deleteCurrentIngredient);
document.querySelector("#review-inventory").addEventListener("click", () => showView("inventory"));
elements.form.addEventListener("submit", saveIngredient);

elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) closeIngredientDialog();
});

elements.fridgeScene.addEventListener("click", (event) => {
  const button = event.target.closest("[data-fridge-edit]");
  if (!button) return;
  const item = state.inventory.find((candidate) => candidate.id === button.dataset.fridgeEdit);
  if (item) openIngredientDialog(item);
});

document.querySelectorAll(".storage-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.location = button.dataset.location;
    document.querySelectorAll(".storage-tab").forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    renderInventory();
  });
});

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.querySelectorAll(".choice-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.servings = Number(button.dataset.servings);
    document.querySelectorAll(".choice-button").forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    renderRecipes();
  });
});

elements.prioritySelect.addEventListener("change", () => {
  state.priority = elements.prioritySelect.value;
  renderRecipes();
});

elements.inventoryList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const item = state.inventory.find((candidate) => candidate.id === button.dataset.id);
  if (!item) return;

  if (button.dataset.action === "edit") openIngredientDialog(item);
  if (button.dataset.action === "increase") {
    updateItem(item.id, (current) => {
      current.quantity = Number((current.quantity + current.step).toFixed(2));
      current.confirmedAt = todayIso();
    });
  }
  if (button.dataset.action === "decrease") {
    const nextQuantity = Number((item.quantity - item.step).toFixed(2));
    if (nextQuantity <= 0) {
      consumeItem(item);
    } else {
      updateItem(item.id, (current) => {
        current.quantity = nextQuantity;
        current.confirmedAt = todayIso();
      });
    }
  }
  if (button.dataset.action === "confirm") {
    updateItem(item.id, (current) => {
      current.confirmedAt = todayIso();
    });
    showToast(`${item.name}を今日確認しました`);
  }
  if (button.dataset.action === "priority") {
    updateItem(item.id, (current) => {
      current.priority = !current.priority;
    });
  }
  if (button.dataset.action === "consume") consumeItem(item);
  if (button.dataset.action === "delete") deleteItem(item);
});

elements.finishedList.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="restore"]');
  if (button) restoreItem(button.dataset.id);
});

elements.recipeList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-optional]");
  if (!checkbox) return;
  state.selectedOptionals[checkbox.dataset.optional] = checkbox.checked;
});

elements.recipeList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cook]");
  if (button) cookRecipe(button.dataset.cook);
});

elements.toastAction.addEventListener("click", () => {
  if (state.lastUndo) state.lastUndo();
  state.lastUndo = null;
  elements.toast.hidden = true;
});

loadInventory();
renderAll();
