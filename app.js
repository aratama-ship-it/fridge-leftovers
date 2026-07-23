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
  },
  {
    id: "home-curry",
    name: "基本のカレーライス",
    minutes: 30,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "beef", name: "牛肉", quantity: 100, unit: "g" }
    ],
    pantry: "カレールウ・水・油",
    optional: [
      { id: "potato", name: "じゃがいも", quantity: 1, unit: "個", benefit: "定番の食べ応えが出る" },
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "甘みととろみが増す" },
      { id: "carrot", name: "にんじん", quantity: 0.5, unit: "本", benefit: "彩りと甘みを足せる" }
    ]
  },
  {
    id: "nikujaga",
    name: "基本の肉じゃが",
    minutes: 25,
    required: [
      { id: "beef", name: "牛肉", quantity: 100, unit: "g" },
      { id: "potato", name: "じゃがいも", quantity: 2, unit: "個" },
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個" }
    ],
    pantry: "醤油・砂糖・みりん・水・油",
    optional: [
      { id: "carrot", name: "にんじん", quantity: 0.5, unit: "本", benefit: "彩りと野菜量が増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味を足せる" }
    ]
  },
  {
    id: "hamburger-steak",
    name: "定番ハンバーグ",
    minutes: 30,
    required: [
      { id: "ground-meat", name: "合いびき肉", quantity: 150, unit: "g" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "breadcrumbs", name: "パン粉", quantity: 20, unit: "g", benefit: "肉汁を抱えてふっくらする" },
      { id: "radish", name: "大根", quantity: 100, unit: "g", benefit: "和風おろしでさっぱりする" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクのある仕上がりになる" }
    ]
  },
  {
    id: "salmon-meuniere",
    name: "鮭のムニエル",
    minutes: 20,
    required: [
      { id: "salmon", name: "生鮭", quantity: 1, unit: "切れ" },
      { id: "butter", name: "バター", quantity: 10, unit: "g" }
    ],
    pantry: "小麦粉・塩・こしょう・油",
    optional: [
      { id: "spinach", name: "ほうれん草", quantity: 100, unit: "g", benefit: "定番の付け合わせになる" },
      { id: "potato", name: "じゃがいも", quantity: 1, unit: "個", benefit: "一皿の満足感が増す" },
      { id: "garlic", name: "にんにく", quantity: 5, unit: "g", benefit: "ソースの香りが立つ" }
    ]
  },
  {
    id: "napolitan",
    name: "定番ナポリタン",
    minutes: 15,
    required: [
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個" }
    ],
    pantry: "ケチャップ・塩・こしょう・油",
    optional: [
      { id: "bell-pepper", name: "ピーマン", quantity: 1, unit: "個", benefit: "定番の香りと彩りが出る" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" },
      { id: "cheese", name: "チーズ", quantity: 10, unit: "g", benefit: "仕上げのコクが増す" }
    ]
  },
  {
    id: "tofu-miso-soup",
    name: "豆腐とわかめの味噌汁",
    minutes: 10,
    required: [
      { id: "tofu", name: "豆腐", quantity: 150, unit: "g" },
      { id: "miso", name: "味噌", quantity: 20, unit: "g" }
    ],
    pantry: "水・だし",
    optional: [
      { id: "wakame", name: "わかめ", quantity: 3, unit: "g", benefit: "定番の磯の風味が加わる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" },
      { id: "radish", name: "大根", quantity: 50, unit: "g", benefit: "野菜の食べ応えを足せる" }
    ]
  }
];

const ALIASES = new Map([
  ["たまご", "eggs"],
  ["卵", "eggs"],
  ["玉子", "eggs"],
  ["キャベツ", "cabbage"],
  ["しめじ", "mushroom"],
  ["シメジ", "mushroom"],
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
  ["かつお節", "bonito"],
  ["牛乳", "milk"],
  ["ヨーグルト", "yogurt"],
  ["納豆", "natto"],
  ["食パン", "bread"],
  ["バナナ", "banana"],
  ["りんご", "apple"],
  ["リンゴ", "apple"],
  ["大根", "radish"],
  ["レタス", "lettuce"],
  ["きゅうり", "cucumber"],
  ["キュウリ", "cucumber"],
  ["牛肉", "beef"],
  ["鮭", "salmon"],
  ["生鮭", "salmon"],
  ["サーモン", "salmon"],
  ["合いびき肉", "ground-meat"],
  ["合挽き肉", "ground-meat"],
  ["ひき肉", "ground-meat"],
  ["挽き肉", "ground-meat"],
  ["ほうれん草", "spinach"],
  ["ホウレンソウ", "spinach"],
  ["なす", "eggplant"],
  ["ナス", "eggplant"],
  ["茄子", "eggplant"],
  ["ピーマン", "bell-pepper"],
  ["ブロッコリー", "broccoli"],
  ["にんにく", "garlic"],
  ["ニンニク", "garlic"],
  ["大蒜", "garlic"],
  ["スパゲッティ", "pasta"],
  ["スパゲティ", "pasta"],
  ["パスタ", "pasta"],
  ["バター", "butter"],
  ["パン粉", "breadcrumbs"],
  ["味噌", "miso"],
  ["みそ", "miso"],
  ["わかめ", "wakame"],
  ["ワカメ", "wakame"]
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
  "green-onion": [3, 2],
  milk: [0, 0, "everyday"],
  yogurt: [1, 0, "everyday"],
  natto: [2, 0, "everyday"],
  bread: [3, 0, "everyday"],
  banana: [0, 1, "everyday"],
  apple: [1, 1, "everyday"],
  radish: [2, 1, "everyday"],
  lettuce: [3, 1, "everyday"],
  cucumber: [0, 2, "everyday"],
  beef: [1, 2, "everyday"],
  salmon: [2, 2, "everyday"],
  cheese: [3, 2, "everyday"],
  "ground-meat": [0, 0, "recipe"],
  spinach: [1, 0, "recipe"],
  eggplant: [2, 0, "recipe"],
  "bell-pepper": [3, 0, "recipe"],
  broccoli: [0, 1, "recipe"],
  garlic: [1, 1, "recipe"],
  ginger: [2, 1, "recipe"],
  pasta: [3, 1, "recipe"],
  butter: [0, 2, "recipe"],
  breadcrumbs: [1, 2, "recipe"],
  miso: [2, 2, "recipe"],
  wakame: [3, 2, "recipe"]
};

const RECEIPT_RULES = [
  { id: "eggs", name: "卵", pattern: /(?:卵|玉子|たまご)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "cabbage", name: "キャベツ", pattern: /(?:キャベツ|きゃべつ)/, quantity: 100, unit: "g", fractionUnit: "個", location: "冷蔵" },
  { id: "mushroom", name: "しめじ", pattern: /(?:しめじ|シメジ)/, quantity: 1, unit: "株", location: "冷蔵" },
  { id: "pork", name: "豚こま", pattern: /(?:豚.*(?:こま|コマ|小間|切落|切り落)|(?:こま|コマ|小間).*豚)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "tofu", name: "豆腐", pattern: /(?:豆腐|とうふ|トウフ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "onion", name: "玉ねぎ", pattern: /(?:玉ねぎ|たまねぎ|タマネギ|玉葱)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "carrot", name: "にんじん", pattern: /(?:にんじん|ニンジン|人参)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "tomato", name: "トマト", pattern: /(?:トマト|とまと)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "chicken", name: "鶏むね肉", pattern: /(?:鶏|若鶏).*(?:むね|ムネ|胸)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "potato", name: "じゃがいも", pattern: /(?:じゃがいも|ジャガイモ|馬鈴薯)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "green-onion", name: "ねぎ", pattern: /(?:長ねぎ|長ネギ|青ねぎ|青ネギ|ねぎ|ネギ|葱)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "milk", name: "牛乳", pattern: /(?:牛乳|ミルク)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "yogurt", name: "ヨーグルト", pattern: /(?:ヨーグルト|ヨ-グルト)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "natto", name: "納豆", pattern: /(?:納豆|なっとう)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "bread", name: "食パン", pattern: /(?:食パン|しょくぱん)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "banana", name: "バナナ", pattern: /(?:バナナ|ばなな)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "apple", name: "りんご", pattern: /(?:りんご|リンゴ|林檎)/, quantity: 1, unit: "個", location: "常温" },
  { id: "radish", name: "大根", pattern: /(?:大根|だいこん|ダイコン)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "lettuce", name: "レタス", pattern: /(?:レタス|れたす)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "cucumber", name: "きゅうり", pattern: /(?:きゅうり|キュウリ|胡瓜)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "beef", name: "牛肉", pattern: /(?:牛肉|国産牛|和牛)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "salmon", name: "鮭", pattern: /(?:鮭|サーモン)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  { id: "cheese", name: "チーズ", pattern: /(?:チーズ|ちーず)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "bonito", name: "かつお節", pattern: /(?:かつお節|カツオ節|鰹節)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "ground-meat", name: "ひき肉", pattern: /(?:ひき肉|挽き肉|挽肉|ミンチ)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "spinach", name: "ほうれん草", pattern: /(?:ほうれん草|ホウレン草|菠菜)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "eggplant", name: "なす", pattern: /(?:なす|ナス|茄子)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "bell-pepper", name: "ピーマン", pattern: /(?:ピーマン|ぴーまん)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "broccoli", name: "ブロッコリー", pattern: /(?:ブロッコリー|ぶろっこりー)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "garlic", name: "にんにく", pattern: /(?:にんにく|ニンニク|大蒜)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "ginger", name: "しょうが", pattern: /(?:しょうが|ショウガ|生姜)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "pasta", name: "スパゲッティ", pattern: /(?:スパゲッティ|スパゲティ|パスタ)/, quantity: 100, unit: "g", location: "常温" },
  { id: "butter", name: "バター", pattern: /(?:バター|ばたー)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "breadcrumbs", name: "パン粉", pattern: /(?:パン粉|ぱん粉)/, quantity: 100, unit: "g", location: "常温" },
  { id: "miso", name: "味噌", pattern: /(?:味噌|みそ|ミソ)/, quantity: 300, unit: "g", location: "冷蔵" },
  { id: "wakame", name: "わかめ", pattern: /(?:わかめ|ワカメ|若布)/, quantity: 1, unit: "袋", location: "常温" }
];

const INVENTORY_UNITS = ["個", "g", "ml", "本", "株", "袋", "パック", "膳", "切れ"];
const INVENTORY_LOCATIONS = ["冷蔵", "冷凍", "常温"];

const state = {
  inventory: [],
  location: "すべて",
  servings: 1,
  priority: "no-shop",
  selectedOptionals: {},
  storageEnabled: true,
  lastUndo: null,
  toastTimer: null,
  receiptCandidates: [],
  receiptWorker: null,
  receiptRunId: 0,
  receiptObjectUrl: null
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
  managementView: document.querySelector("#management-view"),
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
  receiptInput: document.querySelector("#receipt-input"),
  receiptDialog: document.querySelector("#receipt-dialog"),
  receiptForm: document.querySelector("#receipt-form"),
  receiptPreview: document.querySelector("#receipt-preview"),
  receiptProcessing: document.querySelector("#receipt-processing"),
  receiptStatus: document.querySelector("#receipt-status"),
  receiptProgress: document.querySelector("#receipt-progress"),
  receiptResults: document.querySelector("#receipt-results"),
  receiptSummary: document.querySelector("#receipt-summary"),
  receiptCandidates: document.querySelector("#receipt-candidates"),
  receiptRawText: document.querySelector("#receipt-raw-text"),
  receiptError: document.querySelector("#receipt-error"),
  receiptErrorMessage: document.querySelector("#receipt-error-message"),
  addReceiptCandidates: document.querySelector("#add-receipt-candidates"),
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

  const [column, row, atlas = "base"] = illustration;
  // Slightly crop inside each atlas cell so a wide illustration never leaks
  // into its neighbour at small display sizes.
  const x = ((4.4 * ((column + 0.5) / 4) - 0.5) / 3.4) * 100;
  const y = ((3.3 * ((row + 0.5) / 3) - 0.5) / 2.3) * 100;
  const atlasClass = atlas === "base" ? "" : ` ingredient-illustration-${atlas}`;
  return `<span class="ingredient-illustration${atlasClass}${sizeClass}" style="--atlas-x:${x}%;--atlas-y:${y}%;" aria-hidden="true"></span>`;
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
  elements.inventoryView.hidden = viewName !== "inventory";
  elements.managementView.hidden = viewName !== "management";
  elements.suggestionsView.hidden = viewName !== "suggestions";
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  if (viewName === "suggestions") renderRecipes();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showManagementItem(id) {
  showView("management");
  requestAnimationFrame(() => {
    const button = [...elements.inventoryList.querySelectorAll('[data-action="edit"]')]
      .find((candidate) => candidate.dataset.id === id);
    if (!button) return;
    button.scrollIntoView({ block: "center", behavior: "smooth" });
    button.focus({ preventScroll: true });
  });
}

function normalizedReceiptLine(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[|｜]/g, " ")
    .replace(/[●■◆◇※*＊]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function receiptQuantity(line, rule) {
  let match = line.match(/(\d+(?:\.\d+)?)\s*(?:kg|KG|キロ)/);
  if (match) return { quantity: Number(match[1]) * 1000, unit: "g", needsReview: false };

  match = line.match(/(\d+(?:\.\d+)?)\s*(?:g|G|グラム)/);
  if (match) return { quantity: Number(match[1]), unit: "g", needsReview: false };

  match = line.match(/(\d+(?:\.\d+)?)\s*(?:ml|ML|ミリリットル)/);
  if (match) return { quantity: Number(match[1]), unit: "ml", needsReview: false };

  match = line.match(/(\d+(?:\.\d+)?)\s*(?:L|リットル)(?:\s|$)/);
  if (match) return { quantity: Number(match[1]) * 1000, unit: "ml", needsReview: false };

  if (/(?:1\s*\/\s*2|半玉|半分)/.test(line)) {
    return {
      quantity: 0.5,
      unit: rule.fractionUnit || rule.unit,
      needsReview: false
    };
  }

  if (rule.id === "eggs") {
    match = line.match(/(\d{1,2})\s*(?:個|コ|ヶ|ケ|入)/);
    if (match) return { quantity: Number(match[1]), unit: "個", needsReview: false };
  }

  match = line.match(/(\d+(?:\.\d+)?)\s*(個|本|袋|パック|株|切れ)/);
  if (match) return { quantity: Number(match[1]), unit: match[2], needsReview: false };

  match = line.match(/(?:×|x|X)\s*(\d+)/);
  if (match) return { quantity: Number(match[1]), unit: rule.unit, needsReview: false };

  match = line.match(/(\d+)\s*点/);
  if (match) return { quantity: Number(match[1]), unit: rule.unit, needsReview: false };

  return { quantity: rule.quantity, unit: rule.unit, needsReview: true };
}

function parseReceiptText(rawText) {
  const ignoredLine = /(?:合計|小計|消費税|外税|内税|お預|お釣|釣銭|クレジット|カード|現金|ポイント|領収|レシート|電話|TEL|日時|担当|登録番号|買上点数|お買上)/i;
  const candidates = [];

  String(rawText).split(/\r?\n/).forEach((rawLine) => {
    const line = normalizedReceiptLine(rawLine);
    const compactLine = line.replace(/\s+/g, "");
    if (compactLine.length < 2 || ignoredLine.test(compactLine)) return;

    const rule = RECEIPT_RULES.find((candidate) => candidate.pattern.test(compactLine));
    if (!rule) return;

    const amount = receiptQuantity(compactLine, rule);
    const existing = candidates.find((candidate) =>
      candidate.id === rule.id && candidate.unit === amount.unit
    );

    if (existing) {
      existing.quantity = Number((existing.quantity + amount.quantity).toFixed(2));
      existing.needsReview = existing.needsReview || amount.needsReview;
      existing.rawLine = `${existing.rawLine} / ${line}`;
      return;
    }

    candidates.push({
      id: rule.id,
      name: rule.name,
      quantity: amount.quantity,
      unit: amount.unit,
      location: rule.location,
      needsReview: amount.needsReview,
      rawLine: line
    });
  });

  return candidates;
}

function receiptProgressUpdate(message) {
  const statusMap = {
    "loading tesseract core": ["文字認識エンジンを準備しています…", 12],
    "initializing tesseract": ["文字認識エンジンを起動しています…", 24],
    "loading language traineddata": ["日本語データを読み込んでいます…", 36],
    "initializing api": ["日本語の読み取りを準備しています…", 48],
    "recognizing text": ["レシートの文字を読み取っています…", 55]
  };
  const [label, base] = statusMap[message.status] || ["レシートを解析しています…", 8];
  const progress = message.status === "recognizing text"
    ? base + Math.round((message.progress || 0) * 44)
    : base + Math.round((message.progress || 0) * 8);
  elements.receiptStatus.textContent = label;
  elements.receiptProgress.value = Math.min(99, progress);
}

async function loadReceiptImage(file) {
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the image element path for older browsers.
    }
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を開けませんでした"));
    };
    image.src = url;
  });
}

async function prepareReceiptCanvas(file) {
  const image = await loadReceiptImage(file);
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  const scale = Math.min(1, 1800 / sourceWidth, 2800 / sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.filter = "grayscale(1) contrast(1.35) brightness(1.08)";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (typeof image.close === "function") image.close();
  return canvas;
}

function showReceiptError(message) {
  elements.receiptProcessing.hidden = true;
  elements.receiptResults.hidden = true;
  elements.receiptError.hidden = false;
  elements.receiptErrorMessage.textContent = message;
  elements.addReceiptCandidates.disabled = true;
}

function selectOptions(values, selected) {
  return values.map((value) =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
  ).join("");
}

function renderReceiptCandidate(candidate, index) {
  const reviewMessage = candidate.existingUnit
    ? `現在は${escapeHtml(candidate.existingUnit)}で管理中。単位と数量を合わせてください`
    : "数量は仮入力・要確認";

  return `
    <article class="receipt-candidate" data-receipt-candidate="${index}">
      <input type="checkbox" data-receipt-select aria-label="${escapeHtml(candidate.name)}を追加候補に含める" checked>
      ${renderIngredientIllustration(candidate.id, candidate.name, true)}
      <div class="receipt-candidate-fields">
        <label>
          食材名
          <input type="text" data-receipt-name value="${escapeHtml(candidate.name)}" required>
        </label>
        <div class="receipt-candidate-meta">
          <label>
            数量
            <input type="number" data-receipt-quantity inputmode="decimal" min="0.25" step="0.25" value="${candidate.quantity}" required>
          </label>
          <label>
            単位
            <select data-receipt-unit>${selectOptions(INVENTORY_UNITS, candidate.unit)}</select>
          </label>
          <label>
            保存場所
            <select data-receipt-location>${selectOptions(INVENTORY_LOCATIONS, candidate.location)}</select>
          </label>
        </div>
        <small class="receipt-source-line">
          ${candidate.needsReview ? `<span class="receipt-needs-review">${reviewMessage}</span>・` : ""}
          読取：${escapeHtml(candidate.rawLine)}
        </small>
      </div>
    </article>
  `;
}

function updateReceiptSelectionState() {
  const checkboxes = [...elements.receiptCandidates.querySelectorAll("[data-receipt-select]")];
  const selected = checkboxes.filter((checkbox) => checkbox.checked);
  checkboxes.forEach((checkbox) => {
    checkbox.closest(".receipt-candidate").classList.toggle("is-unselected", !checkbox.checked);
  });
  elements.addReceiptCandidates.disabled = selected.length === 0;
  elements.addReceiptCandidates.textContent = selected.length
    ? `${selected.length}品を在庫に追加`
    : "追加する食材を選択";
}

function renderReceiptResults(rawText, candidates) {
  state.receiptCandidates = candidates.map((candidate) => {
    const existing = activeInventory().find((item) =>
      item.id === candidate.id || item.name === candidate.name
    );
    if (!existing || existing.unit === candidate.unit) return candidate;
    return {
      ...candidate,
      existingUnit: existing.unit,
      needsReview: true
    };
  });
  elements.receiptProcessing.hidden = true;
  elements.receiptError.hidden = true;
  elements.receiptRawText.textContent = rawText.trim() || "文字を読み取れませんでした。";

  if (!state.receiptCandidates.length) {
    showReceiptError("文字は読み取れましたが、登録できる一般的な食材を見つけられませんでした。写真を撮り直すか、通常の食材追加をお試しください。");
    return;
  }

  elements.receiptResults.hidden = false;
  elements.receiptSummary.textContent = `${state.receiptCandidates.length}品を見つけました`;
  elements.receiptCandidates.innerHTML = state.receiptCandidates.map(renderReceiptCandidate).join("");
  updateReceiptSelectionState();
}

async function analyzeReceiptFile(file) {
  const runId = ++state.receiptRunId;
  let worker = null;

  try {
    if (!globalThis.Tesseract?.createWorker) {
      throw new Error("端末内OCRを読み込めませんでした");
    }

    elements.receiptStatus.textContent = "写真を読みやすく整えています…";
    elements.receiptProgress.value = 5;
    const canvas = await prepareReceiptCanvas(file);
    if (runId !== state.receiptRunId) return;

    const tesseractBase = new URL("./vendor/tesseract/", document.baseURI);
    worker = await Tesseract.createWorker("jpn", Tesseract.OEM?.LSTM_ONLY ?? 1, {
      workerPath: new URL("worker.min.js", tesseractBase).href,
      corePath: new URL("core", tesseractBase).href,
      langPath: new URL("lang", tesseractBase).href,
      cacheMethod: "write",
      logger: (message) => {
        if (runId === state.receiptRunId) receiptProgressUpdate(message);
      }
    });

    if (runId !== state.receiptRunId) return;
    state.receiptWorker = worker;
    const result = await worker.recognize(canvas);
    if (runId !== state.receiptRunId) return;

    elements.receiptProgress.value = 100;
    elements.receiptStatus.textContent = "読み取りが終わりました";
    const rawText = result.data?.text || "";
    renderReceiptResults(rawText, parseReceiptText(rawText));
  } catch (error) {
    if (runId === state.receiptRunId) {
      showReceiptError(error?.message || "レシートの解析中に問題が起きました。");
    }
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // The worker may already be terminated when the user cancels.
      }
    }
    if (state.receiptWorker === worker) state.receiptWorker = null;
  }
}

function openReceiptDialog(file) {
  state.receiptCandidates = [];
  elements.receiptProcessing.hidden = false;
  elements.receiptResults.hidden = true;
  elements.receiptError.hidden = true;
  elements.receiptCandidates.innerHTML = "";
  elements.receiptRawText.textContent = "";
  elements.receiptStatus.textContent = "写真を準備しています…";
  elements.receiptProgress.value = 0;
  elements.addReceiptCandidates.disabled = true;
  elements.addReceiptCandidates.textContent = "選択した食材を追加";

  if (state.receiptObjectUrl) URL.revokeObjectURL(state.receiptObjectUrl);
  state.receiptObjectUrl = URL.createObjectURL(file);
  elements.receiptPreview.src = state.receiptObjectUrl;
  elements.receiptDialog.showModal();
  analyzeReceiptFile(file);
}

function closeReceiptDialog() {
  state.receiptRunId += 1;
  if (state.receiptWorker) {
    state.receiptWorker.terminate().catch(() => {});
    state.receiptWorker = null;
  }
  if (state.receiptObjectUrl) {
    URL.revokeObjectURL(state.receiptObjectUrl);
    state.receiptObjectUrl = null;
  }
  elements.receiptPreview.removeAttribute("src");
  elements.receiptInput.value = "";
  if (elements.receiptDialog.open) elements.receiptDialog.close();
}

function addOrMergeInventoryItem({ name, quantity, unit, location, priority = false }) {
  const canonicalId = ALIASES.get(name) || makeId(name);
  const existing = state.inventory.find((item) =>
    item.id === canonicalId || item.name === name
  );

  if (existing) {
    existing.quantity = existing.active !== false && existing.unit === unit
      ? Number((existing.quantity + quantity).toFixed(2))
      : quantity;
    existing.unit = unit;
    existing.location = location;
    existing.priority = existing.priority || priority;
    existing.active = true;
    existing.confirmedAt = todayIso();
    existing.step = stepForUnit(unit);
    delete existing.consumedAt;
    return "merged";
  }

  state.inventory.push({
    id: canonicalId,
    name,
    quantity,
    unit,
    location,
    priority,
    active: true,
    confirmedAt: todayIso(),
    step: stepForUnit(unit)
  });
  return "added";
}

function saveReceiptCandidates(event) {
  event.preventDefault();
  const rows = [...elements.receiptCandidates.querySelectorAll(".receipt-candidate")]
    .filter((row) => row.querySelector("[data-receipt-select]").checked);
  if (!rows.length) return;

  const entries = [];
  for (const row of rows) {
    const candidate = state.receiptCandidates[Number(row.dataset.receiptCandidate)];
    const nameInput = row.querySelector("[data-receipt-name]");
    const quantityInput = row.querySelector("[data-receipt-quantity]");
    const unitInput = row.querySelector("[data-receipt-unit]");
    const name = nameInput.value.trim();
    const quantity = Number(quantityInput.value);
    if (!name) {
      nameInput.reportValidity();
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      quantityInput.reportValidity();
      return;
    }
    unitInput.setCustomValidity("");
    if (candidate?.existingUnit && unitInput.value !== candidate.existingUnit) {
      unitInput.setCustomValidity(`現在の在庫は${candidate.existingUnit}単位です。単位と数量を合わせるか、この候補を外してください。`);
      unitInput.reportValidity();
      return;
    }
    entries.push({
      name,
      quantity,
      unit: unitInput.value,
      location: row.querySelector("[data-receipt-location]").value
    });
  }

  entries.forEach(addOrMergeInventoryItem);
  persistInventory();
  renderAll();
  closeReceiptDialog();
  showView("management");
  showToast(`レシートから${entries.length}品を在庫に追加しました`);
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
    const result = addOrMergeInventoryItem({
      name,
      quantity,
      unit,
      location,
      priority: elements.ingredientPriority.checked
    });
    showToast(result === "merged" ? `${name}の残量に追加しました` : `${name}を追加しました`);
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
document.querySelector("#open-management").addEventListener("click", () => showView("management"));
document.querySelector("#scan-receipt").addEventListener("click", () => {
  elements.receiptInput.value = "";
  elements.receiptInput.click();
});
document.querySelector("#close-dialog").addEventListener("click", closeIngredientDialog);
document.querySelector("#cancel-dialog").addEventListener("click", closeIngredientDialog);
document.querySelector("#delete-ingredient").addEventListener("click", deleteCurrentIngredient);
document.querySelector("#review-inventory").addEventListener("click", () => showView("management"));
document.querySelector("#close-receipt-dialog").addEventListener("click", closeReceiptDialog);
document.querySelector("#cancel-receipt-dialog").addEventListener("click", closeReceiptDialog);
document.querySelector("#receipt-manual-add").addEventListener("click", () => {
  closeReceiptDialog();
  openIngredientDialog();
});
document.querySelector("#select-all-receipt").addEventListener("click", () => {
  const checkboxes = [...elements.receiptCandidates.querySelectorAll("[data-receipt-select]")];
  const selectAll = checkboxes.some((checkbox) => !checkbox.checked);
  checkboxes.forEach((checkbox) => {
    checkbox.checked = selectAll;
  });
  updateReceiptSelectionState();
});
elements.form.addEventListener("submit", saveIngredient);
elements.receiptForm.addEventListener("submit", saveReceiptCandidates);
elements.receiptInput.addEventListener("change", () => {
  const [file] = elements.receiptInput.files;
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("画像ファイルを選んでください");
    return;
  }
  openReceiptDialog(file);
});
elements.receiptCandidates.addEventListener("change", (event) => {
  if (event.target.matches("[data-receipt-select]")) updateReceiptSelectionState();
  if (event.target.matches("[data-receipt-unit]")) event.target.setCustomValidity("");
});

elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) closeIngredientDialog();
});

elements.receiptDialog.addEventListener("click", (event) => {
  if (event.target === elements.receiptDialog) closeReceiptDialog();
});

elements.fridgeScene.addEventListener("click", (event) => {
  const button = event.target.closest("[data-fridge-edit]");
  if (!button) return;
  showManagementItem(button.dataset.fridgeEdit);
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
