const STORAGE_KEY = "fridge-leftovers-inventory-v2";
const SHOPPING_STORAGE_KEY = "fridge-leftovers-shopping-v1";
const COOKING_HISTORY_STORAGE_KEY = "fridge-leftovers-cooking-history-v1";
const SHELF_COUNTS_STORAGE_KEY = "fridge-leftovers-shelf-counts-v1";
const RECENT_INGREDIENTS_STORAGE_KEY = "fridge-leftovers-recent-ingredients-v1";
const SETTINGS_STORAGE_KEY = "fridge-leftovers-settings-v1";
const DEVICE_STORAGE_KEY = "fridge-leftovers-device-v1";
const APP_VERSION = "0.18.0";
const recipeExpansion = globalThis.RECIPE_EXPANSION;
const RECIPE_EXPANSION_UNAVAILABLE = !recipeExpansion
  || typeof recipeExpansion !== "object"
  || Array.isArray(recipeExpansion)
  || !Array.isArray(recipeExpansion.recipes);
const EXPANDED_RECIPE_PACK = RECIPE_EXPANSION_UNAVAILABLE
  ? { recipes: [], steps: {}, seasons: {}, fallbacks: {} }
  : recipeExpansion;
if (!RECIPE_EXPANSION_UNAVAILABLE && EXPANDED_RECIPE_PACK.recipes.length !== 120) {
  console.warn(`追加レシピは120件ではなく${EXPANDED_RECIPE_PACK.recipes.length}件です`);
}
const RECIPE_PAGE_SIZE = 3;
const RECIPE_LIST_SERVINGS = 1;
const HISTORY_STORAGE_LIMIT = 1000;
const HISTORY_PAGE_SIZE = 50;

// 方針書の「初期状態では料理選びを複雑にしない」に合わせ、栄養表示は既定で出さない
const DEFAULT_SETTINGS = {
  showNutrition: false,
  sampleNoticeDone: false,
  dayAfterSkippedOn: "",
  // 見終わった売り場。進み具合の表示だけに使う（在庫の判定には使わない）
  reviewedCategories: []
};

// 賞味期限は時刻ではなく、その端末のカレンダー上の日付として扱う。
// Date.parse("YYYY-MM-DD") はUTCになるため、日付だけを分解して比較する。
function normalizedExpiryDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    ? text
    : "";
}

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 在庫確認・使い切り・買い物・翌日確認も、UTCではなく端末の暦日でそろえる。
const todayIso = () => localDateIso();

function purchasedOn(item) {
  return item.addedAt || item.confirmedAt || todayIso();
}

function expiryDayDifference(value, today = localDateIso()) {
  const expiry = normalizedExpiryDate(value);
  const base = normalizedExpiryDate(today);
  if (!expiry || !base) return null;
  const toUtcDay = (text) => {
    const [year, month, day] = text.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtcDay(expiry) - toUtcDay(base)) / 86400000);
}

function expiryAlertState(value, today = localDateIso()) {
  const days = expiryDayDifference(value, today);
  if (days === null || days > 3) return null;
  if (days < 0) return { days, kind: "expired", label: `${Math.abs(days)}日超過` };
  if (days === 0) return { days, kind: "today", label: "今日まで" };
  return { days, kind: "soon", label: `あと${days}日` };
}

function formatExpiryDate(value) {
  const normalized = normalizedExpiryDate(value);
  if (!normalized) return "";
  const [year, month, day] = normalized.split("-").map(Number);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).format(new Date(year, month - 1, day));
}

// 在庫の数量をどれだけ信じてよいか（方針書「数量は捨てるのでも盛るのでもなく、
// 確信度を持たせる」）。数量を持たない状態を作ると残量ゲージ・調理後の減算・
// 使い切りの判定まで null が伝播するので、数値は入れたまま確信度で区別する。
//
// ★確信度は画面に出さない。3段階を一覧へ並べると比較が難しくなり、
// 「記憶と判断の負担を減らす」という核に反する。使うのは次の2箇所だけ。
//   ・不足判定：不明の食材を「足りない」として候補から落とさない
//   ・作る直前：不明の食材の量だけ確認する
const QUANTITY_CONFIRMED = "確認済み";
const QUANTITY_ESTIMATED = "推定";
const QUANTITY_UNKNOWN = "不明";

// 保存済みデータには項目が無い。今まで手入力で登録してきた分なので確認済みとする
const CONFIDENCE_ORDER = [QUANTITY_CONFIRMED, QUANTITY_ESTIMATED, QUANTITY_UNKNOWN];
const quantityConfidence = (item) => {
  const value = item?.quantityConfidence;
  return CONFIDENCE_ORDER.includes(value) ? value : QUANTITY_CONFIRMED;
};
const quantityUnknown = (item) => quantityConfidence(item) === QUANTITY_UNKNOWN;
// 2つのうち確かでないほう。数量を足し合わせたときに使う
const lessCertain = (a, b) =>
  CONFIDENCE_ORDER[Math.max(CONFIDENCE_ORDER.indexOf(a), CONFIDENCE_ORDER.indexOf(b))];

// はじめから入っている5品。**本人の冷蔵庫ではない**ので、初回の料理提案が
// 実際と無関係になる。オンボーディングで置き換える対象で、origin で見分ける。
// 既存の保存データにはこの項目が無いため、片付けを提案するときは
// 数量・単位・場所が初期値のままかどうかも併せて見る。
const SAMPLE_ORIGIN = "sample";

const DEFAULT_INVENTORY = [
  { id: "cabbage", name: "キャベツ", quantity: 180, unit: "g", location: "冷蔵", priority: true, active: true, addedAt: todayIso(), confirmedAt: todayIso(), step: 50, origin: SAMPLE_ORIGIN },
  { id: "eggs", name: "卵", quantity: 3, unit: "個", location: "冷蔵", priority: false, active: true, addedAt: todayIso(), confirmedAt: todayIso(), step: 1, origin: SAMPLE_ORIGIN },
  { id: "mushroom", name: "しめじ", quantity: 0.5, unit: "株", location: "冷蔵", priority: false, active: true, addedAt: todayIso(), confirmedAt: todayIso(), step: 0.25, origin: SAMPLE_ORIGIN },
  { id: "pork", name: "豚こま", quantity: 120, unit: "g", location: "冷蔵", priority: false, active: true, addedAt: todayIso(), confirmedAt: todayIso(), step: 50, origin: SAMPLE_ORIGIN },
  { id: "rice", name: "ごはん", quantity: 1, unit: "膳", location: "冷凍", priority: false, active: true, addedAt: todayIso(), confirmedAt: todayIso(), step: 1, origin: SAMPLE_ORIGIN }
];

// 初回に「今夜使えそうな主役」として見せる食材。
//
// レシピの実データから選んでいる（`node scripts/pick-lead-ingredients.mjs`）。
// 選ぶ基準は「その食材が最低限必要に入るレシピが何件あるか」。選んだのに
// 候補が出ない食材を並べると、そこが行き止まりになるため。
//
// 総称と部位が両方ある場合（鶏むね・もも・ささみ・手羽）は、代用が効いて
// どれを選んでも同じ件数になる。並べても選びにくくなるだけなので、
// 家庭でよく買う形だけを出す。
//
// 各主役から最低3件へ直接つながるようにして、選んだ食材と無関係な補完候補を
// できるだけ減らす。
const LEAD_INGREDIENTS = [
  { name: "肉", ids: ["ground-meat", "pork", "pork-belly", "chicken", "chicken-thigh", "beef"] },
  { name: "魚介", ids: ["salmon", "tuna", "mackerel", "yellowtail", "shrimp"] },
  { name: "卵・豆腐", ids: ["eggs", "tofu", "natto"] },
  { name: "主食・麺", ids: ["rice", "bread", "pasta", "udon", "yakisoba-noodles", "soba"] }
];

// 気温や位置情報は使わず、端末の月だけで「この時期らしい」食材と料理を扱う。
// 旬は地域や品種で前後するため、厳密な出荷時期ではなく家庭料理の目安。
const SEASONAL_INGREDIENTS = {
  1: ["chinese-cabbage", "radish", "spinach", "green-onion", "yellowtail", "tofu"],
  2: ["chinese-cabbage", "radish", "spinach", "broccoli", "yellowtail", "tofu"],
  3: ["cabbage", "asparagus", "snow-peas", "boiled-bamboo", "clam", "strawberry"],
  4: ["cabbage", "asparagus", "snow-peas", "boiled-bamboo", "fuki", "clam"],
  5: ["cabbage", "asparagus", "snap-peas", "boiled-bamboo", "broad-beans", "strawberry"],
  6: ["tomato", "cucumber", "bell-pepper", "okra", "corn", "somen"],
  7: ["tomato", "eggplant", "cucumber", "bell-pepper", "okra", "somen"],
  8: ["tomato", "eggplant", "cucumber", "bitter-melon", "corn", "somen"],
  9: ["mushroom", "sweet-potato", "pumpkin", "taro", "saury", "grape"],
  10: ["mushroom", "sweet-potato", "pumpkin", "taro", "saury", "persimmon"],
  11: ["mushroom", "sweet-potato", "pumpkin", "lotus-root", "saury", "persimmon"],
  12: ["chinese-cabbage", "radish", "spinach", "green-onion", "yellowtail", "tofu"]
};

const SEASONAL_RECIPE_MONTHS = {
  "chilled-somen": [6, 7, 8],
  "tuna-tomato-somen": [6, 7, 8],
  "zaru-soba": [5, 6, 7, 8, 9],
  "pork-cold-soba": [6, 7, 8, 9],
  "natto-pasta": [6, 7, 8],
  "pork-chinese-cabbage-hotpot": [11, 12, 1, 2, 3],
  "tofu-mushroom-hotpot": [10, 11, 12, 1, 2, 3],
  "yellowtail-daikon": [11, 12, 1, 2],
  "pumpkin-simmer": [9, 10, 11],
  "pumpkin-salad": [9, 10, 11],
  "eggplant-miso": [6, 7, 8, 9],
  "tomato-cheese-bake": [6, 7, 8],
  "cream-stew": [11, 12, 1, 2],
  "tuna-cucumber-tofu": [6, 7, 8],
  "tofu-avocado-bowl": [6, 7, 8, 9],
  "tomato-shio-kombu-tofu": [6, 7, 8],
  "chicken-tomato-microwave": [6, 7, 8],
  "tomato-miso-soup": [6, 7, 8],
  "microwave-sweet-potato-butter": [9, 10, 11],
  "pumpkin-mince-microwave": [9, 10, 11],
  "mushroom-butter-rice": [9, 10, 11],
  "microwave-chicken-cabbage": [11, 12, 1, 2],
  "tofu-kimchi-soup": [11, 12, 1, 2],
  "cabbage-sausage-soup": [11, 12, 1, 2],
  ...EXPANDED_RECIPE_PACK.seasons
};

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
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "香りが締まる" },
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
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "和風おろしでさっぱりする" },
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
      { id: "spinach", name: "ほうれん草", quantity: 0.5, unit: "袋", benefit: "定番の付け合わせになる" },
      { id: "potato", name: "じゃがいも", quantity: 1, unit: "個", benefit: "一皿の満足感が増す" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "ソースの香りが立つ" }
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
      { id: "bell-pepper", name: "ピーマン", quantity: 0.5, unit: "袋", benefit: "定番の香りと彩りが出る" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" },
      { id: "cheese", name: "チーズ", quantity: 10, unit: "g", benefit: "仕上げのコクが増す" }
    ]
  },
  {
    id: "tofu-miso-soup",
    name: "豆腐とわかめの味噌汁",
    minutes: 10,
    required: [
      { id: "tofu", name: "豆腐", quantity: 0.5, unit: "個" },
      { id: "miso", name: "味噌", quantity: 20, unit: "g" }
    ],
    pantry: "水・だし",
    optional: [
      { id: "wakame", name: "わかめ", quantity: 0.1, unit: "袋", benefit: "定番の磯の風味が加わる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" },
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "野菜の食べ応えを足せる" }
    ]
  },
  {
    id: "chicken-cabbage-steam",
    name: "鶏むねとキャベツのフライパン蒸し",
    minutes: 15,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 120, unit: "g" },
      { id: "cabbage", name: "キャベツ", quantity: 150, unit: "g" }
    ],
    pantry: "塩・こしょう・酒・油",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食べ応えが増す" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香りが立つ" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げがさっぱりする" }
    ]
  },
  {
    id: "tomato-egg-stir-fry",
    name: "トマトと卵のふんわり炒め",
    minutes: 8,
    required: [
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクと満足感が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが出る" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" }
    ]
  },
  {
    id: "mapo-tofu-style",
    name: "ひき肉と豆腐の麻婆豆腐風",
    minutes: 15,
    required: [
      { id: "ground-meat", name: "ひき肉", quantity: 100, unit: "g" },
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" }
    ],
    pantry: "味噌・醤油・砂糖・水・片栗粉・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "定番の香りが加わる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "味が締まる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "食欲を誘う香りが出る" }
    ]
  },
  {
    id: "natto-rice",
    name: "納豆ごはん",
    minutes: 5,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "natto", name: "納豆", quantity: 1, unit: "パック" }
    ],
    pantry: "醤油",
    optional: [
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "まろやかさと満足感が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "後味がさっぱりする" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "香りとうま味を足せる" }
    ]
  },
  {
    id: "eggplant-mince-stir-fry",
    name: "なすとひき肉の甘辛炒め",
    minutes: 15,
    required: [
      { id: "eggplant", name: "なす", quantity: 2, unit: "本" },
      { id: "ground-meat", name: "ひき肉", quantity: 100, unit: "g" }
    ],
    pantry: "醤油・砂糖・みりん・油",
    optional: [
      { id: "bell-pepper", name: "ピーマン", quantity: 0.5, unit: "袋", benefit: "彩りと歯ごたえが加わる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "甘辛味が締まる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" }
    ]
  },
  {
    id: "chicken-broccoli-pan",
    name: "鶏むねとブロッコリーの塩炒め",
    minutes: 15,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 120, unit: "g" },
      { id: "broccoli", name: "ブロッコリー", quantity: 0.5, unit: "個" }
    ],
    pantry: "塩・こしょう・酒・油",
    optional: [
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香りが立つ" },
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "まろやかなコクが出る" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と量を足せる" }
    ]
  },
  {
    id: "oyakodon",
    name: "親子丼",
    minutes: 15,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 100, unit: "g" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" }
    ],
    pantry: "醤油・砂糖・みりん・水",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "定番の甘みが加わる" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" }
    ]
  },
  {
    id: "gyudon",
    name: "牛丼",
    minutes: 15,
    required: [
      { id: "beef", name: "牛肉", quantity: 100, unit: "g" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" }
    ],
    pantry: "醤油・砂糖・みりん・水",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "甘みと食べ応えが増す" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "まろやかな仕上がりになる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "甘辛味が締まる" }
    ]
  },
  {
    id: "fried-rice",
    name: "卵チャーハン",
    minutes: 10,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "醤油・塩・こしょう・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが出る" },
      { id: "pork", name: "豚こま", quantity: 50, unit: "g", benefit: "主食としての満足感が増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味を足せる" }
    ]
  },
  {
    id: "omurice",
    name: "オムライス",
    minutes: 20,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "ケチャップ・塩・こしょう・油",
    optional: [
      { id: "chicken", name: "鶏むね肉", quantity: 60, unit: "g", benefit: "チキンライスらしい食べ応えが出る" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと食感が加わる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "卵にコクが出る" }
    ]
  },
  {
    id: "soboro-bowl",
    name: "そぼろ丼",
    minutes: 12,
    required: [
      { id: "ground-meat", name: "ひき肉", quantity: 100, unit: "g" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" }
    ],
    pantry: "醤油・砂糖・みりん・油",
    optional: [
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "二色そぼろにできる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "肉の甘辛味が締まる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが出る" }
    ]
  },
  {
    id: "ginger-pork",
    name: "豚のしょうが焼き",
    minutes: 15,
    required: [
      { id: "pork", name: "豚こま", quantity: 120, unit: "g" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個" }
    ],
    pantry: "醤油・みりん・砂糖・油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "甘みとボリュームが増す" },
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g", benefit: "定番の付け合わせになる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "食欲を誘う香りが出る" }
    ]
  },
  {
    id: "chicken-teriyaki",
    name: "鶏の照り焼き",
    minutes: 18,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 150, unit: "g" }
    ],
    pantry: "醤油・みりん・砂糖・油",
    optional: [
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g", benefit: "たれを受ける付け合わせになる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "焼きねぎの甘みを足せる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "後味が締まる" }
    ]
  },
  {
    id: "chicken-karaage",
    name: "鶏のから揚げ",
    minutes: 25,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 150, unit: "g" }
    ],
    pantry: "醤油・酒・小麦粉または片栗粉・油",
    optional: [
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "下味の香りが強くなる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "肉の味が締まる" },
      { id: "lettuce", name: "レタス", quantity: 0.25, unit: "個", benefit: "さっぱりした付け合わせになる" }
    ]
  },
  {
    id: "beef-pepper-stir-fry",
    name: "牛肉とピーマンの炒め物",
    minutes: 15,
    required: [
      { id: "beef", name: "牛肉", quantity: 100, unit: "g" },
      { id: "bell-pepper", name: "ピーマン", quantity: 0.5, unit: "袋" }
    ],
    pantry: "醤油・砂糖・酒・油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "甘みと量が増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香りが立つ" }
    ]
  },
  {
    id: "meat-tofu",
    name: "肉豆腐",
    minutes: 20,
    required: [
      { id: "beef", name: "牛肉", quantity: 100, unit: "g" },
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" }
    ],
    pantry: "醤油・砂糖・みりん・水",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "煮汁に甘みが出る" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "定番の香りと甘みが加わる" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "煮汁のうま味が増す" }
    ]
  },
  {
    id: "pork-cabbage-millefeuille",
    name: "豚とキャベツの重ね蒸し",
    minutes: 18,
    required: [
      { id: "pork", name: "豚こま", quantity: 120, unit: "g" },
      { id: "cabbage", name: "キャベツ", quantity: 180, unit: "g" }
    ],
    pantry: "酒・塩・水",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "蒸し汁のうま味が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "さっぱりした後味になる" }
    ]
  },
  {
    id: "salmon-foil-yaki",
    name: "鮭ときのこのホイル焼き",
    minutes: 20,
    required: [
      { id: "salmon", name: "鮭", quantity: 1, unit: "切れ" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "定番のコクが出る" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと食べ応えが増す" },
      { id: "broccoli", name: "ブロッコリー", quantity: 0.25, unit: "個", benefit: "一皿の野菜量が増す" }
    ]
  },
  {
    id: "salmon-teriyaki",
    name: "鮭の照り焼き",
    minutes: 15,
    required: [
      { id: "salmon", name: "鮭", quantity: 1, unit: "切れ" }
    ],
    pantry: "醤油・みりん・砂糖・油",
    optional: [
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "甘辛味が締まる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りのある付け合わせになる" },
      { id: "spinach", name: "ほうれん草", quantity: 0.5, unit: "袋", benefit: "青菜の副菜を一緒に作れる" }
    ]
  },
  {
    id: "dashimaki-egg",
    name: "だし巻き卵",
    minutes: 10,
    required: [
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "だし・醤油・砂糖・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが出る" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクのあるアレンジになる" },
      { id: "spinach", name: "ほうれん草", quantity: 0.25, unit: "袋", benefit: "野菜と彩りを足せる" }
    ]
  },
  {
    id: "agedashi-tofu",
    name: "揚げ出し豆腐",
    minutes: 18,
    required: [
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" }
    ],
    pantry: "片栗粉・だし・醤油・みりん・油",
    optional: [
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "大根おろしでさっぱりする" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "つゆの味が締まる" }
    ]
  },
  {
    id: "tofu-steak",
    name: "豆腐ステーキ",
    minutes: 15,
    required: [
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" }
    ],
    pantry: "小麦粉・醤油・油",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "きのこソースにできる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りが加わる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香ばしさが増す" }
    ]
  },
  {
    id: "cheese-omelet",
    name: "チーズオムレツ",
    minutes: 10,
    required: [
      { id: "eggs", name: "卵", quantity: 2, unit: "個" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "tomato", name: "トマト", quantity: 0.5, unit: "個", benefit: "酸味と彩りが加わる" },
      { id: "spinach", name: "ほうれん草", quantity: 0.25, unit: "袋", benefit: "野菜を一緒に取れる" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" }
    ]
  },
  {
    id: "potato-salad",
    name: "ポテトサラダ",
    minutes: 20,
    required: [
      { id: "potato", name: "じゃがいも", quantity: 2, unit: "個" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "マヨネーズ・塩・こしょう",
    optional: [
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "定番の歯ごたえが加わる" },
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "甘みと彩りが出る" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "味が引き締まる" }
    ]
  },
  {
    id: "spinach-sesame",
    name: "ほうれん草のごま和え",
    minutes: 8,
    required: [
      { id: "spinach", name: "ほうれん草", quantity: 1, unit: "袋" }
    ],
    pantry: "すりごま・醤油・砂糖",
    optional: [
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "彩りと甘みが増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と量を足せる" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "香りとうま味が増す" }
    ]
  },
  {
    id: "eggplant-miso",
    name: "なすの味噌炒め",
    minutes: 12,
    required: [
      { id: "eggplant", name: "なす", quantity: 2, unit: "本" },
      { id: "miso", name: "味噌", quantity: 20, unit: "g" }
    ],
    pantry: "砂糖・醤油・油",
    optional: [
      { id: "pork", name: "豚こま", quantity: 80, unit: "g", benefit: "主菜としての満足感が増す" },
      { id: "bell-pepper", name: "ピーマン", quantity: 0.5, unit: "袋", benefit: "彩りと歯ごたえが加わる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "味噌味が締まる" }
    ]
  },
  {
    id: "cucumber-wakame-vinegar",
    name: "きゅうりとわかめの酢の物",
    minutes: 10,
    required: [
      { id: "cucumber", name: "きゅうり", quantity: 1, unit: "本" },
      { id: "wakame", name: "わかめ", quantity: 0.1, unit: "袋" }
    ],
    pantry: "酢・砂糖・醤油・塩",
    optional: [
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "さわやかな香りが加わる" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "うま味を足せる" },
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "食感と野菜量が増す" }
    ]
  },
  {
    id: "coleslaw",
    name: "コールスロー",
    minutes: 10,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 150, unit: "g" }
    ],
    pantry: "マヨネーズ・酢・砂糖・塩",
    optional: [
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "彩りと甘みが出る" },
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "みずみずしい食感が加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "食べ応えが増す" }
    ]
  },
  {
    id: "carbonara-style",
    name: "卵とチーズのカルボナーラ風",
    minutes: 15,
    required: [
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "塩・黒こしょう・油",
    optional: [
      { id: "milk", name: "牛乳", quantity: 0.25, unit: "本", benefit: "ソースがのばしやすくなる" },
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "コクが増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" }
    ]
  },
  {
    id: "mushroom-butter-pasta",
    name: "しめじのバター醤油パスタ",
    minutes: 15,
    required: [
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" },
      { id: "mushroom", name: "しめじ", quantity: 0.5, unit: "株" },
      { id: "butter", name: "バター", quantity: 10, unit: "g" }
    ],
    pantry: "醤油・塩",
    optional: [
      { id: "spinach", name: "ほうれん草", quantity: 0.25, unit: "袋", benefit: "野菜と彩りが加わる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香りが立つ" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "和風の香りが増す" }
    ]
  },
  {
    id: "pork-miso-soup",
    name: "豚汁",
    minutes: 25,
    required: [
      { id: "pork", name: "豚こま", quantity: 80, unit: "g" },
      { id: "radish", name: "大根", quantity: 0.25, unit: "本" },
      { id: "carrot", name: "にんじん", quantity: 0.5, unit: "本" },
      { id: "miso", name: "味噌", quantity: 20, unit: "g" }
    ],
    pantry: "水・だし・油",
    optional: [
      { id: "potato", name: "じゃがいも", quantity: 1, unit: "個", benefit: "汁物の食べ応えが増す" },
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "甘みが増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" }
    ]
  },
  {
    id: "vegetable-consomme",
    name: "野菜のコンソメスープ",
    minutes: 20,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g" },
      { id: "carrot", name: "にんじん", quantity: 0.5, unit: "本" },
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個" }
    ],
    pantry: "水・コンソメ・塩・こしょう",
    optional: [
      { id: "potato", name: "じゃがいも", quantity: 1, unit: "個", benefit: "食べ応えが増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味を足せる" },
      { id: "chicken", name: "鶏むね肉", quantity: 60, unit: "g", benefit: "主菜に近い満足感が出る" }
    ]
  },
  {
    id: "kake-udon",
    name: "かけうどん",
    minutes: 10,
    required: [
      { id: "udon", name: "うどん", quantity: 1, unit: "袋" }
    ],
    pantry: "だし・醤油・みりん・水",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "定番の香りが加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "月見うどんにできる" },
      { id: "wakame", name: "わかめ", quantity: 0.1, unit: "袋", benefit: "磯の香りと食べ応えが増す" }
    ]
  },
  {
    id: "curry-udon",
    name: "カレーうどん",
    minutes: 15,
    required: [
      { id: "udon", name: "うどん", quantity: 1, unit: "袋" }
    ],
    pantry: "カレールウ・だし・醤油・水",
    optional: [
      { id: "pork", name: "豚こま", quantity: 80, unit: "g", benefit: "主食としての満足感が増す" },
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個", benefit: "甘みととろみが増す" },
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "彩りと野菜量を足せる" }
    ]
  },
  {
    id: "kake-soba",
    name: "かけそば",
    minutes: 12,
    required: [
      { id: "soba", name: "そば", quantity: 100, unit: "g" }
    ],
    pantry: "だし・醤油・みりん・水",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "定番の香りが加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "月見そばにできる" },
      { id: "wakame", name: "わかめ", quantity: 0.1, unit: "袋", benefit: "磯の風味を足せる" }
    ]
  },
  {
    id: "sauce-yakisoba",
    name: "ソース焼きそば",
    minutes: 15,
    required: [
      { id: "yakisoba-noodles", name: "焼きそば麺", quantity: 1, unit: "袋" },
      { id: "pork", name: "豚こま", quantity: 80, unit: "g" },
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g" }
    ],
    pantry: "中濃ソースまたは焼きそばソース・油",
    optional: [
      { id: "bean-sprouts", name: "もやし", quantity: 0.5, unit: "袋", benefit: "食感とボリュームが増す" },
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "彩りと甘みが出る" },
      { id: "bell-pepper", name: "ピーマン", quantity: 0.5, unit: "袋", benefit: "香りと彩りを足せる" }
    ]
  },
  {
    id: "macaroni-gratin",
    name: "マカロニグラタン",
    minutes: 30,
    required: [
      { id: "macaroni", name: "マカロニ", quantity: 80, unit: "g" },
      { id: "milk", name: "牛乳", quantity: 0.5, unit: "本" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "小麦粉・バター・コンソメ・塩・こしょう",
    optional: [
      { id: "chicken", name: "鶏むね肉", quantity: 80, unit: "g", benefit: "主菜としての満足感が増す" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと食感が加わる" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味を足せる" }
    ]
  },
  {
    id: "mackerel-miso",
    name: "さばの味噌煮",
    minutes: 25,
    required: [
      { id: "mackerel", name: "さば", quantity: 1, unit: "切れ" },
      { id: "miso", name: "味噌", quantity: 20, unit: "g" }
    ],
    pantry: "砂糖・みりん・酒・水",
    optional: [
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "魚の風味をさっぱり整える" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "煮汁に甘みと香りが出る" },
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "煮汁を含む付け合わせになる" }
    ]
  },
  {
    id: "mackerel-salt-grill",
    name: "さばの塩焼き",
    minutes: 15,
    required: [
      { id: "mackerel", name: "さば", quantity: 1, unit: "切れ" }
    ],
    pantry: "塩・油",
    optional: [
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "大根おろしでさっぱり食べられる" },
      { id: "spinach", name: "ほうれん草", quantity: 0.25, unit: "袋", benefit: "青菜の副菜を添えられる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "魚の風味を整える" }
    ]
  },
  {
    id: "yellowtail-teriyaki",
    name: "ぶりの照り焼き",
    minutes: 18,
    required: [
      { id: "yellowtail", name: "ぶり", quantity: 1, unit: "切れ" }
    ],
    pantry: "醤油・みりん・砂糖・油",
    optional: [
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "大根おろしで後味が軽くなる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "甘辛味が締まる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "焼きねぎを添えられる" }
    ]
  },
  {
    id: "yellowtail-daikon",
    name: "ぶり大根",
    minutes: 35,
    required: [
      { id: "yellowtail", name: "ぶり", quantity: 1, unit: "切れ" },
      { id: "radish", name: "大根", quantity: 0.5, unit: "本" }
    ],
    pantry: "醤油・砂糖・みりん・酒・水",
    optional: [
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "魚の風味を整える" },
      { id: "konnyaku", name: "こんにゃく", quantity: 0.5, unit: "枚", benefit: "煮物の食べ応えが増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが出る" }
    ]
  },
  {
    id: "shrimp-chili",
    name: "えびチリ",
    minutes: 18,
    required: [
      { id: "shrimp", name: "えび", quantity: 120, unit: "g" }
    ],
    pantry: "ケチャップ・砂糖・酢・醤油・片栗粉・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "中華らしい香りが加わる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "ソースの香りが立つ" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "味が締まる" }
    ]
  },
  {
    id: "shrimp-fried-rice",
    name: "えびチャーハン",
    minutes: 12,
    required: [
      { id: "shrimp", name: "えび", quantity: 80, unit: "g" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "醤油・塩・こしょう・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが出る" },
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "甘みと彩りを足せる" },
      { id: "bean-sprouts", name: "もやし", quantity: 0.25, unit: "袋", benefit: "食感と量が増す" }
    ]
  },
  {
    id: "tuna-mayo-rice",
    name: "ツナマヨごはん",
    minutes: 5,
    required: [
      { id: "tuna", name: "ツナ", quantity: 1, unit: "缶" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" }
    ],
    pantry: "マヨネーズ・醤油",
    optional: [
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "みずみずしい食感が加わる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "後味がさっぱりする" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "まろやかさと満足感が増す" }
    ]
  },
  {
    id: "bean-sprout-namul",
    name: "もやしのナムル",
    minutes: 7,
    required: [
      { id: "bean-sprouts", name: "もやし", quantity: 1, unit: "袋" }
    ],
    pantry: "ごま油・醤油・塩・ごま",
    optional: [
      { id: "garlic-chives", name: "にら", quantity: 0.5, unit: "袋", benefit: "香りと彩りが増す" },
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "甘みと彩りを足せる" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "味にパンチが出る" }
    ]
  },
  {
    id: "nira-tama",
    name: "にら玉",
    minutes: 8,
    required: [
      { id: "garlic-chives", name: "にら", quantity: 1, unit: "袋" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "醤油・塩・こしょう・油",
    optional: [
      { id: "bean-sprouts", name: "もやし", quantity: 0.5, unit: "袋", benefit: "食感とボリュームが増す" },
      { id: "pork", name: "豚こま", quantity: 80, unit: "g", benefit: "主菜としての満足感が増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味を足せる" }
    ]
  },
  {
    id: "pumpkin-simmer",
    name: "かぼちゃの煮物",
    minutes: 20,
    required: [
      { id: "pumpkin", name: "かぼちゃ", quantity: 200, unit: "g" }
    ],
    pantry: "醤油・砂糖・みりん・水",
    optional: [
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "洋風のコクを足せる" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "だしのうま味が増す" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "甘い煮汁が締まる" }
    ]
  },
  {
    id: "pumpkin-salad",
    name: "かぼちゃサラダ",
    minutes: 15,
    required: [
      { id: "pumpkin", name: "かぼちゃ", quantity: 200, unit: "g" }
    ],
    pantry: "マヨネーズ・塩・こしょう",
    optional: [
      { id: "yogurt", name: "ヨーグルト", quantity: 0.5, unit: "個", benefit: "軽い酸味でなめらかになる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "塩気とコクが増す" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "食べ応えが増す" }
    ]
  },
  {
    id: "konnyaku-piquant",
    name: "こんにゃくの甘辛炒め",
    minutes: 12,
    required: [
      { id: "konnyaku", name: "こんにゃく", quantity: 1, unit: "枚" }
    ],
    pantry: "醤油・みりん・砂糖・ごま油",
    optional: [
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "彩りと甘みが増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "仕上げのうま味が増す" }
    ]
  },
  {
    id: "cream-stew",
    name: "クリームシチュー",
    minutes: 35,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 100, unit: "g" },
      { id: "potato", name: "じゃがいも", quantity: 1, unit: "個" },
      { id: "onion", name: "玉ねぎ", quantity: 0.5, unit: "個" },
      { id: "carrot", name: "にんじん", quantity: 0.5, unit: "本" },
      { id: "milk", name: "牛乳", quantity: 0.5, unit: "本" }
    ],
    pantry: "小麦粉・バター・コンソメ・水・塩・こしょう",
    optional: [
      { id: "broccoli", name: "ブロッコリー", quantity: 0.25, unit: "個", benefit: "彩りと野菜量が増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味を足せる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "濃厚なコクが出る" }
    ]
  },
  {
    id: "gyoza",
    name: "焼き餃子",
    minutes: 30,
    required: [
      { id: "ground-meat", name: "ひき肉", quantity: 120, unit: "g" },
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g" },
      { id: "garlic-chives", name: "にら", quantity: 0.5, unit: "袋" }
    ],
    pantry: "餃子の皮・醤油・ごま油・塩・水・油",
    optional: [
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "餡の香りが強くなる" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "肉の味が締まる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "餡の香りと甘みが増す" }
    ]
  },
  {
    id: "croquette",
    name: "ポテトコロッケ",
    minutes: 35,
    required: [
      { id: "potato", name: "じゃがいも", quantity: 2, unit: "個" },
      { id: "ground-meat", name: "ひき肉", quantity: 80, unit: "g" },
      { id: "breadcrumbs", name: "パン粉", quantity: 30, unit: "g" }
    ],
    pantry: "小麦粉・塩・こしょう・油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと食感が加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "衣が均一につきやすくなる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "中にコクを足せる" }
    ]
  },
  {
    id: "rolled-cabbage",
    name: "ロールキャベツ",
    minutes: 35,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 150, unit: "g" },
      { id: "ground-meat", name: "ひき肉", quantity: 100, unit: "g" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個" }
    ],
    pantry: "コンソメ・塩・こしょう・水",
    optional: [
      { id: "tomato", name: "トマト", quantity: 1, unit: "個", benefit: "スープに酸味とうま味が出る" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "スープのうま味が増す" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "中にコクを足せる" }
    ]
  },
  {
    id: "menchi-katsu",
    name: "メンチカツ",
    minutes: 30,
    required: [
      { id: "ground-meat", name: "ひき肉", quantity: 120, unit: "g" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個" },
      { id: "breadcrumbs", name: "パン粉", quantity: 30, unit: "g" }
    ],
    pantry: "小麦粉・卵・塩・こしょう・油",
    optional: [
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g", benefit: "付け合わせを一緒に用意できる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "中に濃厚なコクを足せる" }
    ]
  },
  {
    id: "yaki-udon",
    name: "焼きうどん",
    minutes: 15,
    required: [
      { id: "udon", name: "うどん", quantity: 1, unit: "袋" },
      { id: "pork", name: "豚こま", quantity: 80, unit: "g" },
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g" }
    ],
    pantry: "醤油・ソース・油・こしょう",
    optional: [
      { id: "carrot", name: "にんじん", quantity: 0.25, unit: "本", benefit: "彩りと甘みが増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感を足せる" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "仕上げの香りが増す" }
    ]
  },
  {
    id: "tuna-tomato-pasta",
    name: "ツナとトマトのパスタ",
    minutes: 18,
    required: [
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" },
      { id: "tuna", name: "ツナ", quantity: 1, unit: "缶" },
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "ソースに甘みが出る" },
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香りが立つ" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "仕上げにコクが出る" }
    ]
  },
  {
    id: "chicken-cream-pasta",
    name: "鶏としめじのクリームパスタ",
    minutes: 22,
    required: [
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" },
      { id: "chicken", name: "鶏むね肉", quantity: 80, unit: "g" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株" },
      { id: "milk", name: "牛乳", quantity: 0.5, unit: "本" }
    ],
    pantry: "小麦粉・バター・塩・こしょう",
    optional: [
      { id: "spinach", name: "ほうれん草", quantity: 0.5, unit: "袋", benefit: "彩りと野菜量が増す" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "ソースが濃厚になる" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "自然な甘みが出る" }
    ]
  },
  {
    id: "tofu-champuru",
    name: "豆腐チャンプルー",
    minutes: 15,
    required: [
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "醤油・塩・こしょう・油",
    optional: [
      { id: "pork", name: "豚こま", quantity: 80, unit: "g", benefit: "主菜としての満足感が増す" },
      { id: "cabbage", name: "キャベツ", quantity: 80, unit: "g", benefit: "野菜量と食感が増す" },
      { id: "bonito", name: "かつお節", quantity: 1, unit: "袋", benefit: "仕上げのうま味が増す" }
    ]
  },
  {
    id: "salmon-fried-rice",
    name: "鮭チャーハン",
    minutes: 15,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "salmon", name: "鮭", quantity: 1, unit: "切れ" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "醤油・塩・こしょう・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと彩りが増す" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と食感が増す" },
      { id: "sesame-oil", name: "ごま油", quantity: 1, unit: "小さじ", benefit: "仕上げが香ばしくなる" }
    ]
  },
  {
    id: "cabbage-tuna-simmer",
    name: "キャベツとツナのさっと煮",
    minutes: 12,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 150, unit: "g" },
      { id: "tuna", name: "ツナ", quantity: 1, unit: "缶" }
    ],
    pantry: "醤油・みりん・水",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "煮汁のうま味が増す" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "後味が締まる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "卵とじにして食べ応えを足せる" }
    ]
  },
  {
    id: "potato-cheese-bake",
    name: "じゃがいものチーズ焼き",
    minutes: 20,
    required: [
      { id: "potato", name: "じゃがいも", quantity: 2, unit: "個" },
      { id: "cheese", name: "チーズ", quantity: 40, unit: "g" }
    ],
    pantry: "塩・こしょう",
    optional: [
      { id: "milk", name: "牛乳", quantity: 0.25, unit: "本", benefit: "中がしっとり仕上がる" },
      { id: "broccoli", name: "ブロッコリー", quantity: 0.25, unit: "個", benefit: "彩りと野菜量が増す" },
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "香りとコクが増す" }
    ]
  },
  {
    id: "tomato-cheese-bake",
    name: "トマトのチーズ焼き",
    minutes: 12,
    required: [
      { id: "tomato", name: "トマト", quantity: 2, unit: "個" },
      { id: "cheese", name: "チーズ", quantity: 40, unit: "g" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "主菜らしい食べ応えが増す" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと香りが増す" },
      { id: "bread", name: "食パン", quantity: 1, unit: "枚", benefit: "一緒に焼いて主食にできる" }
    ]
  },
  {
    id: "cheese-toast",
    name: "チーズトースト",
    minutes: 5,
    required: [
      { id: "bread", name: "食パン", quantity: 1, unit: "枚" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "こしょう",
    optional: [
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "香りとコクが増す" },
      { id: "tomato", name: "トマト", quantity: 0.5, unit: "個", benefit: "後味が軽くなる" }
    ]
  },
  {
    id: "pizza-toast",
    name: "ピザトースト",
    minutes: 10,
    required: [
      { id: "bread", name: "食パン", quantity: 2, unit: "枚" },
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "ケチャップ・塩・こしょう・油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと食感が増す" },
      { id: "bell-pepper", name: "ピーマン", quantity: 0.25, unit: "袋", benefit: "彩りと苦みが加わる" }
    ]
  },
  {
    id: "tuna-toast",
    name: "ツナトースト",
    minutes: 8,
    required: [
      { id: "bread", name: "食パン", quantity: 2, unit: "枚" },
      { id: "tuna", name: "ツナ", quantity: 1, unit: "缶" }
    ],
    pantry: "マヨネーズ・こしょう",
    optional: [
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクと満足感が増す" },
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "食感が軽くなる" }
    ]
  },
  {
    id: "french-toast",
    name: "フレンチトースト",
    minutes: 10,
    required: [
      { id: "bread", name: "食パン", quantity: 2, unit: "枚" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "砂糖・油",
    optional: [
      { id: "milk", name: "牛乳", quantity: 0.25, unit: "本", benefit: "中がしっとり仕上がる" },
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "焼き色と香りが良くなる" }
    ]
  },
  {
    id: "egg-sandwich",
    name: "たまごサンド",
    minutes: 12,
    required: [
      { id: "bread", name: "食パン", quantity: 2, unit: "枚" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "マヨネーズ・塩・こしょう",
    optional: [
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "食感がさっぱりする" },
      { id: "lettuce", name: "レタス", quantity: 0.25, unit: "個", benefit: "見た目と歯ざわりが良くなる" }
    ]
  },
  {
    id: "mackerel-ginger-stew",
    name: "さばのしょうが煮",
    minutes: 22,
    required: [
      { id: "mackerel", name: "さば", quantity: 1, unit: "切れ" }
    ],
    pantry: "醤油・砂糖・みりん・酒・水",
    optional: [
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "魚の風味をさっぱり整える" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "甘みと香りが加わる" },
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "煮汁を含む付け合わせになる" }
    ]
  },
  {
    id: "yellowtail-salt-grill",
    name: "ぶりの塩焼き",
    minutes: 16,
    required: [
      { id: "yellowtail", name: "ぶり", quantity: 1, unit: "切れ" }
    ],
    pantry: "塩・油",
    optional: [
      { id: "radish", name: "大根", quantity: 0.25, unit: "本", benefit: "大根おろしで後味が軽くなる" },
      { id: "lemon", name: "レモン", quantity: 0.25, unit: "個", benefit: "脂のある魚をさっぱり食べられる" },
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "香りを添えられる" }
    ]
  },
  {
    id: "shrimp-garlic-saute",
    name: "えびのガーリック炒め",
    minutes: 12,
    required: [
      { id: "shrimp", name: "えび", quantity: 120, unit: "g" }
    ],
    pantry: "にんにく・塩・こしょう・油",
    optional: [
      { id: "broccoli", name: "ブロッコリー", quantity: 0.5, unit: "個", benefit: "彩りと食べ応えが増す" },
      { id: "mushroom-button", name: "マッシュルーム", quantity: 0.5, unit: "パック", benefit: "うま味と食感が増す" },
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "香りとコクが増す" }
    ]
  },
  {
    id: "natto-omelet",
    name: "納豆オムレツ",
    minutes: 10,
    required: [
      { id: "natto", name: "納豆", quantity: 1, unit: "パック" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "醤油・塩・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと食感が加わる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクが増してまとまりやすい" },
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "後味がさっぱりする" }
    ]
  },
  {
    id: "natto-pasta",
    name: "納豆とねぎの和風パスタ",
    minutes: 12,
    required: [
      { id: "natto", name: "納豆", quantity: 1, unit: "パック" },
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" }
    ],
    pantry: "醤油・油",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと食感が加わる" },
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋", benefit: "磯の香りが加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "まろやかさと満足感が増す" }
    ]
  },
  {
    id: "zaru-soba",
    name: "ざるそば",
    minutes: 10,
    required: [
      { id: "soba", name: "そば", quantity: 100, unit: "g" }
    ],
    pantry: "だし・醤油・みりん・水・わさび",
    optional: [
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "定番の薬味になる" },
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋", benefit: "磯の香りが加わる" },
      { id: "tenkasu", name: "天かす", quantity: 0.1, unit: "袋", benefit: "香ばしさと食べ応えが増す" }
    ]
  },
  {
    id: "pork-cold-soba",
    name: "豚しゃぶおろしそば",
    minutes: 18,
    required: [
      { id: "soba", name: "そば", quantity: 100, unit: "g" },
      { id: "pork", name: "豚こま", quantity: 80, unit: "g" },
      { id: "radish", name: "大根", quantity: 0.25, unit: "本" }
    ],
    pantry: "だし・醤油・みりん・水",
    optional: [
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "香りが加わる" },
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "みずみずしい食感が増す" },
      { id: "tomato", name: "トマト", quantity: 0.5, unit: "個", benefit: "彩りと酸味が加わる" }
    ]
  },
  {
    id: "salt-yakisoba",
    name: "野菜の塩焼きそば",
    minutes: 13,
    required: [
      { id: "yakisoba-noodles", name: "焼きそば麺", quantity: 1, unit: "袋" },
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g" }
    ],
    pantry: "塩・こしょう・鶏がらスープの素・油",
    optional: [
      { id: "bean-sprouts", name: "もやし", quantity: 0.5, unit: "袋", benefit: "食感と量が増す" },
      { id: "pork", name: "豚こま", quantity: 80, unit: "g", benefit: "主菜らしい満足感が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りが加わる" }
    ]
  },
  {
    id: "sobameshi",
    name: "焼きそば麺のそばめし",
    minutes: 15,
    required: [
      { id: "yakisoba-noodles", name: "焼きそば麺", quantity: 1, unit: "袋" },
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" }
    ],
    pantry: "中濃ソース・塩・こしょう・油",
    optional: [
      { id: "cabbage", name: "キャベツ", quantity: 80, unit: "g", benefit: "食感と野菜量が増す" },
      { id: "pork", name: "豚こま", quantity: 60, unit: "g", benefit: "うま味と満足感が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "仕上げの香りが加わる" }
    ]
  },
  {
    id: "chilled-somen",
    name: "冷やしそうめん",
    minutes: 10,
    required: [
      { id: "somen", name: "そうめん", quantity: 1, unit: "袋" }
    ],
    pantry: "だし・醤油・みりん・水",
    optional: [
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "涼しい食感が加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "錦糸卵で彩りと満足感が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "定番の薬味になる" }
    ]
  },
  {
    id: "tuna-tomato-somen",
    name: "ツナトマトそうめん",
    minutes: 12,
    required: [
      { id: "somen", name: "そうめん", quantity: 1, unit: "袋" },
      { id: "tuna", name: "ツナ", quantity: 1, unit: "缶" },
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" }
    ],
    pantry: "めんつゆ・油",
    optional: [
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "食感と清涼感が増す" },
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "香りが加わる" },
      { id: "sesame", name: "ごま", quantity: 0.1, unit: "袋", benefit: "香ばしさが増す" }
    ]
  },
  {
    id: "pork-chinese-cabbage-hotpot",
    name: "豚肉と白菜の重ね鍋",
    minutes: 25,
    required: [
      { id: "pork", name: "豚こま", quantity: 120, unit: "g" },
      { id: "chinese-cabbage", name: "白菜", quantity: 250, unit: "g" }
    ],
    pantry: "だし・醤油・酒・水",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味が増す" },
      { id: "tofu", name: "豆腐", quantity: 0.5, unit: "個", benefit: "食べ応えが増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "甘みと香りが加わる" }
    ]
  },
  {
    id: "tofu-mushroom-hotpot",
    name: "豆腐ときのこの寄せ鍋",
    minutes: 20,
    required: [
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" },
      { id: "mushroom", name: "しめじ", quantity: 0.5, unit: "株" }
    ],
    pantry: "だし・醤油・みりん・水",
    optional: [
      { id: "chinese-cabbage", name: "白菜", quantity: 150, unit: "g", benefit: "甘みと野菜量が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.5, unit: "本", benefit: "香りと甘みが加わる" },
      { id: "chicken", name: "鶏むね肉", quantity: 100, unit: "g", benefit: "主菜らしい満足感が増す" }
    ]
  },
  {
    id: "microwave-pork-kimchi",
    name: "豚バラキムチのレンジ蒸し",
    minutes: 9,
    required: [
      { id: "pork-belly", name: "豚バラ肉", quantity: 100, unit: "g" },
      { id: "kimchi", name: "キムチ", quantity: 0.5, unit: "袋" }
    ],
    pantry: "醤油・ごま油",
    optional: [
      { id: "bean-sprouts", name: "もやし", quantity: 0.5, unit: "袋", benefit: "食感と野菜量が増す" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "仕上げの香りが加わる" }
    ]
  },
  {
    id: "microwave-cabbage-shumai",
    name: "包まないキャベツ焼売",
    minutes: 12,
    required: [
      { id: "pork-mince", name: "豚ひき肉", quantity: 120, unit: "g" },
      { id: "cabbage", name: "キャベツ", quantity: 120, unit: "g" }
    ],
    pantry: "片栗粉・醤油・ごま油・塩",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みと食感が増す" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "香りが締まる" }
    ]
  },
  {
    id: "microwave-eggplant-pork-ponzu",
    name: "なすと豚バラのレンジ蒸し",
    minutes: 10,
    required: [
      { id: "eggplant", name: "なす", quantity: 2, unit: "本" },
      { id: "pork-belly", name: "豚バラ肉", quantity: 100, unit: "g" }
    ],
    pantry: "ポン酢・酒・ごま油",
    optional: [
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "後味がさっぱりする" },
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "香りが加わる" }
    ]
  },
  {
    id: "microwave-tofu-egg-soup",
    name: "豆腐と卵のレンジスープ",
    minutes: 7,
    required: [
      { id: "tofu", name: "豆腐", quantity: 0.5, unit: "個" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "鶏がらスープの素・醤油・水",
    optional: [
      { id: "wakame", name: "わかめ", quantity: 0.1, unit: "袋", benefit: "磯の香りと食感が加わる" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "彩りと香りが加わる" }
    ]
  },
  {
    id: "microwave-salmon-mushroom",
    name: "鮭としめじのレンジ酒蒸し",
    minutes: 12,
    required: [
      { id: "salmon", name: "鮭", quantity: 1, unit: "切れ" },
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株" }
    ],
    pantry: "酒・塩・醤油",
    optional: [
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "コクと香りが増す" },
      { id: "lemon", name: "レモン", quantity: 0.25, unit: "個", benefit: "後味が軽くなる" }
    ]
  },
  {
    id: "microwave-bean-sprout-pork",
    name: "もやしと豚バラのレンジ蒸し",
    minutes: 9,
    required: [
      { id: "bean-sprouts", name: "もやし", quantity: 1, unit: "袋" },
      { id: "pork-belly", name: "豚バラ肉", quantity: 100, unit: "g" }
    ],
    pantry: "酒・塩・こしょう・ポン酢",
    optional: [
      { id: "garlic-chives", name: "にら", quantity: 0.25, unit: "袋", benefit: "香りと彩りが増す" },
      { id: "sesame", name: "ごま", quantity: 0.1, unit: "袋", benefit: "香ばしさが加わる" }
    ]
  },
  {
    id: "microwave-chicken-cabbage",
    name: "鶏むねと白菜のレンジ蒸し",
    minutes: 12,
    required: [
      { id: "chicken", name: "鶏むね肉", quantity: 120, unit: "g" },
      { id: "chinese-cabbage", name: "白菜", quantity: 150, unit: "g" }
    ],
    pantry: "酒・塩・鶏がらスープの素",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味が増す" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "甘みと香りが加わる" }
    ]
  },
  {
    id: "microwave-tomato-cheese-rice",
    name: "トマトチーズのレンジごはん",
    minutes: 10,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "塩・こしょう・オリーブ油",
    optional: [
      { id: "tuna", name: "ツナ", quantity: 0.5, unit: "缶", benefit: "たんぱく質と満足感が増す" },
      { id: "basil", name: "バジル", quantity: 0.25, unit: "袋", benefit: "香りが華やかになる" }
    ]
  },
  {
    id: "microwave-sweet-potato-butter",
    name: "さつまいものレンジバター",
    minutes: 10,
    required: [
      { id: "sweet-potato", name: "さつまいも", quantity: 1, unit: "本" }
    ],
    pantry: "塩・水",
    optional: [
      { id: "butter", name: "バター", quantity: 10, unit: "g", benefit: "甘みとコクが増す" },
      { id: "sesame", name: "ごま", quantity: 0.1, unit: "袋", benefit: "香ばしい食感が加わる" }
    ]
  },
  {
    id: "microwave-potato-tuna-salad",
    name: "レンジでツナポテトサラダ",
    minutes: 12,
    required: [
      { id: "potato", name: "じゃがいも", quantity: 2, unit: "個" },
      { id: "tuna", name: "ツナ", quantity: 1, unit: "缶" }
    ],
    pantry: "マヨネーズ・塩・こしょう",
    optional: [
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本", benefit: "食感が軽くなる" },
      { id: "corn", name: "とうもろこし", quantity: 0.5, unit: "本", benefit: "甘みと彩りが増す" }
    ]
  },
  {
    id: "whitebait-green-onion-bowl",
    name: "しらすと小ねぎの即席丼",
    minutes: 5,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "whitebait", name: "しらす", quantity: 0.5, unit: "パック" }
    ],
    pantry: "醤油・ごま油",
    optional: [
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "香りと彩りが加わる" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "コクと満足感が増す" }
    ]
  },
  {
    id: "tuna-cucumber-tofu",
    name: "ツナきゅうり冷ややっこ",
    minutes: 5,
    required: [
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" },
      { id: "tuna", name: "ツナ", quantity: 0.5, unit: "缶" },
      { id: "cucumber", name: "きゅうり", quantity: 0.5, unit: "本" }
    ],
    pantry: "醤油・酢・ごま油",
    optional: [
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "清涼感が増す" },
      { id: "sesame", name: "ごま", quantity: 0.1, unit: "袋", benefit: "香ばしさが加わる" }
    ]
  },
  {
    id: "canned-mackerel-tomato",
    name: "サバ缶のトマト煮",
    minutes: 10,
    required: [
      { id: "canned-mackerel", name: "サバ缶", quantity: 1, unit: "缶" },
      { id: "canned-tomato", name: "トマト缶", quantity: 0.5, unit: "缶" }
    ],
    pantry: "塩・こしょう・オリーブ油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みが加わる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "まろやかなコクが増す" }
    ]
  },
  {
    id: "kimchi-cheese-udon",
    name: "キムチーズうどん",
    minutes: 10,
    required: [
      { id: "udon", name: "うどん", quantity: 1, unit: "袋" },
      { id: "kimchi", name: "キムチ", quantity: 0.5, unit: "袋" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "めんつゆ・水",
    optional: [
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "辛みがまろやかになる" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "香りと彩りが加わる" }
    ]
  },
  {
    id: "natto-kimchi-bowl",
    name: "納豆キムチ丼",
    minutes: 5,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "natto", name: "納豆", quantity: 1, unit: "パック" },
      { id: "kimchi", name: "キムチ", quantity: 0.25, unit: "袋" }
    ],
    pantry: "醤油・ごま油",
    optional: [
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "コクと満足感が増す" },
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋", benefit: "磯の香りが加わる" }
    ]
  },
  {
    id: "canned-sardine-cabbage-pasta",
    name: "いわし缶とキャベツのパスタ",
    minutes: 12,
    required: [
      { id: "canned-sardine", name: "いわし缶", quantity: 1, unit: "缶" },
      { id: "cabbage", name: "キャベツ", quantity: 100, unit: "g" },
      { id: "pasta", name: "スパゲッティ", quantity: 100, unit: "g" }
    ],
    pantry: "醤油・油・こしょう",
    optional: [
      { id: "garlic", name: "にんにく", quantity: 0.25, unit: "個", benefit: "香りが立つ" },
      { id: "lemon", name: "レモン", quantity: 0.25, unit: "個", benefit: "後味が軽くなる" }
    ]
  },
  {
    id: "bacon-spinach-egg",
    name: "ベーコンとほうれん草の卵炒め",
    minutes: 10,
    required: [
      { id: "bacon", name: "ベーコン", quantity: 50, unit: "g" },
      { id: "spinach", name: "ほうれん草", quantity: 0.5, unit: "袋" },
      { id: "eggs", name: "卵", quantity: 1, unit: "個" }
    ],
    pantry: "塩・こしょう・油",
    optional: [
      { id: "mushroom", name: "しめじ", quantity: 0.25, unit: "株", benefit: "うま味と量が増す" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクが増す" }
    ]
  },
  {
    id: "chicken-tender-shiso-cheese",
    name: "ささみの大葉チーズ蒸し",
    minutes: 12,
    required: [
      { id: "chicken-tender", name: "鶏ささみ", quantity: 120, unit: "g" },
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋" },
      { id: "cheese", name: "チーズ", quantity: 30, unit: "g" }
    ],
    pantry: "酒・塩・こしょう",
    optional: [
      { id: "umeboshi", name: "梅干し", quantity: 1, unit: "個", benefit: "酸味で後味が軽くなる" },
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋", benefit: "磯の香りが加わる" }
    ]
  },
  {
    id: "tofu-avocado-bowl",
    name: "豆腐とアボカドののっけ丼",
    minutes: 6,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "tofu", name: "豆腐", quantity: 0.5, unit: "個" },
      { id: "avocado", name: "アボカド", quantity: 1, unit: "個" }
    ],
    pantry: "醤油・わさび・ごま油",
    optional: [
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋", benefit: "磯の香りが加わる" },
      { id: "tuna", name: "ツナ", quantity: 0.5, unit: "缶", benefit: "たんぱく質と満足感が増す" }
    ]
  },
  {
    id: "salmon-flake-ochazuke",
    name: "鮭とのりの即席茶漬け",
    minutes: 5,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "salmon-flake", name: "鮭フレーク", quantity: 0.25, unit: "個" },
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋" }
    ],
    pantry: "だし・醤油・湯",
    optional: [
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "香りと彩りが加わる" },
      { id: "sesame", name: "ごま", quantity: 0.1, unit: "袋", benefit: "香ばしさが加わる" }
    ]
  },
  {
    id: "tomato-shio-kombu-tofu",
    name: "トマト塩昆布の冷ややっこ",
    minutes: 5,
    required: [
      { id: "tofu", name: "豆腐", quantity: 1, unit: "個" },
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" },
      { id: "shio-kombu", name: "塩昆布", quantity: 0.1, unit: "袋" }
    ],
    pantry: "ごま油",
    optional: [
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "清涼感が増す" },
      { id: "sesame", name: "ごま", quantity: 0.1, unit: "袋", benefit: "香ばしさが加わる" }
    ]
  },
  {
    id: "pumpkin-mince-microwave",
    name: "かぼちゃのレンジそぼろ",
    minutes: 12,
    required: [
      { id: "pumpkin", name: "かぼちゃ", quantity: 200, unit: "g" },
      { id: "pork-mince", name: "豚ひき肉", quantity: 80, unit: "g" }
    ],
    pantry: "醤油・砂糖・みりん・片栗粉・水",
    optional: [
      { id: "ginger", name: "しょうが", quantity: 0.25, unit: "個", benefit: "香りが締まる" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "彩りと香りが加わる" }
    ]
  },
  {
    id: "enoki-pork-roll-microwave",
    name: "えのきの豚巻きレンジ蒸し",
    minutes: 12,
    required: [
      { id: "enoki", name: "えのき", quantity: 0.5, unit: "袋" },
      { id: "pork-belly", name: "豚バラ肉", quantity: 120, unit: "g" }
    ],
    pantry: "酒・塩・ポン酢",
    optional: [
      { id: "shiso", name: "大葉", quantity: 0.25, unit: "袋", benefit: "香りが加わる" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "仕上げの彩りになる" }
    ]
  },
  {
    id: "chicken-tomato-microwave",
    name: "鶏ももとトマトのレンジ煮",
    minutes: 15,
    required: [
      { id: "chicken-thigh", name: "鶏もも肉", quantity: 120, unit: "g" },
      { id: "tomato", name: "トマト", quantity: 1, unit: "個" }
    ],
    pantry: "塩・こしょう・オリーブ油",
    optional: [
      { id: "onion", name: "玉ねぎ", quantity: 0.25, unit: "個", benefit: "甘みが加わる" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "まろやかなコクが増す" }
    ]
  },
  {
    id: "tomato-miso-soup",
    name: "トマトとわかめの即席味噌汁",
    minutes: 7,
    required: [
      { id: "tomato", name: "トマト", quantity: 0.5, unit: "個" },
      { id: "wakame", name: "わかめ", quantity: 0.1, unit: "袋" }
    ],
    pantry: "味噌・だし・水",
    optional: [
      { id: "tofu", name: "豆腐", quantity: 0.25, unit: "個", benefit: "食べ応えが増す" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "香りと彩りが加わる" }
    ]
  },
  {
    id: "cabbage-sausage-soup",
    name: "キャベツとソーセージのマグスープ",
    minutes: 8,
    required: [
      { id: "cabbage", name: "キャベツ", quantity: 80, unit: "g" },
      { id: "sausage", name: "ソーセージ", quantity: 0.5, unit: "袋" }
    ],
    pantry: "コンソメ・塩・こしょう・水",
    optional: [
      { id: "corn", name: "とうもろこし", quantity: 0.25, unit: "本", benefit: "甘みと彩りが増す" },
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "コクが増す" }
    ]
  },
  {
    id: "tofu-kimchi-soup",
    name: "豆腐キムチスープ",
    minutes: 8,
    required: [
      { id: "tofu", name: "豆腐", quantity: 0.5, unit: "個" },
      { id: "kimchi", name: "キムチ", quantity: 0.5, unit: "袋" }
    ],
    pantry: "鶏がらスープの素・醤油・水",
    optional: [
      { id: "eggs", name: "卵", quantity: 1, unit: "個", benefit: "辛みがまろやかになる" },
      { id: "green-onion", name: "ねぎ", quantity: 0.25, unit: "本", benefit: "香りと甘みが加わる" }
    ]
  },
  {
    id: "avocado-tuna-toast",
    name: "アボカドツナトースト",
    minutes: 8,
    required: [
      { id: "bread", name: "食パン", quantity: 2, unit: "枚" },
      { id: "avocado", name: "アボカド", quantity: 1, unit: "個" },
      { id: "tuna", name: "ツナ", quantity: 0.5, unit: "缶" }
    ],
    pantry: "マヨネーズ・塩・こしょう",
    optional: [
      { id: "cheese", name: "チーズ", quantity: 20, unit: "g", benefit: "焼いたコクが増す" },
      { id: "lemon", name: "レモン", quantity: 0.25, unit: "個", benefit: "後味が軽くなる" }
    ]
  },
  {
    id: "egg-mayo-rice-bowl",
    name: "レンジ卵マヨ丼",
    minutes: 6,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "eggs", name: "卵", quantity: 2, unit: "個" }
    ],
    pantry: "マヨネーズ・醤油・塩",
    optional: [
      { id: "tuna", name: "ツナ", quantity: 0.5, unit: "缶", benefit: "うま味と満足感が増す" },
      { id: "nori", name: "のり", quantity: 0.1, unit: "袋", benefit: "磯の香りが加わる" }
    ]
  },
  {
    id: "mushroom-butter-rice",
    name: "きのこバター醤油ごはん",
    minutes: 10,
    required: [
      { id: "rice", name: "ごはん", quantity: 1, unit: "膳" },
      { id: "mushroom", name: "しめじ", quantity: 0.5, unit: "株" },
      { id: "butter", name: "バター", quantity: 10, unit: "g" }
    ],
    pantry: "醤油・こしょう",
    optional: [
      { id: "bacon", name: "ベーコン", quantity: 40, unit: "g", benefit: "うま味と満足感が増す" },
      { id: "green-onion-small", name: "小ねぎ", quantity: 0.25, unit: "袋", benefit: "彩りと香りが加わる" }
    ]
  },
  ...EXPANDED_RECIPE_PACK.recipes
];

const RECIPE_STEPS = {
  "microwave-pork-kimchi": [
    "耐熱皿にもやしなどの野菜、食べやすく切った豚肉、キムチの順に重ねる。",
    "醤油と酒を回しかけ、ふんわりラップをして電子レンジで加熱する。",
    "全体を混ぜ、豚肉の中心まで火が通っていなければ追加加熱し、ごま油を回しかける。"
  ],
  "microwave-cabbage-shumai": [
    "豚ひき肉に醤油・ごま油・塩・片栗粉を混ぜ、ひと口大に丸める。",
    "耐熱皿に刻んだキャベツを敷いて肉だねを置き、残りのキャベツをかぶせる。",
    "ふんわりラップをして電子レンジで加熱し、肉の中心まで火が通ったことを確認する。"
  ],
  "microwave-eggplant-pork-ponzu": [
    "なすと豚肉を食べやすく切り、耐熱皿へ交互に並べる。",
    "酒とごま油を回しかけ、ふんわりラップをして電子レンジで加熱する。",
    "豚肉の中心まで火が通ったことを確認し、ポン酢をかける。"
  ],
  "microwave-tofu-egg-soup": [
    "大きめの耐熱容器に豆腐を崩し入れ、水・鶏がらスープの素・醤油を加える。",
    "ふんわりラップをして電子レンジで温め、溶いた卵を細く回し入れる。",
    "卵が固まるまで短時間ずつ追加加熱し、全体を軽く混ぜる。"
  ],
  "microwave-salmon-mushroom": [
    "耐熱皿にほぐしたしめじと鮭を置き、塩と酒を振る。",
    "ふんわりラップをして電子レンジで加熱する。",
    "鮭の中心まで火が通ったことを確認し、醤油をたらす。"
  ],
  "microwave-bean-sprout-pork": [
    "耐熱皿にもやしを広げ、食べやすく切った豚肉を重ならないようにのせる。",
    "酒・塩・こしょうを振り、ふんわりラップをして電子レンジで加熱する。",
    "豚肉の中心まで火が通ったことを確認し、ポン酢を添える。"
  ],
  "microwave-chicken-cabbage": [
    "白菜を細めに切り、そぎ切りにした鶏肉と耐熱皿へ交互に重ねる。",
    "酒・塩・鶏がらスープの素を加え、ふんわりラップをして電子レンジで加熱する。",
    "鶏肉の中心まで火が通ったことを確認し、足りなければ追加加熱する。"
  ],
  "microwave-tomato-cheese-rice": [
    "耐熱容器へごはんを広げ、角切りのトマトをのせて塩・こしょうを振る。",
    "チーズをのせ、ふんわりラップをして電子レンジで温める。",
    "チーズが溶けたらオリーブ油を回しかけ、全体を混ぜる。"
  ],
  "microwave-sweet-potato-butter": [
    "さつまいもをよく洗って小さめの乱切りにし、水にさっとさらす。",
    "水気を残したまま耐熱容器へ入れ、ふんわりラップをして電子レンジで加熱する。",
    "竹串がすっと通ったら塩を振り、好みでバターをからめる。"
  ],
  "microwave-potato-tuna-salad": [
    "じゃがいもを小さく切って耐熱容器へ入れ、ふんわりラップをして電子レンジで加熱する。",
    "やわらかくなったら熱いうちに粗くつぶし、汁気を切ったツナを加える。",
    "粗熱が取れてからマヨネーズ・塩・こしょうで和える。"
  ],
  "whitebait-green-onion-bowl": [
    "温かいごはんを器によそう。",
    "しらすと小ねぎなどの薬味をのせる。",
    "醤油とごま油を少量ずつ回しかける。"
  ],
  "tuna-cucumber-tofu": [
    "きゅうりを細切りにし、ツナの汁気を切る。",
    "醤油・酢・ごま油を混ぜ、きゅうりとツナを和える。",
    "水気を切った豆腐にのせる。"
  ],
  "canned-mackerel-tomato": [
    "フライパンへトマト缶とサバ缶を汁ごと入れ、サバを大きくほぐす。",
    "中火で混ぜながら、汁気が少し減るまで煮る。",
    "塩・こしょうで味を整え、オリーブ油を回しかける。"
  ],
  "kimchi-cheese-udon": [
    "耐熱容器へうどん、キムチ、めんつゆと少量の水を入れる。",
    "ふんわりラップをして電子レンジで温め、一度よく混ぜる。",
    "チーズをのせて再び短く加熱し、溶けたら完成。"
  ],
  "natto-kimchi-bowl": [
    "納豆を付属のたれまたは少量の醤油と混ぜる。",
    "温かいごはんへ納豆とキムチをのせる。",
    "ごま油を少量回しかけ、好みで卵やのりを添える。"
  ],
  "canned-sardine-cabbage-pasta": [
    "スパゲッティを表示時間に合わせてゆで、途中で食べやすく切ったキャベツも加える。",
    "湯を切って鍋へ戻し、いわし缶を汁ごと加えて大きくほぐす。",
    "醤油・油・こしょうを加え、全体を手早く混ぜる。"
  ],
  "bacon-spinach-egg": [
    "ベーコンとほうれん草を食べやすく切り、卵を溶く。",
    "フライパンでベーコンとほうれん草を炒め、塩・こしょうを振る。",
    "溶き卵を加え、好みの固さになるまで大きく混ぜる。"
  ],
  "chicken-tender-shiso-cheese": [
    "ささみを開いて筋を除き、塩・こしょうを振って大葉とチーズをのせる。",
    "半分に折って耐熱皿へ置き、酒を振ってふんわりラップをし、電子レンジで加熱する。",
    "ささみの中心まで火が通ったことを確認し、足りなければ追加加熱する。"
  ],
  "tofu-avocado-bowl": [
    "豆腐の水気を切り、アボカドとともに食べやすく切る。",
    "温かいごはんへ豆腐とアボカドをのせる。",
    "醤油・わさび・ごま油を混ぜて回しかける。"
  ],
  "salmon-flake-ochazuke": [
    "温かいごはんを器へ盛り、鮭フレークとのりをのせる。",
    "だしと醤油を合わせ、熱い湯を注ぐ。",
    "好みで小ねぎやごまを散らす。"
  ],
  "tomato-shio-kombu-tofu": [
    "トマトを小さめの角切りにし、塩昆布とごま油で和える。",
    "豆腐の水気を切って器へ盛る。",
    "トマトと塩昆布を汁ごとのせる。"
  ],
  "pumpkin-mince-microwave": [
    "かぼちゃを小さめに切り、豚ひき肉とともに耐熱容器へ入れる。",
    "醤油・砂糖・みりん・水を混ぜて回しかけ、ふんわりラップをして電子レンジで加熱する。",
    "ひき肉の中心まで火が通ったことを確認し、水溶き片栗粉を混ぜて短く追加加熱する。"
  ],
  "enoki-pork-roll-microwave": [
    "石づきを落としたえのきを小分けにし、豚肉で巻く。",
    "巻き終わりを下にして耐熱皿へ並べ、酒と塩を振ってふんわりラップをし、電子レンジで加熱する。",
    "豚肉の中心まで火が通ったことを確認し、ポン酢をかける。"
  ],
  "chicken-tomato-microwave": [
    "鶏肉とトマトをひと口大に切り、耐熱容器へ入れる。",
    "塩・こしょう・オリーブ油を加えて混ぜ、ふんわりラップをして電子レンジで加熱する。",
    "鶏肉の中心まで火が通ったことを確認し、足りなければ追加加熱する。"
  ],
  "tomato-miso-soup": [
    "耐熱容器へ食べやすく切ったトマト、わかめ、水、だしを入れる。",
    "ふんわりラップをして電子レンジで温める。",
    "味噌を溶き入れ、必要なら短く温め直す。"
  ],
  "cabbage-sausage-soup": [
    "大きめの耐熱マグへ刻んだキャベツ、切ったソーセージ、水、コンソメを入れる。",
    "ふんわりラップをして電子レンジで、キャベツがやわらかくなるまで加熱する。",
    "よく混ぜ、塩・こしょうで味を整える。"
  ],
  "tofu-kimchi-soup": [
    "耐熱容器へ豆腐を大きく崩し入れ、キムチ、水、鶏がらスープの素を加える。",
    "ふんわりラップをして電子レンジでしっかり温める。",
    "醤油で味を整え、好みで小ねぎを散らす。"
  ],
  "avocado-tuna-toast": [
    "アボカドを粗くつぶし、汁気を切ったツナ、マヨネーズ、塩・こしょうと混ぜる。",
    "食パンへ均等に広げる。",
    "トースターでパンの縁が色づくまで焼く。"
  ],
  "egg-mayo-rice-bowl": [
    "耐熱容器へ卵を割り入れてよく溶き、塩とマヨネーズを混ぜる。",
    "ラップをせず電子レンジで短時間ずつ加熱し、そのたびに混ぜて好みの固さにする。",
    "温かいごはんへのせ、醤油を少量かける。"
  ],
  "mushroom-butter-rice": [
    "しめじをほぐし、耐熱容器へ入れてふんわりラップをし、電子レンジで加熱する。",
    "熱いうちにバターと醤油を混ぜる。",
    "温かいごはんへ加えて混ぜ、こしょうを振る。"
  ],
  "cheese-toast": [
    "食パンにチーズをのせ、はみ出さないよう軽く広げる。",
    "トースターか魚焼きグリルで、チーズが溶けて色づくまで焼く。",
    "こしょうを振り、食べやすく切って完成。"
  ],
  "pizza-toast": [
    "食パンにケチャップを薄く塗り、薄切りにしたトマトを並べる。",
    "チーズをのせ、塩・こしょうを軽く振る。",
    "トースターでチーズが溶けるまで焼いて完成。"
  ],
  "tuna-toast": [
    "ツナの汁気を切り、マヨネーズとこしょうで和える。",
    "食パンに広げてのせる。",
    "トースターで表面が色づくまで焼いて完成。"
  ],
  "french-toast": [
    "卵を溶き、砂糖を加えて混ぜる（牛乳があれば一緒に混ぜる）。",
    "食パンの両面へしっかり浸す。",
    "油をひいたフライパンで両面をこんがり焼いて完成。"
  ],
  "egg-sandwich": [
    "卵を固ゆでにして殻をむき、フォークで粗くつぶす。",
    "マヨネーズ・塩・こしょうで和える。",
    "食パンにはさみ、半分に切って完成。"
  ],
  "miso-stir-fry": [
    "キャベツを食べやすく切り、豚こまと一緒に油で炒める。",
    "肉の色が変わったら、味噌・醤油・砂糖を加える。",
    "全体を混ぜながら水分を飛ばし、肉に十分火が通ったら完成。"
  ],
  "egg-bowl": [
    "フライパンに少量の水と醤油・砂糖を入れ、使う野菜をさっと煮る。",
    "溶いた卵を回し入れ、好みの固さになるまでふたをする。",
    "温かいごはんにのせて完成。"
  ],
  "cabbage-pancake": [
    "刻んだキャベツ、卵、小麦粉、少量の水を混ぜる。",
    "油をひいたフライパンへ広げ、両面をじっくり焼く。",
    "中まで火が通ったら、醤油など好みの味を添える。"
  ],
  "mushroom-soup": [
    "鍋に水としめじを入れて火にかけ、醤油と塩で味を整える。",
    "水溶き片栗粉を加え、軽くとろみをつける。",
    "溶いた卵を細く流し、卵に火が通ったら完成。"
  ],
  "home-curry": [
    "肉と使う野菜を食べやすく切り、鍋で炒める。",
    "水を加え、具材がやわらかくなるまで煮る。",
    "火を止めてカレールウを溶かし、再び少し煮てごはんにかける。"
  ],
  nikujaga: [
    "肉とじゃがいも、玉ねぎを食べやすく切って炒める。",
    "水・醤油・砂糖・みりんを加え、落としぶたをして煮る。",
    "じゃがいもがやわらかくなり、煮汁が少なくなったら完成。"
  ],
  "hamburger-steak": [
    "ひき肉、みじん切りの玉ねぎ、卵、塩・こしょうを混ぜて形を作る。",
    "フライパンで両面に焼き色をつけ、ふたをして中まで火を通す。",
    "中央まで火が通ったことを確認し、好みのソースを添える。"
  ],
  "salmon-meuniere": [
    "鮭の水分を拭き、塩・こしょうと薄力粉を薄くまぶす。",
    "油をひいたフライパンで両面を焼き、中まで火を通す。",
    "最後にバターを加え、鮭へからめて完成。"
  ],
  napolitan: [
    "スパゲッティを表示時間どおりにゆでる。",
    "フライパンで玉ねぎなどの具材を炒め、ケチャップを加える。",
    "ゆでた麺を加えて全体を混ぜ、塩・こしょうで整える。"
  ],
  "tofu-miso-soup": [
    "鍋に水とだしを入れ、豆腐と使う具材を温める。",
    "沸騰させすぎないよう火を弱め、味噌を溶き入れる。",
    "ひと煮立ちする前に火を止め、ねぎなどを添える。"
  ],
  "chicken-cabbage-steam": [
    "鶏むね肉を薄めのひと口大に切り、塩・こしょうをふる。",
    "フライパンにキャベツと鶏肉を重ね、酒を加えてふたをする。",
    "弱めの中火で蒸し、鶏肉の中心まで十分に火が通ったら完成。"
  ],
  "tomato-egg-stir-fry": [
    "トマトを大きめに切り、卵を溶いて塩を少し混ぜる。",
    "油を熱したフライパンで卵を半熟に炒め、いったん取り出す。",
    "トマトをさっと炒めて卵を戻し、こしょうで整える。"
  ],
  "mapo-tofu-style": [
    "フライパンでひき肉を炒め、味噌・醤油・砂糖を加える。",
    "食べやすく切った豆腐と水を加え、崩しすぎないよう温める。",
    "水溶き片栗粉でとろみをつけ、ひき肉に十分火が通ったら完成。"
  ],
  "natto-rice": [
    "納豆に付属のたれ、または少量の醤油を混ぜる。",
    "温かいごはんに納豆をのせる。",
    "使う場合は卵やねぎ、かつお節を添えて完成。"
  ],
  "eggplant-mince-stir-fry": [
    "なすを食べやすく切り、油をひいたフライパンで炒める。",
    "ひき肉を加え、色が変わるまでほぐしながら炒める。",
    "醤油・砂糖・みりんをからめ、ひき肉に十分火が通ったら完成。"
  ],
  "chicken-broccoli-pan": [
    "鶏むね肉をひと口大に切り、塩・こしょうをふる。",
    "鶏肉を焼き、色が変わったら小さく分けたブロッコリーと酒を加える。",
    "ふたをして蒸し焼きにし、鶏肉の中心まで十分に火を通す。"
  ],
  oyakodon: [
    "鶏肉を小さめに切り、醤油・砂糖・みりん・水で煮る。",
    "鶏肉の中心まで火が通ったら、溶いた卵を回し入れてふたをする。",
    "卵が好みの固さになったら、温かいごはんにのせる。"
  ],
  gyudon: [
    "鍋に醤油・砂糖・みりん・水を入れ、使う場合は玉ねぎを煮る。",
    "牛肉を広げて加え、色が変わるまで煮てアクを取る。",
    "牛肉に十分火が通ったら、煮汁ごと温かいごはんにのせる。"
  ],
  "fried-rice": [
    "卵を溶き、温かいごはんと使う具材を用意する。",
    "油を熱したフライパンで卵、ごはん、具材の順に手早く炒める。",
    "塩・こしょうと鍋肌からの醤油で味を整える。"
  ],
  omurice: [
    "ごはんと使う具材を炒め、ケチャップ・塩・こしょうで味をつける。",
    "別のフライパンで溶き卵を広げ、半熟になるまで焼く。",
    "ケチャップごはんを包むか、上から卵をのせて完成。"
  ],
  "soboro-bowl": [
    "フライパンにひき肉、醤油・砂糖・みりんを入れてほぐす。",
    "混ぜながら火にかけ、汁気が少なくなるまで炒り煮にする。",
    "ひき肉に十分火が通ったら、温かいごはんにのせる。"
  ],
  "ginger-pork": [
    "しょうがをすりおろし、醤油・みりん・砂糖と混ぜる。",
    "油を熱したフライパンで豚肉を広げて炒める。",
    "豚肉に十分火が通ったら合わせ調味料を加え、照りが出るまでからめる。"
  ],
  "chicken-teriyaki": [
    "鶏肉を食べやすく切り、油をひいたフライパンで両面を焼く。",
    "ふたをして蒸し焼きにし、鶏肉の中心まで十分に火を通す。",
    "醤油・みりん・砂糖を加え、照りが出るまでからめる。"
  ],
  "chicken-karaage": [
    "鶏肉をひと口大に切り、醤油と酒で下味をつける。",
    "小麦粉または片栗粉をまぶし、熱した油で揚げる。",
    "中心まで十分に火が通り、表面が香ばしくなったら油を切る。"
  ],
  "beef-pepper-stir-fry": [
    "牛肉とピーマンを食べやすく切る。",
    "油を熱したフライパンで牛肉を炒め、色が変わったらピーマンを加える。",
    "牛肉に十分火が通ったら醤油・砂糖・酒を加え、手早くからめる。"
  ],
  "meat-tofu": [
    "豆腐を大きめに切り、鍋に醤油・砂糖・みりん・水を入れる。",
    "牛肉と使う野菜を煮て、色が変わったら豆腐を加える。",
    "牛肉に十分火が通り、豆腐が温まるまで煮る。"
  ],
  "pork-cabbage-millefeuille": [
    "キャベツと豚肉を交互に重ね、食べやすい大きさに切る。",
    "フライパンや鍋に詰め、酒・塩・少量の水を加えてふたをする。",
    "弱めの中火で蒸し、豚肉に十分火が通ったら完成。"
  ],
  "salmon-foil-yaki": [
    "アルミホイルに鮭としめじをのせ、塩・こしょうをふる。",
    "ホイルを閉じ、フライパンに少量の水を入れてふたをする。",
    "蒸し焼きにして鮭の中心まで十分に火を通す。"
  ],
  "salmon-teriyaki": [
    "鮭の水分を拭き、油をひいたフライパンで両面を焼く。",
    "ふたをして鮭の中心まで十分に火を通す。",
    "醤油・みりん・砂糖を加え、煮詰めながら鮭へからめる。"
  ],
  "dashimaki-egg": [
    "卵を溶き、だし・醤油・砂糖を混ぜる。",
    "油を薄くひいたフライパンへ卵液を数回に分けて流す。",
    "半熟のうちに巻く作業を繰り返し、形を整える。"
  ],
  "agedashi-tofu": [
    "豆腐の水分を拭き、食べやすく切って片栗粉をまぶす。",
    "多めの油で全面を焼き、表面を香ばしくする。",
    "温めただし・醤油・みりんのつゆをかける。"
  ],
  "tofu-steak": [
    "豆腐の水分を切り、食べやすく切って小麦粉を薄くまぶす。",
    "油を熱したフライパンで両面を香ばしく焼く。",
    "醤油を回しかけ、使う薬味やきのこを添える。"
  ],
  "cheese-omelet": [
    "卵を溶き、塩・こしょうとチーズを混ぜる。",
    "油を熱したフライパンへ流し、外側から大きく混ぜる。",
    "半熟になったら形を整え、好みの固さまで火を通す。"
  ],
  "potato-salad": [
    "じゃがいもと卵をそれぞれ加熱し、じゃがいもを粗くつぶす。",
    "卵と使う野菜を加え、マヨネーズ・塩・こしょうで和える。",
    "味を整え、粗熱を取って完成。"
  ],
  "spinach-sesame": [
    "ほうれん草をゆでて冷水に取り、水気をしっかり絞る。",
    "食べやすく切り、すりごま・醤油・砂糖を混ぜる。",
    "ほうれん草と合わせ調味料を和える。"
  ],
  "eggplant-miso": [
    "なすを食べやすく切り、油をひいたフライパンで炒める。",
    "なすがやわらかくなったら、味噌・砂糖・醤油を加える。",
    "水分を飛ばしながら全体へ味をからめる。"
  ],
  "cucumber-wakame-vinegar": [
    "きゅうりを薄く切って塩をふり、水気を絞る。",
    "わかめを水で戻し、食べやすく切る。",
    "酢・砂糖・醤油を混ぜ、きゅうりとわかめを和える。"
  ],
  coleslaw: [
    "キャベツと使う野菜を細く切り、塩をふる。",
    "しんなりしたら水気をしっかり絞る。",
    "マヨネーズ・酢・砂糖で和え、味を整える。"
  ],
  "carbonara-style": [
    "スパゲッティをゆで、卵・チーズ・黒こしょうを混ぜておく。",
    "湯を切った熱い麺をボウルへ入れ、卵液と手早く混ぜる。",
    "固い場合はゆで汁を少量加え、塩と黒こしょうで整える。"
  ],
  "mushroom-butter-pasta": [
    "スパゲッティをゆで、その間にしめじをバターで炒める。",
    "ゆでた麺と少量のゆで汁をフライパンへ加える。",
    "醤油を回しかけ、全体を混ぜて塩で整える。"
  ],
  "pork-miso-soup": [
    "豚肉と大根、にんじんを食べやすく切り、鍋で軽く炒める。",
    "水とだしを加え、野菜がやわらかくなるまで煮る。",
    "豚肉に十分火が通ったら火を弱め、味噌を溶き入れる。"
  ],
  "vegetable-consomme": [
    "キャベツ、にんじん、玉ねぎを食べやすく切る。",
    "鍋に水・コンソメと野菜を入れ、やわらかくなるまで煮る。",
    "塩・こしょうで味を整える。"
  ],
  "kake-udon": [
    "鍋にだし・醤油・みりん・水を入れて温める。",
    "うどんを加え、袋の表示に合わせてゆでる。",
    "器に盛り、使う場合はねぎや卵、わかめを添える。"
  ],
  "curry-udon": [
    "鍋で使う肉や野菜を炒め、だしと水を加えて煮る。",
    "具材に火が通ったらカレールウと醤油を溶かし、うどんを加える。",
    "うどんが温まり、つゆがなじんだら完成。"
  ],
  "kake-soba": [
    "そばを袋の表示に合わせてゆで、湯を切る。",
    "別の鍋でだし・醤油・みりん・水を温める。",
    "そばを器に入れてつゆを注ぎ、好みの具を添える。"
  ],
  "sauce-yakisoba": [
    "豚肉とキャベツ、使う野菜を食べやすく切って炒める。",
    "豚肉に十分火が通ったら焼きそば麺と少量の水を加えてほぐす。",
    "ソースを加え、水分を飛ばしながら全体を炒め合わせる。"
  ],
  "macaroni-gratin": [
    "マカロニをゆで、使う具材をフライパンで炒める。",
    "小麦粉、バター、牛乳を加えて混ぜ、とろみが出るまで温める。",
    "耐熱皿へ移してチーズをのせ、表面に焼き色がつくまで焼く。"
  ],
  "mackerel-miso": [
    "さばの水分を拭き、皮に浅く切り目を入れる。",
    "鍋に味噌以外の調味料と水を煮立て、さばを入れて落としぶたをする。",
    "さばの中心まで火が通ったら味噌を溶き、煮汁をからめる。"
  ],
  "mackerel-salt-grill": [
    "さばの水分を拭き、両面に塩をふる。",
    "グリルまたは油を薄くひいたフライパンで皮側から焼く。",
    "裏返して中心まで十分に火を通す。"
  ],
  "yellowtail-teriyaki": [
    "ぶりの水分を拭き、油をひいたフライパンで両面を焼く。",
    "ふたをして、ぶりの中心まで十分に火を通す。",
    "醤油・みりん・砂糖を加え、照りが出るまでからめる。"
  ],
  "yellowtail-daikon": [
    "大根を厚めに切り、やわらかくなるまで下ゆでする。",
    "鍋に調味料と水を煮立て、ぶりと大根を加えて落としぶたをする。",
    "ぶりの中心まで火を通し、煮汁が少なくなるまで煮る。"
  ],
  "shrimp-chili": [
    "えびの水分を拭き、片栗粉を薄くまぶして油で炒める。",
    "えびの色が変わったら、ケチャップ・砂糖・酢・醤油を加える。",
    "えびの中心まで火を通し、ソースにとろみが出るまでからめる。"
  ],
  "shrimp-fried-rice": [
    "えびの水分を拭き、卵を溶いて温かいごはんを用意する。",
    "油を熱したフライパンでえび、卵、ごはんの順に炒める。",
    "えびに十分火を通し、塩・こしょうと醤油で味を整える。"
  ],
  "tuna-mayo-rice": [
    "ツナの油または水気を軽く切る。",
    "ツナとマヨネーズ、少量の醤油を混ぜる。",
    "温かいごはんにのせ、使う場合はきゅうりやねぎを添える。"
  ],
  "bean-sprout-namul": [
    "もやしをゆでるか電子レンジで加熱し、水気を切る。",
    "ごま油・醤油・塩・ごまを混ぜる。",
    "温かいうちにもやしを和え、味をなじませる。"
  ],
  "nira-tama": [
    "にらを食べやすく切り、卵を溶いて塩を少し混ぜる。",
    "油を熱したフライパンで卵を半熟に炒め、いったん取り出す。",
    "にらを炒めて卵を戻し、醤油・こしょうで整える。"
  ],
  "pumpkin-simmer": [
    "かぼちゃを食べやすく切り、皮を下にして鍋へ並べる。",
    "醤油・砂糖・みりん・水を加え、落としぶたをして煮る。",
    "竹串が通るまでやわらかくなったら火を止める。"
  ],
  "pumpkin-salad": [
    "かぼちゃをやわらかくなるまで加熱し、粗くつぶす。",
    "粗熱が取れたらマヨネーズ・塩・こしょうを混ぜる。",
    "使う場合はヨーグルトやチーズ、卵を加えて整える。"
  ],
  "konnyaku-piquant": [
    "こんにゃくを食べやすくちぎり、さっと下ゆでする。",
    "水気を切ってフライパンで乾煎りし、ごま油を加える。",
    "醤油・みりん・砂糖を加え、水分がなくなるまで炒める。"
  ],
  "cream-stew": [
    "鶏肉と野菜を食べやすく切り、鍋で炒める。",
    "水とコンソメを加え、鶏肉の中心と野菜に火が通るまで煮る。",
    "小麦粉・バター・牛乳を加えて混ぜ、とろみが出るまで温める。"
  ],
  gyoza: [
    "ひき肉、刻んだキャベツとにら、調味料を粘りが出るまで混ぜる。",
    "餃子の皮で餡を包み、油をひいたフライパンへ並べる。",
    "焼き色がついたら水を加えて蒸し焼きにし、餡の中心まで火を通す。"
  ],
  croquette: [
    "じゃがいもをやわらかくしてつぶし、炒めたひき肉と混ぜて形を作る。",
    "小麦粉、卵、パン粉の順に衣をつける。",
    "熱した油で表面がきつね色になるまで揚げる。"
  ],
  "rolled-cabbage": [
    "キャベツをやわらかくし、ひき肉とみじん切りの玉ねぎを包む。",
    "鍋へ並べ、コンソメと水を加えてふたをする。",
    "弱めの火で煮込み、肉の中心まで十分に火を通す。"
  ],
  "menchi-katsu": [
    "ひき肉、みじん切りの玉ねぎ、塩・こしょうを混ぜて形を作る。",
    "小麦粉、溶き卵、パン粉の順に衣をつける。",
    "熱した油で揚げ、中心まで十分に火を通す。"
  ],
  "yaki-udon": [
    "豚肉とキャベツを食べやすく切り、油で炒める。",
    "豚肉に火が通ったら、うどんと少量の水を加えてほぐす。",
    "醤油とソースを加え、水分を飛ばしながら炒め合わせる。"
  ],
  "tuna-tomato-pasta": [
    "スパゲッティを表示時間どおりにゆでる。",
    "フライパンでトマトとツナを炒め、塩・こしょうで整える。",
    "ゆでた麺を加え、ソースを全体へからめる。"
  ],
  "chicken-cream-pasta": [
    "鶏肉を小さく切り、しめじと一緒にバターで炒める。",
    "鶏肉に火が通ったら小麦粉と牛乳を加え、とろみをつける。",
    "ゆでたスパゲッティを加え、塩・こしょうで整える。"
  ],
  "tofu-champuru": [
    "豆腐の水気を切り、大きめに崩して表面を焼く。",
    "使う肉や野菜を加え、火が通るまで炒める。",
    "溶き卵と醤油を加え、全体を大きく混ぜて仕上げる。"
  ],
  "salmon-fried-rice": [
    "鮭を焼いて骨と皮を除き、身を粗くほぐす。",
    "油を熱したフライパンで卵、ごはん、鮭の順に炒める。",
    "塩・こしょうと醤油で味を整える。"
  ],
  "cabbage-tuna-simmer": [
    "キャベツを食べやすく切り、ツナと一緒に鍋へ入れる。",
    "醤油・みりん・少量の水を加えてふたをする。",
    "キャベツがしんなりするまで短く煮る。"
  ],
  "potato-cheese-bake": [
    "じゃがいもを薄く切り、やわらかくなるまで加熱する。",
    "耐熱皿へ並べ、塩・こしょうとチーズをのせる。",
    "トースターなどで、チーズに焼き色がつくまで焼く。"
  ],
  "tomato-cheese-bake": [
    "トマトを厚めに切り、耐熱皿へ並べる。",
    "塩・こしょうをふり、チーズを全体へ散らす。",
    "トースターなどで、チーズに焼き色がつくまで焼く。"
  ],
  "mackerel-ginger-stew": [
    "さばの水分を拭き、皮に浅く切り目を入れる。",
    "鍋に醤油・砂糖・みりん・酒・水を煮立て、さばとしょうがを入れる。",
    "落としぶたをして、中心まで火を通しながら煮汁をからめる。"
  ],
  "yellowtail-salt-grill": [
    "ぶりの水分を拭き、両面に塩をふって少し置く。",
    "出た水分を拭き、グリルまたは油を薄くひいたフライパンで焼く。",
    "裏返して、中心まで十分に火を通す。"
  ],
  "shrimp-garlic-saute": [
    "えびの水分を拭き、塩・こしょうをふる。",
    "油とにんにくを弱火で温め、香りが出たらえびを加える。",
    "えびの中心まで火を通し、好みでバターをからめる。"
  ],
  "natto-omelet": [
    "納豆を混ぜ、溶いた卵と少量の醤油を合わせる。",
    "油を熱したフライパンへ流し、周囲が固まったら大きく混ぜる。",
    "納豆を包むように形を整え、卵に火を通す。"
  ],
  "natto-pasta": [
    "スパゲッティを表示時間どおりにゆでる。",
    "納豆に醤油と少量の油を混ぜ、使う薬味を用意する。",
    "湯を切った麺と納豆を和え、ねぎやのりを添える。"
  ],
  "zaru-soba": [
    "そばを袋の表示に合わせてゆでる。",
    "冷水でよく洗ってぬめりを取り、水気を切る。",
    "器に盛り、冷やしたつゆと薬味を添える。"
  ],
  "pork-cold-soba": [
    "そばをゆでて冷水で洗い、水気を切る。",
    "豚肉を熱湯で中心までゆで、冷まして大根をおろす。",
    "そばに豚肉と大根おろしをのせ、冷たいつゆをかける。"
  ],
  "salt-yakisoba": [
    "キャベツと使う具材を食べやすく切って炒める。",
    "焼きそば麺と少量の水を加え、ほぐしながら火を通す。",
    "塩・こしょうと鶏がらスープの素で味を整える。"
  ],
  sobameshi: [
    "焼きそば麺を短く刻み、使う具材を炒める。",
    "麺とごはんを加え、ほぐしながら炒め合わせる。",
    "ソースを加え、水分を飛ばして香ばしく仕上げる。"
  ],
  "chilled-somen": [
    "そうめんを袋の表示に合わせてゆでる。",
    "冷水でよく洗い、氷水で冷やして水気を切る。",
    "器に盛り、冷やしたつゆと好みの薬味を添える。"
  ],
  "tuna-tomato-somen": [
    "そうめんをゆでて冷水で洗い、水気を切る。",
    "トマトを切り、汁気を切ったツナとめんつゆを混ぜる。",
    "そうめんと具を和え、好みで大葉やごまを添える。"
  ],
  "pork-chinese-cabbage-hotpot": [
    "白菜と豚肉を食べやすい大きさに切り、交互に鍋へ詰める。",
    "だし・醤油・酒・水を加え、ふたをして煮る。",
    "白菜がやわらかくなり、豚肉の中心まで火が通ったら完成。"
  ],
  "tofu-mushroom-hotpot": [
    "豆腐ときのこ、使う野菜を食べやすく切る。",
    "鍋にだし・醤油・みりん・水を入れ、具材を加えて煮る。",
    "全体が温まり、肉を使う場合は中心まで火を通す。"
  ],
  ...EXPANDED_RECIPE_PACK.steps
};

// Prototype estimates per common household unit. These values are deliberately
// rounded and are shown as a guide, not as medical or package-label data.
const NUTRITION_REFERENCES = {
  avocado: { 個: [1, 246, 3.5, 24.7, 8.7] },
  basil: { 袋: [1, 5, 0.4, 0.1, 0.8] },
  "boiled-bamboo": { 袋: [1, 30, 3.5, 0.2, 5.5] },
  "bok-choy": { 袋: [1, 18, 1.2, 0.2, 3.2] },
  burdock: { 本: [1, 130, 3.5, 0.2, 30.8] },
  "cherry-tomato": { パック: [1, 58, 2, 0.2, 14.2] },
  chikuwa: { 袋: [1, 240, 20.4, 4, 27.6] },
  "chinese-cabbage": { g: [100, 14, 0.8, 0.1, 3.2] },
  clam: { 袋: [1, 60, 12, 0.6, 1.2] },
  cod: { 切れ: [1, 62, 14.2, 0.1, 0.1] },
  "cod-roe": { パック: [1, 168, 28, 5.5, 0.5] },
  "cauliflower": { 個: [1, 108, 9, 0.4, 20.4] },
  celery: { 本: [1, 12, 0.4, 0.1, 3.1] },
  corn: { 本: [1, 165, 6.1, 2.7, 33.2] },
  "fresh-cream": { 本: [1, 1300, 4, 135, 12] },
  "freshwater-clam": { 袋: [1, 54, 7.5, 1.4, 4.3] },
  "fried-tofu": { 袋: [1, 190, 12.9, 16.4, 0.6] },
  "green-beans": { 袋: [1, 46, 3.6, 0.2, 10.2] },
  "green-onion-small": { 袋: [1, 28, 1.7, 0.2, 7] },
  hanpen: { 枚: [1, 94, 9.9, 1.0, 11.4] },
  "horse-mackerel": { 本: [1, 76, 12.4, 2.7, 0.1] },
  kamaboko: { 本: [1, 285, 36, 2.7, 28.5] },
  kanikama: { 袋: [1, 90, 12, 0.5, 9.2] },
  komatsuna: { 袋: [1, 28, 3, 0.4, 4.8] },
  "koya-tofu": { 袋: [1, 250, 25, 15.4, 2.2] },
  "lotus-root": { 本: [1, 132, 3.8, 0.2, 30.6] },
  mizuna: { 袋: [1, 46, 4, 0.2, 9.2] },
  octopus: { g: [100, 76, 16.4, 0.7, 0.1] },
  okra: { 袋: [1, 30, 2.1, 0.2, 6.6] },
  oyster: { パック: [1, 116, 13.8, 3.2, 9.4] },
  paprika: { 個: [1, 45, 1.4, 0.3, 10.7] },
  parsley: { 袋: [1, 22, 2.2, 0.2, 3.6] },
  "pea-sprouts": { パック: [1, 27, 3.8, 0.4, 3.2] },
  "salmon-flake": { 個: [1, 290, 33, 16, 2.5] },
  sardine: { 本: [1, 90, 12.2, 4.2, 0.2] },
  satsumaage: { 袋: [1, 420, 30, 22.5, 27] },
  saury: { 本: [1, 310, 18.5, 25.6, 0.1] },
  scallop: { パック: [1, 118, 22.3, 0.4, 4.7] },
  shiso: { 袋: [1, 5, 0.4, 0.0, 0.8] },
  shungiku: { 袋: [1, 44, 4.6, 0.6, 6.2] },
  "soy-milk": { 本: [1, 460, 36, 20, 31] },
  squid: { 本: [1, 176, 36, 1.6, 0.4] },
  "sweet-potato": { 本: [1, 268, 2.2, 0.4, 63.6] },
  taro: { 袋: [1, 174, 4.2, 0.3, 39] },
  "thick-fried-tofu": { 個: [1, 300, 21.4, 22.8, 2.4] },
  "tuna-sashimi": { パック: [1, 250, 52, 3.2, 0.4] },
  turnip: { 個: [1, 20, 0.7, 0.1, 4.6] },
  whitebait: { パック: [1, 76, 15, 1.4, 0.2] },
  yam: { 本: [1, 260, 8.8, 0.6, 58.6] },
  zucchini: { 本: [1, 28, 2.6, 0.2, 4.6] },
  "bitter-melon": { 本: [1, 34, 2, 0.2, 8.4] },
  apple: { 個: [1, 138, 0.5, 0.8, 38] },
  blueberry: { パック: [1, 60, 0.7, 0.1, 15] },
  "boiled-soybeans": { 袋: [1, 180, 15, 9, 11] },
  "broad-beans": { 袋: [1, 108, 10.9, 0.2, 15.5] },
  "canned-corn": { 缶: [1, 138, 3.2, 1.3, 29] },
  "canned-mackerel": { 缶: [1, 340, 31, 22, 0.5] },
  "canned-sardine": { 缶: [1, 360, 32, 25, 0.6] },
  "canned-tomato": { 缶: [1, 80, 3.2, 0.4, 17] },
  "chinese-noodles": { 袋: [1, 300, 9.4, 1.6, 62] },
  "dried-radish": { 袋: [1, 168, 3.5, 0.4, 35] },
  "dried-sardine": { 袋: [1, 110, 32, 1.2, 0.1] },
  "dried-shiitake": { 袋: [1, 90, 6.7, 1.1, 18] },
  edamame: { 袋: [1, 190, 23, 12, 15] },
  enoki: { 袋: [1, 37, 3, 0.2, 7.6] },
  eringi: { パック: [1, 31, 3, 0.5, 6.1] },
  flour: { g: [100, 368, 8.3, 1.5, 75.8] },
  "french-bread": { 本: [1, 840, 26, 3.6, 175] },
  fu: { 袋: [1, 190, 10, 1.5, 32] },
  "glass-noodles": { 袋: [1, 345, 0.2, 0.2, 86] },
  grape: { 袋: [1, 120, 0.6, 0.2, 30] },
  "gyoza-wrapper": { 袋: [1, 290, 9, 1.4, 58] },
  hijiki: { 袋: [1, 50, 4.5, 1, 29] },
  kimchi: { 袋: [1, 60, 3, 0.6, 10] },
  kiwi: { 個: [1, 45, 0.9, 0.2, 11] },
  kombu: { 袋: [1, 140, 7, 1.2, 30] },
  lemon: { 個: [1, 32, 0.7, 0.5, 10] },
  maitake: { パック: [1, 22, 2, 0.5, 4.4] },
  mandarin: { 個: [1, 40, 0.5, 0.1, 10.4] },
  melon: { 個: [1, 340, 4, 0.6, 80] },
  "mixed-vegetables": { 袋: [1, 220, 7, 1.5, 44] },
  mochi: { 袋: [1, 700, 8, 1.2, 150] },
  "mushroom-button": { パック: [1, 11, 2.9, 0.3, 2.1] },
  nameko: { 袋: [1, 15, 1.8, 0.2, 5.4] },
  nori: { 袋: [1, 60, 10, 1, 8] },
  orange: { 個: [1, 60, 1.5, 0.2, 15] },
  peach: { 個: [1, 68, 0.9, 0.2, 17] },
  pear: { 個: [1, 110, 0.8, 0.3, 29] },
  pineapple: { 個: [1, 340, 2.6, 0.4, 85] },
  "potato-starch": { g: [100, 330, 0.1, 0.1, 81.6] },
  "pork-mince": { g: [100, 221, 17.7, 17.2, 0.3] },
  sesame: { 袋: [1, 200, 6.5, 17, 6] },
  shiitake: { パック: [1, 25, 3, 0.4, 5.4] },
  "shio-kombu": { 袋: [1, 55, 7, 0.2, 12] },
  shirataki: { 袋: [1, 12, 0.2, 0.1, 6] },
  "snow-peas": { 袋: [1, 38, 3, 0.2, 7.5] },
  somen: { 袋: [1, 350, 9.5, 1.1, 72] },
  "spring-roll-wrapper": { 袋: [1, 290, 8, 2, 58] },
  strawberry: { パック: [1, 68, 1.8, 0.2, 17] },
  takuan: { 袋: [1, 54, 1.5, 0.3, 12] },
  tenkasu: { 袋: [1, 520, 7, 36, 45] },
  "tempura-flour": { g: [100, 350, 8.8, 1.3, 74] },
  umeboshi: { 個: [1, 6, 0.2, 0.1, 1.4] },
  watermelon: { 個: [1, 370, 1.2, 0.2, 95] },
  asparagus: { 袋: [1, 21, 2.6, 0.2, 3.9] },
  bacon: { g: [100, 400, 12.9, 39.1, 0.3] },
  banana: { 袋: [1, 280, 3.3, 0.6, 68] },
  "beef-steak": { 枚: [1, 450, 30, 35, 0.5] },
  "bean-sprouts": { 袋: [1, 30, 3.6, 0.2, 5.2] },
  beef: { g: [100, 259, 17.1, 19.4, 0.3] },
  "bell-pepper": { 個: [1, 7, 0.3, 0.1, 1.8], 袋: [1, 30, 1.4, 0.3, 7.5] },
  bonito: { 袋: [1, 9, 1.9, 0.1, 0.1] },
  bread: { 枚: [1, 149, 5.2, 2.2, 28], 袋: [1, 894, 31.2, 13.2, 168] },
  breadcrumbs: { g: [100, 369, 14.6, 6.8, 63.4] },
  broccoli: { 個: [1, 83, 10.8, 1.5, 16.3] },
  butter: { g: [100, 700, 0.5, 81, 0.2] },
  "butter-roll": { 個: [1, 95, 3, 2.7, 14.6] },
  ham: { パック: [1, 155, 13, 11, 1] },
  "pork-belly": { g: [100, 366, 14.2, 34.6, 0.1] },
  "pork-loin": { g: [100, 248, 19.3, 19.2, 0.2] },
  sausage: { 袋: [1, 320, 13, 28, 3] },
  cabbage: { g: [100, 23, 1.3, 0.2, 5.2] },
  carrot: { 本: [1, 53, 1, 0.3, 14] },
  cheese: { g: [100, 313, 22.7, 26, 1.3] },
  "chicken-thigh": { g: [100, 190, 16.6, 14.2, 0] },
  "chicken-tender": { g: [100, 98, 23.9, 0.8, 0.1] },
  "chicken-wing": { g: [100, 195, 18.2, 12.8, 0] },
  chicken: { g: [100, 133, 21.3, 5.9, 0] },
  cucumber: { 本: [1, 13, 1, 0.1, 3] },
  eggplant: { 本: [1, 14, 0.8, 0.1, 4], 袋: [1, 42, 2.4, 0.3, 12] },
  eggs: { 個: [1, 76, 6.2, 5.2, 0.2] },
  garlic: { g: [100, 129, 6.4, 0.9, 27.5], 個: [1, 65, 3.2, 0.5, 13.8] },
  "garlic-chives": { 袋: [1, 18, 1.7, 0.3, 4] },
  ginger: { g: [100, 28, 0.9, 0.3, 6.6], 個: [1, 11, 0.4, 0.1, 2.6] },
  "green-onion": { 本: [1, 28, 1.4, 0.1, 7.2] },
  "ground-meat": { g: [100, 221, 17.7, 17.2, 0.3] },
  konnyaku: { 枚: [1, 18, 0.3, 0.3, 8.3] },
  lettuce: { 個: [1, 33, 1.8, 0.3, 8.4] },
  macaroni: { g: [100, 347, 12, 1.8, 72] },
  mackerel: { 切れ: [1, 211, 20.6, 16.8, 0.3] },
  milk: { 本: [1, 122, 6.6, 7.6, 9.6] },
  miso: { g: [100, 182, 12.5, 6, 33] },
  mushroom: { 株: [1, 26, 2.7, 0.6, 5.2] },
  natto: { パック: [1, 83, 7.4, 4.5, 5.4] },
  onion: { 個: [1, 66, 2, 0.2, 16.8] },
  pasta: { g: [100, 347, 12.9, 1.8, 73.1] },
  pork: { g: [100, 221, 18.5, 16, 0.2] },
  potato: { 個: [1, 89, 2.7, 0.2, 25] },
  pumpkin: { g: [100, 78, 1.9, 0.3, 20.6] },
  radish: { g: [100, 15, 0.4, 0.1, 4.1], 本: [1, 135, 3.6, 0.9, 36.9] },
  rice: { 膳: [1, 234, 3.8, 0.5, 55.7] },
  salmon: { 切れ: [1, 106, 18, 3.6, 0.1] },
  "sesame-oil": { 小さじ: [1, 37, 0, 4.1, 0] },
  shrimp: { g: [100, 82, 18.4, 0.3, 0.3] },
  soba: { g: [100, 344, 14, 2.3, 66.7] },
  spinach: { g: [100, 18, 2.2, 0.4, 3.1], 袋: [1, 36, 4.4, 0.8, 6.2] },
  tofu: { g: [100, 56, 4.9, 3, 1.5], 個: [1, 168, 14.7, 9, 4.5] },
  tomato: { 個: [1, 40, 1.4, 0.2, 9.4] },
  tuna: { 缶: [1, 188, 12.4, 15.2, 0.1] },
  udon: { 袋: [1, 210, 5.2, 0.8, 43.2] },
  wakame: { g: [10, 14, 1.4, 0.3, 4.1], 袋: [1, 28, 2.8, 0.6, 8.2] },
  "yakisoba-noodles": { 袋: [1, 225, 6, 2.5, 45] },
  yellowtail: { 切れ: [1, 222, 21.4, 17.6, 0.3] },
  yogurt: { 個: [1, 56, 3.6, 3, 4.9] }
};

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
  ["ワカメ", "wakame"],
  ["うどん", "udon"],
  ["饂飩", "udon"],
  ["そば", "soba"],
  ["蕎麦", "soba"],
  ["焼きそば麺", "yakisoba-noodles"],
  ["焼そば麺", "yakisoba-noodles"],
  ["中華麺", "yakisoba-noodles"],
  ["マカロニ", "macaroni"],
  ["さば", "mackerel"],
  ["サバ", "mackerel"],
  ["鯖", "mackerel"],
  ["ぶり", "yellowtail"],
  ["ブリ", "yellowtail"],
  ["鰤", "yellowtail"],
  ["えび", "shrimp"],
  ["エビ", "shrimp"],
  ["海老", "shrimp"],
  ["ツナ", "tuna"],
  ["シーチキン", "tuna"],
  ["もやし", "bean-sprouts"],
  ["モヤシ", "bean-sprouts"],
  ["にら", "garlic-chives"],
  ["ニラ", "garlic-chives"],
  ["韮", "garlic-chives"],
  ["かぼちゃ", "pumpkin"],
  ["カボチャ", "pumpkin"],
  ["南瓜", "pumpkin"],
  ["こんにゃく", "konnyaku"],
  ["まぐろ", "tuna-sashimi"],
  ["たら", "cod"],
  ["さんま", "saury"],
  ["あじ", "horse-mackerel"],
  ["いわし", "sardine"],
  ["いか", "squid"],
  ["たこ", "octopus"],
  ["あさり", "clam"],
  ["しじみ", "freshwater-clam"],
  ["ほたて", "scallop"],
  ["ホタテ", "scallop"],
  ["かき", "oyster"],
  ["牡蠣", "oyster"],
  ["しらす", "whitebait"],
  ["たらこ", "cod-roe"],
  ["鮭フレーク", "salmon-flake"],
  ["ちくわ", "chikuwa"],
  ["かまぼこ", "kamaboko"],
  ["はんぺん", "hanpen"],
  ["さつま揚げ", "satsumaage"],
  ["カニカマ", "kanikama"],
  ["生クリーム", "fresh-cream"],
  ["豆乳", "soy-milk"],
  ["油揚げ", "fried-tofu"],
  ["厚揚げ", "thick-fried-tofu"],
  ["高野豆腐", "koya-tofu"],
  ["白菜", "chinese-cabbage"],
  ["小松菜", "komatsuna"],
  ["チンゲン菜", "bok-choy"],
  ["水菜", "mizuna"],
  ["春菊", "shungiku"],
  ["カリフラワー", "cauliflower"],
  ["セロリ", "celery"],
  ["豆苗", "pea-sprouts"],
  ["大葉", "shiso"],
  ["パセリ", "parsley"],
  ["さつまいも", "sweet-potato"],
  ["里芋", "taro"],
  ["長芋", "yam"],
  ["ごぼう", "burdock"],
  ["れんこん", "lotus-root"],
  ["かぶ", "turnip"],
  ["たけのこ", "boiled-bamboo"],
  ["ミニトマト", "cherry-tomato"],
  ["プチトマト", "cherry-tomato"],
  ["パプリカ", "paprika"],
  ["ズッキーニ", "zucchini"],
  ["オクラ", "okra"],
  ["とうもろこし", "corn"],
  ["ゴーヤ", "bitter-melon"],
  ["さやいんげん", "green-beans"],
  ["絹さや", "snow-peas"],
  ["きぬさや", "snow-peas"],
  ["枝豆", "edamame"],
  ["そら豆", "broad-beans"],
  ["しいたけ", "shiitake"],
  ["椎茸", "shiitake"],
  ["えのき", "enoki"],
  ["まいたけ", "maitake"],
  ["エリンギ", "eringi"],
  ["マッシュルーム", "mushroom-button"],
  ["なめこ", "nameko"],
  ["みかん", "mandarin"],
  ["いちご", "strawberry"],
  ["ぶどう", "grape"],
  ["なし", "pear"],
  ["梨", "pear"],
  ["桃", "peach"],
  ["キウイ", "kiwi"],
  ["レモン", "lemon"],
  ["オレンジ", "orange"],
  ["メロン", "melon"],
  ["すいか", "watermelon"],
  ["パイナップル", "pineapple"],
  ["ブルーベリー", "blueberry"],
  ["フランスパン", "french-bread"],
  ["バゲット", "french-bread"],
  ["そうめん", "somen"],
  ["中華麺", "chinese-noodles"],
  ["餃子の皮", "gyoza-wrapper"],
  ["春巻きの皮", "spring-roll-wrapper"],
  ["餅", "mochi"],
  ["切り餅", "mochi"],
  ["小麦粉", "flour"],
  ["薄力粉", "flour"],
  ["片栗粉", "potato-starch"],
  ["天ぷら粉", "tempura-flour"],
  ["のり", "nori"],
  ["海苔", "nori"],
  ["ひじき", "hijiki"],
  ["切り干し大根", "dried-radish"],
  ["春雨", "glass-noodles"],
  ["昆布", "kombu"],
  ["煮干し", "dried-sardine"],
  ["干ししいたけ", "dried-shiitake"],
  ["ごま", "sesame"],
  ["麩", "fu"],
  ["トマト缶", "canned-tomato"],
  ["コーン缶", "canned-corn"],
  ["サバ缶", "canned-mackerel"],
  ["大豆水煮", "boiled-soybeans"],
  ["しらたき", "shirataki"],
  ["ミックスベジタブル", "mixed-vegetables"],
  ["キムチ", "kimchi"],
  ["たくあん", "takuan"],
  ["梅干し", "umeboshi"],
  ["鶏もも肉", "chicken-thigh"],
  ["ささみ", "chicken-tender"],
  ["鶏ささみ", "chicken-tender"],
  ["手羽元", "chicken-wing"],
  ["鶏手羽", "chicken-wing"],
  ["豚バラ", "pork-belly"],
  ["豚バラ肉", "pork-belly"],
  ["豚ロース", "pork-loin"],
  ["ステーキ肉", "beef-steak"],
  ["ハム", "ham"],
  ["ソーセージ", "sausage"],
  ["ウインナー", "sausage"],
  ["とりもも", "chicken-thigh"],
  ["アスパラ", "asparagus"],
  ["アスパラガス", "asparagus"],
  ["ベーコン", "bacon"],
  ["バターロール", "butter-roll"],
  ["ロールパン", "butter-roll"],
  ["コンニャク", "konnyaku"],
  ["蒟蒻", "konnyaku"]
]);

// レシピは総称（鶏むね肉・豚こま・ひき肉）で材料を持つが、店で買うのは部位や商品
// （鶏もも肉・豚バラ・豚ひき肉）。総称ごとに代用できるidを持たせないと、
// 持っているのに「不足」と出る。単位の完全一致依存と同じ種類の不具合。
//
// ここに書けるのは、総称と単位が一致するものだけ。単位が違う組み合わせ
// （トマト「個」とミニトマト「パック」、チーズ「g」とピザ用チーズ「袋」、
// ごはん「膳」と米「g」など）は、量の換算を決めてからでないと扱えない。
// 単位が同じものは id だけ。単位が違うものは ratio を書く。
// ratio は「代用を標準の単位で1つ持っているとき、総称の単位でいくつ分か」。
const INGREDIENT_SUBSTITUTES = {
  chicken: ["chicken-thigh", "chicken-tender", "chicken-wing", "chicken-wing-tip"],
  pork: ["pork-belly", "pork-loin", "pork-shoulder"],
  beef: ["beef-tongue", "beef-tendon", { id: "beef-steak", ratio: 150 }],
  "ground-meat": ["pork-mince", "chicken-mince"],
  onion: ["red-onion"],
  lettuce: ["sunny-lettuce", "salad-greens"],
  ginger: ["new-ginger"],
  tofu: ["grilled-tofu"],
  tomato: [{ id: "cherry-tomato", ratio: 1 }],
  cheese: [{ id: "sliced-cheese", ratio: 100 }, { id: "pizza-cheese", ratio: 150 }],
  "green-onion": [{ id: "green-onion-small", ratio: 1 }],
  cabbage: [{ id: "cut-vegetables", ratio: 200 }],
  rice: [{ id: "rice-raw", ratio: 0.015 }]
};

// 同じ食材を、標準と違う単位で登録したときの換算。
// 値は「その単位1つ分が、標準の単位でいくつ分か」。
//
// ★数字は家庭でのおおよその目安であり、商品や産地で幅がある。
// 足りるかどうかの判定が変わるので、迷ったら少なめに見積もる。
// 実際と合わない場合は、在庫の数量を手で直せる。
const UNIT_CONVERSIONS = {
  cabbage: { 個: 1000, 袋: 250 },
  radish: { g: 1 / 800 },
  carrot: { g: 1 / 150 },
  potato: { g: 1 / 120 },
  onion: { g: 1 / 200 },
  tomato: { g: 1 / 150 },
  eggs: { パック: 10 },
  bread: { 袋: 6 },
  milk: { ml: 1 / 1000 },
  tofu: { g: 1 / 300 },
  rice: { g: 1 / 150 },
  "sesame-oil": { 小さじ: 1 / 30 }
};

// 代用の逆引き（例 chicken-thigh → chicken）。部位を持っていることを、
// 総称への要求と結び付けるのに使う。
const SUBSTITUTE_GENERICS = new Map(
  Object.entries(INGREDIENT_SUBSTITUTES).flatMap(([generic, list]) =>
    list.map((entry) => [normalizedSubstitute(entry).id, generic])
  )
);

// 料理の完成イラスト。[列, 行, シート]。シートは assets/recipe-atlas-NN.png。
// まだ絵が無いレシピは、この表に無いだけでカードは今までどおり出る
const RECIPE_ILLUSTRATIONS = {
  "miso-stir-fry": [0, 0, "r01"],
  "egg-bowl": [1, 0, "r01"],
  "cabbage-pancake": [2, 0, "r01"],
  "mushroom-soup": [3, 0, "r01"],
  "home-curry": [0, 1, "r01"],
  nikujaga: [1, 1, "r01"],
  "hamburger-steak": [2, 1, "r01"],
  "salmon-meuniere": [3, 1, "r01"],
  napolitan: [0, 2, "r01"],
  "tofu-miso-soup": [1, 2, "r01"],
  "chicken-cabbage-steam": [2, 2, "r01"],
  "tomato-egg-stir-fry": [3, 2, "r01"],
  "mapo-tofu-style": [0, 0, "r02"],
  "natto-rice": [1, 0, "r02"],
  "eggplant-mince-stir-fry": [2, 0, "r02"],
  "chicken-broccoli-pan": [3, 0, "r02"],
  oyakodon: [0, 1, "r02"],
  gyudon: [1, 1, "r02"],
  "fried-rice": [2, 1, "r02"],
  omurice: [3, 1, "r02"],
  "soboro-bowl": [0, 2, "r02"],
  "ginger-pork": [1, 2, "r02"],
  "chicken-teriyaki": [2, 2, "r02"],
  "chicken-karaage": [3, 2, "r02"],
  "beef-pepper-stir-fry": [0, 0, "r03"],
  "meat-tofu": [1, 0, "r03"],
  "pork-cabbage-millefeuille": [2, 0, "r03"],
  "salmon-foil-yaki": [3, 0, "r03"],
  "salmon-teriyaki": [0, 1, "r03"],
  "dashimaki-egg": [1, 1, "r03"],
  "agedashi-tofu": [2, 1, "r03"],
  "tofu-steak": [3, 1, "r03"],
  "cheese-omelet": [0, 2, "r03"],
  "potato-salad": [1, 2, "r03"],
  "spinach-sesame": [2, 2, "r03"],
  "eggplant-miso": [3, 2, "r03"],
  "cucumber-wakame-vinegar": [0, 0, "r04"],
  coleslaw: [1, 0, "r04"],
  "carbonara-style": [2, 0, "r04"],
  "mushroom-butter-pasta": [3, 0, "r04"],
  "pork-miso-soup": [0, 1, "r04"],
  "vegetable-consomme": [1, 1, "r04"],
  "kake-udon": [2, 1, "r04"],
  "curry-udon": [3, 1, "r04"],
  "kake-soba": [0, 2, "r04"],
  "sauce-yakisoba": [1, 2, "r04"],
  "macaroni-gratin": [2, 2, "r04"],
  "mackerel-miso": [3, 2, "r04"],
  "mackerel-salt-grill": [0, 0, "r05"],
  "yellowtail-teriyaki": [1, 0, "r05"],
  "yellowtail-daikon": [2, 0, "r05"],
  "shrimp-chili": [3, 0, "r05"],
  "shrimp-fried-rice": [0, 1, "r05"],
  "tuna-mayo-rice": [1, 1, "r05"],
  "bean-sprout-namul": [2, 1, "r05"],
  "nira-tama": [3, 1, "r05"],
  "pumpkin-simmer": [0, 2, "r05"],
  "pumpkin-salad": [1, 2, "r05"],
  "konnyaku-piquant": [2, 2, "r05"],
  "cream-stew": [3, 2, "r05"],
  gyoza: [0, 0, "r06"],
  croquette: [1, 0, "r06"],
  "rolled-cabbage": [2, 0, "r06"],
  "menchi-katsu": [3, 0, "r06"],
  "yaki-udon": [0, 1, "r06"],
  "tuna-tomato-pasta": [1, 1, "r06"],
  "chicken-cream-pasta": [2, 1, "r06"],
  "tofu-champuru": [3, 1, "r06"],
  "salmon-fried-rice": [0, 2, "r06"],
  "cabbage-tuna-simmer": [1, 2, "r06"],
  "potato-cheese-bake": [2, 2, "r06"],
  "tomato-cheese-bake": [3, 2, "r06"],
  // r07は5品だけ。行1列1以降の7マスは空けてある
  "cheese-toast": [0, 0, "r07"],
  "pizza-toast": [1, 0, "r07"],
  "tuna-toast": [2, 0, "r07"],
  "french-toast": [3, 0, "r07"],
  "egg-sandwich": [0, 1, "r07"]
};

// 完成イラストをまだ描いていない追加レシピは、空欄にせず主役食材を大きく見せる。
// 完成絵を追加したらこの表から外し、RECIPE_ILLUSTRATIONSへ移す。
const RECIPE_ILLUSTRATION_FALLBACKS = {
  "mackerel-ginger-stew": "mackerel",
  "yellowtail-salt-grill": "yellowtail",
  "shrimp-garlic-saute": "shrimp",
  "natto-omelet": "natto",
  "natto-pasta": "natto",
  "zaru-soba": "soba",
  "pork-cold-soba": "soba",
  "salt-yakisoba": "yakisoba-noodles",
  sobameshi: "yakisoba-noodles",
  "chilled-somen": "somen",
  "tuna-tomato-somen": "somen",
  "pork-chinese-cabbage-hotpot": "chinese-cabbage",
  "tofu-mushroom-hotpot": "tofu",
  "microwave-pork-kimchi": "pork-belly",
  "microwave-cabbage-shumai": "pork-mince",
  "microwave-eggplant-pork-ponzu": "eggplant",
  "microwave-tofu-egg-soup": "tofu",
  "microwave-salmon-mushroom": "salmon",
  "microwave-bean-sprout-pork": "bean-sprouts",
  "microwave-chicken-cabbage": "chicken",
  "microwave-tomato-cheese-rice": "tomato",
  "microwave-sweet-potato-butter": "sweet-potato",
  "microwave-potato-tuna-salad": "potato",
  "whitebait-green-onion-bowl": "whitebait",
  "tuna-cucumber-tofu": "tofu",
  "canned-mackerel-tomato": "canned-mackerel",
  "kimchi-cheese-udon": "udon",
  "natto-kimchi-bowl": "natto",
  "canned-sardine-cabbage-pasta": "canned-sardine",
  "bacon-spinach-egg": "bacon",
  "chicken-tender-shiso-cheese": "chicken-tender",
  "tofu-avocado-bowl": "avocado",
  "salmon-flake-ochazuke": "salmon-flake",
  "tomato-shio-kombu-tofu": "tomato",
  "pumpkin-mince-microwave": "pumpkin",
  "enoki-pork-roll-microwave": "enoki",
  "chicken-tomato-microwave": "chicken-thigh",
  "tomato-miso-soup": "tomato",
  "cabbage-sausage-soup": "cabbage",
  "tofu-kimchi-soup": "tofu",
  "avocado-tuna-toast": "avocado",
  "egg-mayo-rice-bowl": "eggs",
  "mushroom-butter-rice": "mushroom",
  ...EXPANDED_RECIPE_PACK.fallbacks
};

const INGREDIENT_ILLUSTRATIONS = {
  oatmeal: [0, 0, "s21"],
  granola: [1, 0, "s21"],
  "corn-flakes": [2, 0, "s21"],
  "fresh-pasta": [3, 0, "s21"],
  tenkasu: [0, 1, "s21"],
  aonori: [1, 1, "s21"],
  "sakura-shrimp": [2, 1, "s21"],
  "dried-shrimp": [3, 1, "s21"],
  "dried-soybeans": [0, 2, "s21"],
  azuki: [1, 2, "s21"],
  chickpeas: [2, 2, "s21"],
  lentils: [3, 2, "s21"],
  kikurage: [0, 0, "s22"],
  kanten: [1, 0, "s22"],
  gelatin: [2, 0, "s22"],
  "tororo-kombu": [3, 0, "s22"],
  "dried-tomato": [0, 1, "s22"],
  "canned-sardine": [1, 1, "s22"],
  "corned-beef": [2, 1, "s22"],
  spam: [3, 1, "s22"],
  "mixed-beans": [0, 2, "s22"],
  "tomato-puree": [1, 2, "s22"],
  "coconut-milk": [2, 2, "s22"],
  nametake: [3, 2, "s22"],
  "nori-tsukudani": [0, 0, "s23"],
  "peanut-butter": [1, 0, "s23"],
  anko: [2, 0, "s23"],
  "canned-peach": [3, 0, "s23"],
  menma: [0, 1, "s23"],
  zasai: [1, 1, "s23"],
  "beni-shoga": [2, 1, "s23"],
  rakkyo: [3, 1, "s23"],
  fukujinzuke: [0, 2, "s23"],
  nozawana: [1, 2, "s23"],
  "frozen-seafood-mix": [2, 2, "s23"],
  "frozen-potato": [3, 2, "s23"],
  coriander: [0, 0, "s24"],
  moroheiya: [1, 0, "s24"],
  "water-spinach": [2, 0, "s24"],
  nanohana: [3, 0, "s24"],
  "snap-peas": [0, 1, "s24"],
  "winter-melon": [1, 1, "s24"],
  fuki: [2, 1, "s24"],
  "salad-greens": [3, 1, "s24"],
  "new-ginger": [0, 2, "s24"],
  raspberry: [1, 2, "s24"],
  ume: [2, 2, "s24"],
  plum: [3, 2, "s24"],
  loquat: [0, 0, "s25"],
  hassaku: [1, 0, "s25"],
  "beef-tendon": [2, 0, "s25"],
  "beef-tongue": [3, 0, "s25"],
  horumon: [0, 1, "s25"],
  "chicken-skin": [1, 1, "s25"],
  duck: [2, 1, "s25"],
  "roast-beef": [3, 1, "s25"],
  "bacon-block": [0, 2, "s25"],
  "atka-mackerel": [1, 2, "s25"],
  "spanish-mackerel": [2, 2, "s25"],
  "conger-eel": [3, 2, "s25"],
  shirako: [0, 0, "s26"],
  kazunoko: [1, 0, "s26"],
  uni: [2, 0, "s26"],
  "sweet-shrimp": [3, 0, "s26"],
  "shime-saba": [0, 1, "s26"],
  camembert: [1, 1, "s26"],
  "blue-cheese": [2, 1, "s26"],
  "cottage-cheese": [3, 1, "s26"],
  "sour-cream": [0, 2, "s26"],
  "onsen-egg": [1, 2, "s26"],
  "grilled-tofu": [2, 2, "s26"],
  "buckwheat-flour": [3, 2, "s26"],
  "rye-bread": [0, 0, "s27"],
  "wonton-wrapper": [1, 0, "s27"],
  "pho-noodles": [2, 0, "s27"],
  "pie-sheet": [3, 0, "s27"],
  "corn-starch": [0, 1, "s27"],
  almond: [1, 1, "s27"],
  walnut: [2, 1, "s27"],
  cashew: [3, 1, "s27"],
  barley: [0, 2, "s27"],
  couscous: [1, 2, "s27"],
  "shio-kombu": [2, 2, "s27"],
  furikake: [3, 2, "s27"],
  chirimen: [0, 0, "s18"],
  "dried-aji": [1, 0, "s18"],
  ikura: [2, 0, "s18"],
  crab: [3, 0, "s18"],
  hamaguri: [0, 1, "s18"],
  mozuku: [1, 1, "s18"],
  mekabu: [2, 1, "s18"],
  "fish-sausage": [3, 1, "s18"],
  "ika-shiokara": [0, 2, "s18"],
  "sliced-cheese": [1, 2, "s18"],
  "pizza-cheese": [2, 2, "s18"],
  "cream-cheese": [3, 2, "s18"],
  mozzarella: [0, 0, "s19"],
  "powdered-cheese": [1, 0, "s19"],
  margarine: [2, 0, "s19"],
  "condensed-milk": [3, 0, "s19"],
  "quail-egg": [0, 1, "s19"],
  ganmodoki: [1, 1, "s19"],
  yuba: [2, 1, "s19"],
  okara: [3, 1, "s19"],
  "tamago-tofu": [0, 2, "s19"],
  "rice-raw": [1, 2, "s19"],
  "mochi-rice": [2, 2, "s19"],
  "brown-rice": [3, 2, "s19"],
  croissant: [0, 0, "s20"],
  bagel: [1, 0, "s20"],
  "english-muffin": [2, 0, "s20"],
  naan: [3, 0, "s20"],
  tortilla: [0, 1, "s20"],
  penne: [1, 1, "s20"],
  bifun: [2, 1, "s20"],
  kishimen: [3, 1, "s20"],
  "pancake-mix": [0, 2, "s20"],
  "okonomiyaki-flour": [1, 2, "s20"],
  "bread-flour": [2, 2, "s20"],
  shiratamako: [3, 2, "s20"],
  avocado: [0, 0, "s14"],
  "green-onion-small": [1, 0, "s14"],
  "red-onion": [2, 0, "s14"],
  "sunny-lettuce": [3, 0, "s14"],
  "baby-leaf": [0, 1, "s14"],
  "brussels-sprouts": [1, 1, "s14"],
  kaiware: [2, 1, "s14"],
  myoga: [3, 1, "s14"],
  mitsuba: [0, 2, "s14"],
  basil: [1, 2, "s14"],
  watercress: [2, 2, "s14"],
  rucola: [3, 2, "s14"],
  shishito: [0, 0, "s15"],
  "young-corn": [1, 0, "s15"],
  "green-peas": [2, 0, "s15"],
  "radish-red": [3, 0, "s15"],
  yuzu: [0, 1, "s15"],
  "cut-vegetables": [1, 1, "s15"],
  "broccoli-sprout": [2, 1, "s15"],
  "shimeji-white": [3, 1, "s15"],
  persimmon: [0, 2, "s15"],
  chestnut: [1, 2, "s15"],
  cherry: [2, 2, "s15"],
  mango: [3, 2, "s15"],
  grapefruit: [0, 0, "s16"],
  lime: [1, 0, "s16"],
  fig: [2, 0, "s16"],
  raisin: [3, 0, "s16"],
  "western-pear": [0, 1, "s16"],
  prune: [1, 1, "s16"],
  "pork-mince": [2, 1, "s16"],
  "chicken-mince": [3, 1, "s16"],
  "pork-shoulder": [0, 2, "s16"],
  "spare-ribs": [1, 2, "s16"],
  "chicken-liver": [2, 2, "s16"],
  gizzard: [3, 2, "s16"],
  prosciutto: [0, 0, "s17"],
  salami: [1, 0, "s17"],
  "chicken-wing-tip": [2, 0, "s17"],
  lamb: [3, 0, "s17"],
  "char-siu": [0, 1, "s17"],
  mentaiko: [1, 1, "s17"],
  shishamo: [2, 1, "s17"],
  flatfish: [3, 1, "s17"],
  "sea-bream": [0, 2, "s17"],
  "bonito-fresh": [1, 2, "s17"],
  swordfish: [2, 2, "s17"],
  eel: [3, 2, "s17"],
  "snow-peas": [0, 0, "s10"],
  edamame: [1, 0, "s10"],
  "broad-beans": [2, 0, "s10"],
  shiitake: [3, 0, "s10"],
  enoki: [0, 1, "s10"],
  maitake: [1, 1, "s10"],
  eringi: [2, 1, "s10"],
  "mushroom-button": [3, 1, "s10"],
  nameko: [0, 2, "s10"],
  mandarin: [1, 2, "s10"],
  strawberry: [2, 2, "s10"],
  grape: [3, 2, "s10"],
  pear: [0, 0, "s11"],
  peach: [1, 0, "s11"],
  kiwi: [2, 0, "s11"],
  lemon: [3, 0, "s11"],
  orange: [0, 1, "s11"],
  melon: [1, 1, "s11"],
  watermelon: [2, 1, "s11"],
  pineapple: [3, 1, "s11"],
  blueberry: [0, 2, "s11"],
  "french-bread": [1, 2, "s11"],
  somen: [2, 2, "s11"],
  "chinese-noodles": [3, 2, "s11"],
  "gyoza-wrapper": [0, 0, "s12"],
  "spring-roll-wrapper": [1, 0, "s12"],
  mochi: [2, 0, "s12"],
  flour: [3, 0, "s12"],
  "potato-starch": [0, 1, "s12"],
  "tempura-flour": [1, 1, "s12"],
  nori: [2, 1, "s12"],
  hijiki: [3, 1, "s12"],
  "dried-radish": [0, 2, "s12"],
  "glass-noodles": [1, 2, "s12"],
  kombu: [2, 2, "s12"],
  "dried-sardine": [3, 2, "s12"],
  "dried-shiitake": [0, 0, "s13"],
  sesame: [1, 0, "s13"],
  fu: [2, 0, "s13"],
  "canned-tomato": [3, 0, "s13"],
  "canned-corn": [0, 1, "s13"],
  "canned-mackerel": [1, 1, "s13"],
  "boiled-soybeans": [2, 1, "s13"],
  shirataki: [3, 1, "s13"],
  "mixed-vegetables": [0, 2, "s13"],
  kimchi: [1, 2, "s13"],
  takuan: [2, 2, "s13"],
  umeboshi: [3, 2, "s13"],
  "tuna-sashimi": [0, 0, "s06"],
  cod: [1, 0, "s06"],
  saury: [2, 0, "s06"],
  "horse-mackerel": [3, 0, "s06"],
  sardine: [0, 1, "s06"],
  squid: [1, 1, "s06"],
  octopus: [2, 1, "s06"],
  clam: [3, 1, "s06"],
  "freshwater-clam": [0, 2, "s06"],
  scallop: [1, 2, "s06"],
  oyster: [2, 2, "s06"],
  whitebait: [3, 2, "s06"],
  "cod-roe": [0, 0, "s07"],
  "salmon-flake": [1, 0, "s07"],
  chikuwa: [2, 0, "s07"],
  kamaboko: [3, 0, "s07"],
  hanpen: [0, 1, "s07"],
  satsumaage: [1, 1, "s07"],
  kanikama: [2, 1, "s07"],
  "fresh-cream": [3, 1, "s07"],
  "soy-milk": [0, 2, "s07"],
  "fried-tofu": [1, 2, "s07"],
  "thick-fried-tofu": [2, 2, "s07"],
  "koya-tofu": [3, 2, "s07"],
  "chinese-cabbage": [0, 0, "s08"],
  komatsuna: [1, 0, "s08"],
  "bok-choy": [2, 0, "s08"],
  mizuna: [3, 0, "s08"],
  shungiku: [0, 1, "s08"],
  cauliflower: [1, 1, "s08"],
  celery: [2, 1, "s08"],
  "pea-sprouts": [3, 1, "s08"],
  shiso: [0, 2, "s08"],
  parsley: [1, 2, "s08"],
  "sweet-potato": [2, 2, "s08"],
  taro: [3, 2, "s08"],
  yam: [0, 0, "s09"],
  burdock: [1, 0, "s09"],
  "lotus-root": [2, 0, "s09"],
  turnip: [3, 0, "s09"],
  "boiled-bamboo": [0, 1, "s09"],
  "cherry-tomato": [1, 1, "s09"],
  paprika: [2, 1, "s09"],
  zucchini: [3, 1, "s09"],
  okra: [0, 2, "s09"],
  corn: [1, 2, "s09"],
  "bitter-melon": [2, 2, "s09"],
  "green-beans": [3, 2, "s09"],
  asparagus: [0, 0, "s05"],
  bacon: [1, 0, "s05"],
  "butter-roll": [2, 0, "s05"],
  "chicken-thigh": [3, 0, "s05"],
  bonito: [0, 1, "s05"],
  "pork-belly": [1, 1, "s05"],
  "pork-loin": [2, 1, "s05"],
  "chicken-tender": [3, 1, "s05"],
  "chicken-wing": [0, 2, "s05"],
  "beef-steak": [1, 2, "s05"],
  ham: [2, 2, "s05"],
  sausage: [3, 2, "s05"],
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
  wakame: [3, 2, "recipe"],
  udon: [0, 0, "expanded"],
  soba: [1, 0, "expanded"],
  "yakisoba-noodles": [2, 0, "expanded"],
  macaroni: [3, 0, "expanded"],
  mackerel: [0, 1, "expanded"],
  yellowtail: [1, 1, "expanded"],
  shrimp: [2, 1, "expanded"],
  tuna: [3, 1, "expanded"],
  "bean-sprouts": [0, 2, "expanded"],
  "garlic-chives": [1, 2, "expanded"],
  pumpkin: [2, 2, "expanded"],
  konnyaku: [3, 2, "expanded"],
  fettuccine: [0, 0, "s28"],
  linguine: [1, 0, "s28"],
  lasagna: [2, 0, "s28"],
  fusilli: [3, 0, "s28"],
  farfalle: [0, 1, "s28"],
  capellini: [1, 1, "s28"],
  gnocchi: [2, 1, "s28"],
  ravioli: [3, 1, "s28"],
  hiyamugi: [0, 2, "s28"],
  "instant-ramen": [1, 2, "s28"],
  "cup-noodles": [2, 2, "s28"],
  "frozen-udon": [3, 2, "s28"],
  "yakitori-can": [0, 0, "s29"],
  "saury-can": [1, 0, "s29"],
  "oil-sardine": [2, 0, "s29"],
  anchovy: [3, 0, "s29"],
  "clam-can": [0, 1, "s29"],
  "scallop-can": [1, 1, "s29"],
  "crab-can": [2, 1, "s29"],
  "meat-sauce": [3, 1, "s29"],
  "white-sauce": [0, 2, "s29"],
  demiglace: [1, 2, "s29"],
  "mushroom-can": [2, 2, "s29"],
  "mandarin-can": [3, 2, "s29"],
  kanpyo: [0, 0, "s30"],
  "dried-scallop": [1, 0, "s30"],
  surume: [2, 0, "s30"],
  tazukuri: [3, 0, "s30"],
  aosa: [0, 1, "s30"],
  "white-kikurage": [1, 1, "s30"],
  "cut-kombu": [2, 1, "s30"],
  "dashi-pack": [3, 1, "s30"],
  peanut: [0, 2, "s30"],
  pistachio: [1, 2, "s30"],
  "pine-nut": [2, 2, "s30"],
  "dried-sweet-potato": [3, 2, "s30"],
  "soy-sauce": [0, 0, "s31"],
  "sesame-oil": [1, 0, "s31"],
  "olive-oil": [2, 0, "s31"],
  "salad-oil": [3, 0, "s31"],
  mayonnaise: [0, 1, "s31"],
  ketchup: [1, 1, "s31"],
  sauce: [2, 1, "s31"],
  ponzu: [3, 1, "s31"],
  mentsuyu: [0, 2, "s31"],
  "dashi-powder": [1, 2, "s31"],
  consomme: [2, 2, "s31"],
  "curry-roux": [3, 2, "s31"],
  salt: [0, 0, "s32"],
  sugar: [1, 0, "s32"],
  vinegar: [2, 0, "s32"],
  mirin: [3, 0, "s32"],
  "cooking-sake": [0, 1, "s32"],
  pepper: [1, 1, "s32"],
  honey: [2, 1, "s32"],
  jam: [3, 1, "s32"],
  "canned-tomato-cut": [0, 2, "s32"],
  "canned-pineapple": [1, 2, "s32"],
  "dried-mango": [2, 2, "s32"],
  "soy-meat": [3, 2, "s32"]
};

const RECEIPT_RULES = [
  // 複合語を「酢」や既存の果物・麺として拾わないよう前に置く
  { id: "ponzu", name: "ポン酢", pattern: /(?:ポン酢|ぽん酢|ポンズ|味付けぽん酢|ゆずぽん)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "vinegar", name: "酢", pattern: /(?:米酢|穀物酢|りんご酢|黒酢|すし酢|お酢|酢|ビネガー)/, quantity: 1, unit: "本", location: "常温" },
  { id: "mentsuyu", name: "めんつゆ", pattern: /(?:めんつゆ|麺つゆ|メンツユ|そうめんつゆ|そばつゆ)/, quantity: 1, unit: "本", location: "常温" },
  // うずらの卵を卵として拾わないよう前に置く
  { id: "quail-egg", name: "うずらの卵", pattern: /(?:うずらの卵|ウズラの卵|うずら卵|鶉卵)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // 卵豆腐を卵・豆腐として拾わないよう前に置く（卵は豆腐より前にある）
  { id: "tamago-tofu", name: "卵豆腐", pattern: /(?:卵豆腐|たまご豆腐|玉子豆腐)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 温泉卵を卵として拾わないよう前に置く
  { id: "onsen-egg", name: "温泉卵", pattern: /(?:温泉卵|温泉たまご|おんたま)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "eggs", name: "卵", pattern: /(?:卵|玉子|たまご)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 芽キャベツをキャベツとして拾わないよう前に置く
  { id: "brussels-sprouts", name: "芽キャベツ", pattern: /(?:芽キャベツ|めキャベツ|芽きゃべつ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 千切りキャベツをキャベツとして拾わないよう前に置く
  { id: "cut-vegetables", name: "カット野菜", pattern: /(?:カット野菜|千切りキャベツ|サラダミックス|カットサラダ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "cabbage", name: "キャベツ", pattern: /(?:キャベツ|きゃべつ)/, quantity: 100, unit: "g", fractionUnit: "個", location: "冷蔵" },
  // 白まいたけ・白しめじを、しめじ／まいたけとして拾わないよう前に置く
  { id: "shimeji-white", name: "白まいたけ", pattern: /(?:白まいたけ|白舞茸|ブナピー|白しめじ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "mushroom", name: "しめじ", pattern: /(?:しめじ|シメジ)/, quantity: 1, unit: "株", location: "冷蔵" },
  { id: "pork", name: "豚こま", pattern: /(?:豚.*(?:こま|コマ|小間|切落|切り落)|(?:こま|コマ|小間).*豚)/, quantity: 100, unit: "g", location: "冷蔵" },
  // レシートは「ツインパックキヌ」のように商品名だけで「豆腐」の字を含まないことがある。
  // 絹・木綿の表記も豆腐として拾う。絹さや／キヌアを誤って拾わないよう除外する。
  // 高野豆腐・焼き豆腐・卵豆腐を足すときは、この豆腐より前に置く
  { id: "koya-tofu", name: "高野豆腐", pattern: /(?:高野豆腐|こうや豆腐|凍り豆腐)/, quantity: 1, unit: "袋", location: "常温" },
  // 焼き豆腐を豆腐として拾わないよう前に置く
  { id: "grilled-tofu", name: "焼き豆腐", pattern: /(?:焼き豆腐|焼豆腐)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "tofu", name: "豆腐", pattern: /(?:豆腐|とうふ|トウフ|絹ごし|きぬごし|木綿|もめん|モメン|絹(?!さや|サヤ)|キヌ(?!さや|サヤ|ア))/, quantity: 1, unit: "個", location: "冷蔵" },
  // 赤玉ねぎを玉ねぎとして拾わないよう前に置く
  { id: "red-onion", name: "赤玉ねぎ", pattern: /(?:赤玉ねぎ|赤たまねぎ|紫玉ねぎ|レッドオニオン)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "onion", name: "玉ねぎ", pattern: /(?:玉ねぎ|たまねぎ|タマネギ|玉葱)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "carrot", name: "にんじん", pattern: /(?:にんじん|ニンジン|人参)/, quantity: 1, unit: "本", location: "冷蔵" },
  // ミニトマトはトマトより前に置く（トマトとして拾われるのを防ぐ）
  { id: "cherry-tomato", name: "ミニトマト", pattern: /(?:ミニトマト|プチトマト|みにとまと)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // トマト缶はトマトより前に置く
  { id: "canned-tomato-cut", name: "カットトマト缶", pattern: /(?:カットトマト缶|カットトマト|ダイストマト缶|ダイストマト)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "canned-tomato", name: "トマト缶", pattern: /(?:トマト缶|カットトマト|ホールトマト|ダイストマト)/, quantity: 1, unit: "缶", location: "常温" },
  // ドライトマトをトマトとして拾わないよう前に置く
  { id: "dried-tomato", name: "ドライトマト", pattern: /(?:ドライトマト|乾燥トマト|セミドライトマト)/, quantity: 1, unit: "袋", location: "常温" },
  // トマトピューレをトマトとして拾わないよう前に置く
  { id: "tomato-puree", name: "トマトピューレ", pattern: /(?:トマトピューレ|トマトペースト)/, quantity: 1, unit: "個", location: "常温" },
  { id: "ketchup", name: "ケチャップ", pattern: /(?:ケチャップ|トマトケチャップ)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "tomato", name: "トマト", pattern: /(?:トマト|とまと)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "chicken", name: "鶏むね肉", pattern: /(?:鶏|若鶏).*(?:むね|ムネ|胸)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "chicken-thigh", name: "鶏もも肉", pattern: /(?:鶏|若鶏|とり).*(?:もも|モモ|腿)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "chicken-tender", name: "鶏ささみ", pattern: /(?:ささみ|ササミ|笹身)/, quantity: 100, unit: "g", location: "冷蔵" },
  // 手羽先は別の食材として後から足すので、ここでは拾わない
  { id: "chicken-wing", name: "鶏手羽", pattern: /(?:手羽元|手羽中)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "pork-belly", name: "豚バラ肉", pattern: /(?:豚バラ|豚ばら|ぶたバラ)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "pork-loin", name: "豚ロース", pattern: /(?:豚ロース|豚ろーす)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "beef-steak", name: "ステーキ肉", pattern: /(?:ステーキ)/, quantity: 1, unit: "枚", location: "冷蔵" },
  // 生ハム・サラミを足すときは、このハムより前に置いて誤検出を防ぐ
  // 生ハムをハムとして拾わないよう前に置く
  { id: "prosciutto", name: "生ハム", pattern: /(?:生ハム|生はむ|プロシュート)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "ham", name: "ハム", pattern: /(?:ハム|はむ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // 魚肉ソーセージをソーセージとして拾わないよう前に置く
  { id: "fish-sausage", name: "魚肉ソーセージ", pattern: /(?:魚肉ソーセージ|フィッシュソーセージ|おさかなソーセージ)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "sausage", name: "ソーセージ", pattern: /(?:ソーセージ|ウインナー|ウィンナー)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "potato", name: "じゃがいも", pattern: /(?:じゃがいも|ジャガイモ|馬鈴薯)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 小ねぎをねぎとして拾わないよう前に置く
  { id: "green-onion-small", name: "小ねぎ", pattern: /(?:小ねぎ|小ネギ|万能ねぎ|万能ネギ|わけぎ|ワケギ|細ねぎ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "green-onion", name: "ねぎ", pattern: /(?:長ねぎ|長ネギ|青ねぎ|青ネギ|ねぎ|ネギ|葱)/, quantity: 1, unit: "本", location: "冷蔵" },
  // コンデンスミルクを牛乳として拾わないよう前に置く（牛乳のパターンに「ミルク」がある）
  { id: "condensed-milk", name: "練乳", pattern: /(?:練乳|れん乳|コンデンスミルク)/, quantity: 1, unit: "個", location: "常温" },
  // ココナッツミルクを牛乳として拾わないよう前に置く
  { id: "coconut-milk", name: "ココナッツミルク", pattern: /(?:ココナッツミルク|ココナツミルク)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "milk", name: "牛乳", pattern: /(?:牛乳|ミルク)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "yogurt", name: "ヨーグルト", pattern: /(?:ヨーグルト|ヨ-グルト)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "natto", name: "納豆", pattern: /(?:納豆|なっとう)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "bread", name: "食パン", pattern: /(?:食パン|しょくぱん)/, quantity: 6, unit: "枚", location: "常温" },
  { id: "banana", name: "バナナ", pattern: /(?:バナナ|ばなな)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "apple", name: "りんご", pattern: /(?:りんご|リンゴ|林檎)/, quantity: 1, unit: "個", location: "常温" },
  // 切り干し大根は大根より前に置く
  { id: "dried-radish", name: "切り干し大根", pattern: /(?:切り干し|切干し|切干大根)/, quantity: 1, unit: "袋", location: "常温" },
  // かいわれ大根を大根として拾わないよう前に置く
  { id: "kaiware", name: "かいわれ大根", pattern: /(?:かいわれ|カイワレ|貝割れ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // 二十日大根を大根として拾わないよう前に置く
  { id: "radish-red", name: "ラディッシュ", pattern: /(?:ラディッシュ|ラディッシ|二十日大根)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "radish", name: "大根", pattern: /(?:大根|だいこん|ダイコン)/, quantity: 1, unit: "本", location: "冷蔵" },
  // サニーレタスをレタスとして拾わないよう前に置く
  { id: "sunny-lettuce", name: "サニーレタス", pattern: /(?:サニーレタス|サニ-レタス|グリーンリーフ|リーフレタス)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "lettuce", name: "レタス", pattern: /(?:レタス|れたす)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "cucumber", name: "きゅうり", pattern: /(?:きゅうり|キュウリ|胡瓜)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "beef", name: "牛肉", pattern: /(?:牛肉|国産牛|和牛|牛肩|牛バラ|牛ばら|牛もも|牛こま|牛切落|牛切り落)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "salmon", name: "鮭", pattern: /(?:鮭|サーモン)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  // スライスチーズをチーズとして拾わないよう前に置く
  { id: "sliced-cheese", name: "スライスチーズ", pattern: /(?:スライスチーズ|とろけるスライス)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // ピザ用チーズをチーズとして拾わないよう前に置く
  { id: "pizza-cheese", name: "ピザ用チーズ", pattern: /(?:ピザ用チーズ|シュレッドチーズ|とろけるチーズ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // クリームチーズをチーズとして拾わないよう前に置く
  { id: "cream-cheese", name: "クリームチーズ", pattern: /(?:クリームチーズ)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 粉チーズをチーズとして拾わないよう前に置く
  { id: "powdered-cheese", name: "粉チーズ", pattern: /(?:粉チーズ|パルメザン|パルミジャーノ)/, quantity: 1, unit: "個", location: "常温" },
  // モッツァレラチーズをチーズとして拾わないよう前に置く
  { id: "mozzarella", name: "モッツァレラ", pattern: /(?:モッツァレラ|モッツアレラ)/, quantity: 1, unit: "個", location: "冷蔵" },
  // カマンベールチーズをチーズとして拾わないよう前に置く
  { id: "camembert", name: "カマンベール", pattern: /(?:カマンベール)/, quantity: 1, unit: "個", location: "冷蔵" },
  // ブルーチーズをチーズとして拾わないよう前に置く
  { id: "blue-cheese", name: "ブルーチーズ", pattern: /(?:ブルーチーズ|ゴルゴンゾーラ)/, quantity: 1, unit: "個", location: "冷蔵" },
  // カッテージチーズをチーズとして拾わないよう前に置く
  { id: "cottage-cheese", name: "カッテージチーズ", pattern: /(?:カッテージチーズ|コテージチーズ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "cheese", name: "チーズ", pattern: /(?:チーズ|ちーず)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "bonito", name: "かつお節", pattern: /(?:かつお節|カツオ節|鰹節)/, quantity: 1, unit: "袋", location: "常温" },
  // 部位つきのひき肉を、総称の「ひき肉」より先に判定させる
  { id: "soy-meat", name: "大豆ミート", pattern: /(?:大豆ミート|だいずミート|ソイミート|ソイミンチ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "pork-mince", name: "豚ひき肉", pattern: /(?:豚ひき|豚挽|ぶたひき|豚ミンチ)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "chicken-mince", name: "鶏ひき肉", pattern: /(?:鶏ひき|鶏挽|とりひき|鶏ミンチ)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "ground-meat", name: "ひき肉", pattern: /(?:ひき肉|挽き肉|挽肉|ミンチ)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "spinach", name: "ほうれん草", pattern: /(?:ほうれん草|ホウレン草|菠菜)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "eggplant", name: "なす", pattern: /(?:なす|ナス|茄子)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "bell-pepper", name: "ピーマン", pattern: /(?:ピーマン|ぴーまん)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // ブロッコリースプラウトをブロッコリーとして拾わないよう前に置く
  { id: "broccoli-sprout", name: "ブロッコリースプラウト", pattern: /(?:ブロッコリースプラウト|スプラウト)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "broccoli", name: "ブロッコリー", pattern: /(?:ブロッコリー|ぶろっこりー)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "garlic", name: "にんにく", pattern: /(?:にんにく|ニンニク|大蒜)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 紅生姜をしょうがとして拾わないよう前に置く
  { id: "beni-shoga", name: "紅生姜", pattern: /(?:紅生姜|紅しょうが|べにしょうが)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 新生姜をしょうがとして拾わないよう前に置く
  { id: "new-ginger", name: "新生姜", pattern: /(?:新生姜|新しょうが)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "ginger", name: "しょうが", pattern: /(?:しょうが|ショウガ|生姜)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 生パスタをスパゲッティとして拾わないよう前に置く
  { id: "fresh-pasta", name: "生パスタ", pattern: /(?:生パスタ|生スパゲッティ|フレッシュパスタ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "fettuccine", name: "フェットチーネ", pattern: /(?:フェットチーネ|フェットチーニ|フェトチーネ|ふぇっとちーね)/, quantity: 100, unit: "g", location: "常温" },
  { id: "linguine", name: "リングイネ", pattern: /(?:リングイネ|リングイーネ|りんぐいね)/, quantity: 100, unit: "g", location: "常温" },
  { id: "lasagna", name: "ラザニア", pattern: /(?:ラザニア|ラザーニャ|らざにあ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "fusilli", name: "フジッリ", pattern: /(?:フジッリ|フジリ|ふじっり|ふじり)/, quantity: 100, unit: "g", location: "常温" },
  { id: "farfalle", name: "ファルファッレ", pattern: /(?:ファルファッレ|ファルファレ|ふぁるふぁっれ)/, quantity: 100, unit: "g", location: "常温" },
  { id: "capellini", name: "カッペリーニ", pattern: /(?:カッペリーニ|カペリーニ|カッペリーネ|かっぺりーに)/, quantity: 100, unit: "g", location: "常温" },
  { id: "gnocchi", name: "ニョッキ", pattern: /(?:ニョッキ|にょっき)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "ravioli", name: "ラビオリ", pattern: /(?:ラビオリ|らびおり)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "pasta", name: "スパゲッティ", pattern: /(?:スパゲッティ|スパゲティ|パスタ)/, quantity: 100, unit: "g", location: "常温" },
  // バターより前に置く。「バターロール」はパンであってバターではないため、
  // 先に当てて誤登録を防ぐ（バター側にも除外を入れて二重に守る）。
  { id: "butter-roll", name: "バターロール", pattern: /(?:バターロール|ばたーろーる|ロールパン|ろーるぱん)/, quantity: 6, unit: "個", location: "常温" },
  // ピーナッツバターをバターとして拾わないよう前に置く
  { id: "peanut-butter", name: "ピーナッツバター", pattern: /(?:ピーナッツバター|ピーナツバター|落花生バター)/, quantity: 1, unit: "個", location: "常温" },
  { id: "peanut", name: "ピーナッツ", pattern: /(?:ピーナッツ(?!バター|クリーム)|ピーナツ(?!バター|クリーム)|落花生(?!バター)|バタピー)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "butter", name: "バター", pattern: /(?:バター|ばたー)(?!ロール|ろーる)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "breadcrumbs", name: "パン粉", pattern: /(?:パン粉|ぱん粉)/, quantity: 100, unit: "g", location: "常温" },
  // サバ缶はさば・味噌より前に置く（「さば味噌煮」を味噌として拾わないため）
  // シート29の缶詰は、同名の生鮮食材より先に判定する
  { id: "yakitori-can", name: "焼き鳥缶", pattern: /(?:焼き鳥缶|焼鳥缶|やきとり缶|ヤキトリ缶)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "saury-can", name: "さんま蒲焼き缶", pattern: /(?:さんま蒲焼き缶|さんま蒲焼缶|サンマ蒲焼き缶|秋刀魚蒲焼缶|さんま缶)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "oil-sardine", name: "オイルサーディン", pattern: /(?:オイルサーディン|オイルサーデン|いわし油漬け|イワシ油漬け)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "anchovy", name: "アンチョビ", pattern: /(?:アンチョビ|アンチョビー|あんちょび)/, quantity: 1, unit: "缶", location: "冷蔵" },
  { id: "clam-can", name: "あさり水煮缶", pattern: /(?:あさり水煮缶|アサリ水煮缶|浅利水煮缶|あさり缶)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "scallop-can", name: "ホタテ缶", pattern: /(?:ホタテ缶|ほたて缶|帆立缶|ほたて水煮缶)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "crab-can", name: "カニ缶", pattern: /(?:カニ缶|かに缶|蟹缶|ずわいがに缶|ズワイガニ缶)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "meat-sauce", name: "ミートソース缶", pattern: /(?:ミートソース缶|ミートソース|みーとそーす)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "white-sauce", name: "ホワイトソース缶", pattern: /(?:ホワイトソース缶|ホワイトソース|白ソース)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "demiglace", name: "デミグラスソース缶", pattern: /(?:デミグラスソース缶|デミグラスソース|デミソース|ドミグラスソース)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "mushroom-can", name: "マッシュルーム缶", pattern: /(?:マッシュルーム缶|まっしゅるーむ缶|マッシュルーム水煮)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "mandarin-can", name: "みかん缶", pattern: /(?:みかん缶|ミカン缶|蜜柑缶|みかんシロップ漬)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "canned-mackerel", name: "サバ缶", pattern: /(?:さば缶|サバ缶|鯖缶|さば水煮|さば味噌煮)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "miso", name: "味噌", pattern: /(?:味噌|みそ|ミソ)/, quantity: 300, unit: "g", location: "冷蔵" },
  { id: "wakame", name: "わかめ", pattern: /(?:わかめ|ワカメ|若布)/, quantity: 1, unit: "袋", location: "常温" },
  // 冷凍うどんをうどんとして拾わないよう前に置く
  { id: "frozen-udon", name: "冷凍うどん", pattern: /(?:冷凍うどん|冷凍ウドン|れいとううどん)/, quantity: 1, unit: "袋", location: "冷凍" },
  { id: "udon", name: "うどん", pattern: /(?:うどん|ウドン|饂飩)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 即席麺を中華麺として拾わないよう前に置く
  { id: "instant-ramen", name: "即席ラーメン", pattern: /(?:即席ラーメン|即席らーめん|インスタントラーメン|袋麺|袋めん)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "cup-noodles", name: "カップ麺", pattern: /(?:カップ麺|カップめん|カップラーメン|即席カップ麺)/, quantity: 1, unit: "個", location: "常温" },
  // 中華麺は焼きそば麺より前に置く
  { id: "chinese-noodles", name: "中華麺", pattern: /(?:中華麺|中華めん|生ラーメン|ラーメン用麺)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "yakisoba-noodles", name: "焼きそば麺", pattern: /(?:焼き?そば(?:.*麺)?|中華麺|蒸し麺)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // そば粉をそばとして拾わないよう前に置く
  { id: "buckwheat-flour", name: "そば粉", pattern: /(?:そば粉|蕎麦粉)/, quantity: 500, unit: "g", location: "常温" },
  { id: "soba", name: "そば", pattern: /(?:そば|ソバ|蕎麦)/, quantity: 100, unit: "g", location: "常温" },
  { id: "macaroni", name: "マカロニ", pattern: /(?:マカロニ|まかろに)/, quantity: 100, unit: "g", location: "常温" },
  // しめ鯖をさばとして拾わないよう前に置く
  { id: "shime-saba", name: "しめ鯖", pattern: /(?:しめ鯖|〆さば|しめさば|〆鯖)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "mackerel", name: "さば", pattern: /(?:さば|サバ|鯖)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  { id: "yellowtail", name: "ぶり", pattern: /(?:ぶり|ブリ|鰤)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  // 桜えびをえびとして拾わないよう前に置く
  { id: "sakura-shrimp", name: "桜えび", pattern: /(?:桜えび|サクラエビ|さくらえび)/, quantity: 1, unit: "袋", location: "常温" },
  // 干しエビをえびとして拾わないよう前に置く
  { id: "dried-shrimp", name: "干しエビ", pattern: /(?:干しえび|干しエビ|乾燥えび)/, quantity: 1, unit: "袋", location: "常温" },
  // 甘えびをえびとして拾わないよう前に置く
  { id: "sweet-shrimp", name: "甘えび", pattern: /(?:甘えび|甘エビ|アマエビ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "shrimp", name: "えび", pattern: /(?:えび|エビ|海老)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "tuna", name: "ツナ", pattern: /(?:ツナ|シーチキン|まぐろ油漬)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "bean-sprouts", name: "もやし", pattern: /(?:もやし|モヤシ|萌やし)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "garlic-chives", name: "にら", pattern: /(?:にら|ニラ|韮)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "pumpkin", name: "かぼちゃ", pattern: /(?:かぼちゃ|カボチャ|南瓜)/, quantity: 400, unit: "g", location: "冷蔵" },
  { id: "konnyaku", name: "こんにゃく", pattern: /(?:こんにゃく|コンニャク|蒟蒻)/, quantity: 1, unit: "枚", location: "冷蔵" },
  { id: "asparagus", name: "アスパラガス", pattern: /(?:アスパラ|あすぱら)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // ベーコンブロックをベーコンとして拾わないよう前に置く
  { id: "bacon-block", name: "ベーコンブロック", pattern: /(?:ベーコンブロック|厚切りベーコン|ブロックベーコン)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "bacon", name: "ベーコン", pattern: /(?:ベーコン|べーこん)/, quantity: 100, unit: "g", location: "冷蔵" },
  // ここから シート06〜09 の食材
  { id: "tuna-sashimi", name: "まぐろ", pattern: /(?:まぐろ|マグロ|鮪|めばち|びんちょう)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "cod", name: "たら", pattern: /(?:真だら|マダラ|生たら|たら切身|たら切り身|鱈)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  { id: "saury", name: "さんま", pattern: /(?:さんま|サンマ|秋刀魚)/, quantity: 1, unit: "本", location: "冷蔵" },
  // 既存のあじが「あじの開き」も拾うので前に置く
  { id: "dried-aji", name: "あじの開き", pattern: /(?:あじの開き|アジの開き|鯵の開き|アジ開き)/, quantity: 1, unit: "枚", location: "冷蔵" },
  { id: "horse-mackerel", name: "あじ", pattern: /(?:鯵|アジ(?!ア)|あじ(?:の開き)?(?![^\s]*(?:つけ|付け)))/, quantity: 1, unit: "本", location: "冷蔵" },
  // いわし缶をいわしとして拾わないよう前に置く
  { id: "canned-sardine", name: "いわし缶", pattern: /(?:いわし缶|イワシ缶|鰯缶|オイルサーディン)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "sardine", name: "いわし", pattern: /(?:いわし|イワシ|鰯)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "surume", name: "するめ", pattern: /(?:するめ(?!いか)|スルメ(?!イカ)|干し(?:いか|イカ)|干烏賊)/, quantity: 1, unit: "枚", location: "常温" },
  { id: "squid", name: "いか", pattern: /(?:するめいか|スルメイカ|やりいか|ヤリイカ|烏賊|イカ(?!リ))/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "octopus", name: "たこ", pattern: /(?:ゆでだこ|ゆでタコ|茹でだこ|真だこ|マダコ|蛸|タコ(?!ス|ヤ))/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "clam", name: "あさり", pattern: /(?:あさり|アサリ|浅利)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "freshwater-clam", name: "しじみ", pattern: /(?:しじみ|シジミ|蜆)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "dried-scallop", name: "干し貝柱", pattern: /(?:干し貝柱|干貝柱|ほし貝柱|乾燥貝柱)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "scallop", name: "ホタテ", pattern: /(?:ほたて|ホタテ|帆立)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "oyster", name: "かき", pattern: /(?:牡蠣|カキ(?!氷|フライ))/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "whitebait", name: "しらす", pattern: /(?:しらす|シラス|白子干)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // 明太子を足すときは、このたらこより前に置く
  { id: "cod-roe", name: "たらこ", pattern: /(?:たらこ|タラコ|鱈子)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "salmon-flake", name: "鮭フレーク", pattern: /(?:鮭フレーク|さけフレーク|サケフレーク)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "chikuwa", name: "ちくわ", pattern: /(?:ちくわ|チクワ|竹輪)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "kamaboko", name: "かまぼこ", pattern: /(?:かまぼこ|カマボコ|蒲鉾)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "hanpen", name: "はんぺん", pattern: /(?:はんぺん|ハンペン|半片)/, quantity: 1, unit: "枚", location: "冷蔵" },
  { id: "satsumaage", name: "さつま揚げ", pattern: /(?:さつま揚|サツマ揚|薩摩揚)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "kanikama", name: "カニカマ", pattern: /(?:かにかま|カニカマ|カニ風味)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "fresh-cream", name: "生クリーム", pattern: /(?:生クリーム|純生クリーム|ホイップ)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "soy-milk", name: "豆乳", pattern: /(?:豆乳|とうにゅう)/, quantity: 1, unit: "本", location: "冷蔵" },
  // 厚揚げを先に見るので、油揚げのパターンは「厚」を含まない
  { id: "thick-fried-tofu", name: "厚揚げ", pattern: /(?:厚揚|あつあげ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "fried-tofu", name: "油揚げ", pattern: /(?:油揚|あぶらあげ|あぶらげ|薄揚)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 白菜キムチを足すときは、この白菜より前に置く
  // 白菜キムチを白菜として拾わないよう、キムチを白菜より前に置く
  { id: "kimchi", name: "キムチ", pattern: /(?:キムチ|きむち)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "chinese-cabbage", name: "白菜", pattern: /(?:白菜|はくさい|ハクサイ)/, quantity: 400, unit: "g", location: "冷蔵" },
  { id: "komatsuna", name: "小松菜", pattern: /(?:小松菜|こまつな|コマツナ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "bok-choy", name: "チンゲン菜", pattern: /(?:チンゲン|ちんげん|青梗菜)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "mizuna", name: "水菜", pattern: /(?:水菜|みずな|ミズナ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "shungiku", name: "春菊", pattern: /(?:春菊|しゅんぎく|シュンギク)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "cauliflower", name: "カリフラワー", pattern: /(?:カリフラワー|かりふらわー)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "celery", name: "セロリ", pattern: /(?:セロリ|せろり)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "pea-sprouts", name: "豆苗", pattern: /(?:豆苗|とうみょう)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "shiso", name: "大葉", pattern: /(?:大葉|おおば|青じそ|青シソ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "parsley", name: "パセリ", pattern: /(?:パセリ|ぱせり)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 干し芋をさつまいもとして拾わないよう前に置く
  { id: "dried-sweet-potato", name: "干し芋", pattern: /(?:干し芋|ほしいも|干しいも|乾燥さつまいも)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "sweet-potato", name: "さつまいも", pattern: /(?:さつまいも|サツマイモ|薩摩芋|紅あずま|べにはるか)/, quantity: 1, unit: "本", location: "常温" },
  { id: "taro", name: "里芋", pattern: /(?:里芋|さといも|サトイモ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "yam", name: "長芋", pattern: /(?:長芋|ながいも|ナガイモ|山芋|やまいも)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "burdock", name: "ごぼう", pattern: /(?:ごぼう|ゴボウ|牛蒡)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "lotus-root", name: "れんこん", pattern: /(?:れんこん|レンコン|蓮根)/, quantity: 1, unit: "本", location: "冷蔵" },
  // めかぶを「かぶ」として拾わないよう前に置く
  { id: "mekabu", name: "めかぶ", pattern: /(?:めかぶ|メカブ|芽かぶ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "turnip", name: "かぶ", pattern: /(?:かぶ(?!せ)|カブ(?!キ)|蕪)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "boiled-bamboo", name: "たけのこ水煮", pattern: /(?:たけのこ|タケノコ|筍)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "paprika", name: "パプリカ", pattern: /(?:パプリカ|ぱぷりか)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "zucchini", name: "ズッキーニ", pattern: /(?:ズッキーニ|ずっきーに)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "okra", name: "オクラ", pattern: /(?:オクラ|おくら)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "corn", name: "とうもろこし", pattern: /(?:とうもろこし|トウモロコシ|玉蜀黍)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "bitter-melon", name: "ゴーヤ", pattern: /(?:ゴーヤ|ごーや|にがうり|苦瓜)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "green-beans", name: "さやいんげん", pattern: /(?:いんげん|インゲン|隠元)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // ここから シート10〜13 の食材
  { id: "snow-peas", name: "絹さや", pattern: /(?:絹さや|きぬさや|サヤエンドウ|さやえんどう)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "edamame", name: "枝豆", pattern: /(?:枝豆|えだまめ|エダマメ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "broad-beans", name: "そら豆", pattern: /(?:そら豆|ソラ豆|空豆|蚕豆)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 干ししいたけは生のしいたけより前に置く
  { id: "dried-shiitake", name: "干ししいたけ", pattern: /(?:干し椎茸|干ししいたけ|乾しいたけ|乾燥しいたけ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "shiitake", name: "しいたけ", pattern: /(?:生しいたけ|しいたけ|シイタケ|椎茸)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "enoki", name: "えのき", pattern: /(?:えのき|エノキ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "maitake", name: "まいたけ", pattern: /(?:まいたけ|マイタケ|舞茸)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "eringi", name: "エリンギ", pattern: /(?:エリンギ|えりんぎ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "mushroom-button", name: "マッシュルーム", pattern: /(?:マッシュルーム|まっしゅるーむ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "nameko", name: "なめこ", pattern: /(?:なめこ|ナメコ|滑子)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "mandarin", name: "みかん", pattern: /(?:みかん|ミカン|蜜柑|温州)/, quantity: 1, unit: "個", location: "常温" },
  { id: "jam", name: "ジャム", pattern: /(?:ジャム|いちごジャム|苺ジャム|ブルーベリージャム|マーマレード)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "strawberry", name: "いちご", pattern: /(?:いちご|イチゴ|苺|とちおとめ|あまおう)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // 干しぶどうをぶどうとして拾わないよう前に置く
  { id: "raisin", name: "レーズン", pattern: /(?:レーズン|干しぶどう|干しブドウ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "grape", name: "ぶどう", pattern: /(?:ぶどう|ブドウ|葡萄|シャイン|巨峰|ピオーネ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  // 洋梨をなしとして拾わないよう前に置く
  { id: "western-pear", name: "洋梨", pattern: /(?:洋梨|洋なし|ラフランス|ラ・フランス)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "pear", name: "なし", pattern: /(?:幸水|豊水|新甘泉|和梨|梨)/, quantity: 1, unit: "個", location: "冷蔵" },
  // 桃缶を桃として拾わないよう前に置く
  { id: "canned-peach", name: "桃缶", pattern: /(?:桃缶|白桃缶|もも缶)/, quantity: 1, unit: "缶", location: "常温" },
  // すももの「もも」を桃として拾わないよう前に置く
  { id: "plum", name: "すもも", pattern: /(?:すもも|スモモ|プラム(?!ジュース))/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "peach", name: "桃", pattern: /(?:白桃|もも(?!肉)|桃(?!色))/, quantity: 1, unit: "個", location: "常温" },
  { id: "kiwi", name: "キウイ", pattern: /(?:キウイ|きうい)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "lemon", name: "レモン", pattern: /(?:レモン|れもん|檸檬)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "orange", name: "オレンジ", pattern: /(?:オレンジ|ネーブル|バレンシア)/, quantity: 1, unit: "個", location: "常温" },
  { id: "melon", name: "メロン", pattern: /(?:メロン|めろん)/, quantity: 1, unit: "個", location: "常温" },
  { id: "watermelon", name: "すいか", pattern: /(?:すいか|スイカ|西瓜)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "canned-pineapple", name: "パイナップル缶", pattern: /(?:パイナップル缶|パイン缶|パインアップル缶|パインシロップ漬)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "pineapple", name: "パイナップル", pattern: /(?:パイナップル|パイン(?!ミール))/, quantity: 1, unit: "個", location: "常温" },
  { id: "blueberry", name: "ブルーベリー", pattern: /(?:ブルーベリー|ぶるーべりー)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "french-bread", name: "フランスパン", pattern: /(?:フランスパン|バゲット|バタール)/, quantity: 1, unit: "本", location: "常温" },
  // 冷麦をそうめんとして拾わないよう前に置く
  { id: "hiyamugi", name: "冷麦", pattern: /(?:冷麦|ひやむぎ|ヒヤムギ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "somen", name: "そうめん", pattern: /(?:そうめん|ソウメン|素麺|冷麦|ひやむぎ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "gyoza-wrapper", name: "餃子の皮", pattern: /(?:餃子の皮|ぎょうざの皮|餃子皮)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "spring-roll-wrapper", name: "春巻きの皮", pattern: /(?:春巻きの皮|春巻の皮|はるまきの皮)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "mochi", name: "餅", pattern: /(?:切り餅|切餅|丸餅|角餅|もち(?!米|ろん))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "flour", name: "小麦粉", pattern: /(?:小麦粉|薄力粉|中力粉)/, quantity: 500, unit: "g", location: "常温" },
  { id: "potato-starch", name: "片栗粉", pattern: /(?:片栗粉|かたくり粉)/, quantity: 200, unit: "g", location: "常温" },
  { id: "tempura-flour", name: "天ぷら粉", pattern: /(?:天ぷら粉|てんぷら粉|天麩羅粉)/, quantity: 300, unit: "g", location: "常温" },
  // 青のりをのりとして拾わないよう前に置く
  { id: "aonori", name: "青のり", pattern: /(?:青のり|青海苔|あおのり)/, quantity: 1, unit: "袋", location: "常温" },
  // のりの佃煮をのりとして拾わないよう前に置く
  { id: "nori-tsukudani", name: "のりの佃煮", pattern: /(?:のりの佃煮|海苔の佃煮|ごはんですよ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "nori", name: "のり", pattern: /(?:焼のり|焼き海苔|焼海苔|海苔|のり(?!の佃煮))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "hijiki", name: "ひじき", pattern: /(?:ひじき|ヒジキ|鹿尾菜)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "glass-noodles", name: "春雨", pattern: /(?:春雨|はるさめ|ハルサメ)/, quantity: 1, unit: "袋", location: "常温" },
  // とろろ昆布を昆布として拾わないよう前に置く
  // 刻み昆布を昆布として拾わないよう前に置く
  { id: "cut-kombu", name: "刻み昆布", pattern: /(?:刻み昆布|きざみ昆布|刻みこんぶ|きざみこんぶ|カット昆布)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "tororo-kombu", name: "とろろ昆布", pattern: /(?:とろろ昆布|トロロ昆布)/, quantity: 1, unit: "袋", location: "常温" },
  // 塩昆布を昆布として拾わないよう前に置く
  { id: "shio-kombu", name: "塩昆布", pattern: /(?:塩昆布|しお昆布)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "kombu", name: "昆布", pattern: /(?:だし昆布|出汁昆布|こんぶ|昆布(?!茶|巻))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "dried-sardine", name: "煮干し", pattern: /(?:煮干|にぼし|いりこ)/, quantity: 1, unit: "袋", location: "常温" },
  // 油は「ごま」より先に判定する
  { id: "sesame-oil", name: "ごま油", pattern: /(?:ごま油|ゴマ油|胡麻油|セサミオイル)/, quantity: 1, unit: "本", location: "常温" },
  { id: "olive-oil", name: "オリーブオイル", pattern: /(?:オリーブオイル|オリーブ油)/, quantity: 1, unit: "本", location: "常温" },
  { id: "salad-oil", name: "サラダ油", pattern: /(?:サラダ油|サラダオイル|調合油)/, quantity: 1, unit: "本", location: "常温" },
  { id: "sesame", name: "ごま", pattern: /(?:白ごま|黒ごま|いりごま|すりごま|ゴマ|胡麻)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "fu", name: "麩", pattern: /(?:小町麩|車麩|焼き麩|お麩)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "canned-corn", name: "コーン缶", pattern: /(?:コーン缶|ホールコーン|スイートコーン)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "boiled-soybeans", name: "大豆水煮", pattern: /(?:大豆水煮|蒸し大豆|ゆで大豆)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "shirataki", name: "しらたき", pattern: /(?:しらたき|シラタキ|白滝|糸こんにゃく)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "mixed-vegetables", name: "ミックスベジタブル", pattern: /(?:ミックスベジタブル|ミックスベジ)/, quantity: 1, unit: "袋", location: "冷凍" },
  { id: "takuan", name: "たくあん", pattern: /(?:たくあん|タクアン|沢庵)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "umeboshi", name: "梅干し", pattern: /(?:梅干|うめぼし)/, quantity: 1, unit: "個", location: "冷蔵" },
  // ここから シート14〜17 の食材
  { id: "avocado", name: "アボカド", pattern: /(?:アボカド|アボガド|あぼかど)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "baby-leaf", name: "ベビーリーフ", pattern: /(?:ベビーリーフ|ベビ-リ-フ)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "myoga", name: "みょうが", pattern: /(?:みょうが|ミョウガ|茗荷)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "mitsuba", name: "三つ葉", pattern: /(?:三つ葉|みつば|ミツバ|三葉)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "basil", name: "バジル", pattern: /(?:バジル|ばじる|スイートバジル)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "watercress", name: "クレソン", pattern: /(?:クレソン|くれそん)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "rucola", name: "ルッコラ", pattern: /(?:ルッコラ|るっこら|ロケット菜)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "shishito", name: "ししとう", pattern: /(?:ししとう|シシトウ|獅子唐)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "young-corn", name: "ヤングコーン", pattern: /(?:ヤングコーン|やんぐこーん|ベビーコーン)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "green-peas", name: "グリーンピース", pattern: /(?:グリーンピース|ぐりーんぴーす|実えんどう)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "yuzu", name: "ゆず", pattern: /(?:ゆず(?!ポン|こしょう|胡椒)|柚子(?!こしょう|胡椒))/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "persimmon", name: "柿", pattern: /(?:富有柿|次郎柿|柿(?!の種|ピー))/, quantity: 1, unit: "個", location: "常温" },
  { id: "chestnut", name: "栗", pattern: /(?:むき栗|甘栗|(?<!片)栗(?!粉))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "cherry", name: "さくらんぼ", pattern: /(?:さくらんぼ|サクランボ|チェリー|佐藤錦)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "dried-mango", name: "ドライマンゴー", pattern: /(?:ドライマンゴー|乾燥マンゴー|マンゴードライ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "mango", name: "マンゴー", pattern: /(?:マンゴー|まんごー)/, quantity: 1, unit: "個", location: "常温" },
  { id: "grapefruit", name: "グレープフルーツ", pattern: /(?:グレープフルーツ|グレープフル|ルビーグレープ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "lime", name: "ライム", pattern: /(?:ライム|らいむ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "fig", name: "いちじく", pattern: /(?:いちじく|イチジク|無花果)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "prune", name: "プルーン", pattern: /(?:プルーン|ぷるーん|干しプラム)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "pork-shoulder", name: "豚肩ロース", pattern: /(?:豚肩ロース|豚肩ろーす|(?<!牛)肩ロース)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "spare-ribs", name: "スペアリブ", pattern: /(?:スペアリブ|すぺありぶ|骨付き豚)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "chicken-liver", name: "鶏レバー", pattern: /(?:レバー|れば-)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "gizzard", name: "砂肝", pattern: /(?:砂肝|すなぎも|砂ぎも)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "salami", name: "サラミ", pattern: /(?:サラミ|さらみ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "chicken-wing-tip", name: "手羽先", pattern: /(?:手羽先|てばさき)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "lamb", name: "ラム肉", pattern: /(?:ラム肉|ラムチョップ|羊肉|マトン)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "char-siu", name: "チャーシュー", pattern: /(?:チャーシュー|焼豚|焼き豚|叉焼)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "mentaiko", name: "明太子", pattern: /(?:明太子|めんたいこ|辛子明太)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "shishamo", name: "ししゃも", pattern: /(?:ししゃも|シシャモ|柳葉魚)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "flatfish", name: "かれい", pattern: /(?:かれい|カレイ|鰈)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  { id: "sea-bream", name: "たい", pattern: /(?:真鯛|まだい|マダイ|鯛)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  { id: "bonito-fresh", name: "かつお", pattern: /(?:かつおたたき|かつお(?!節|ぶし|だし)|カツオ(?!節)|鰹(?!節))/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "swordfish", name: "めかじき", pattern: /(?:めかじき|メカジキ|旗魚|かじき)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  // あなごの蒲焼きをうなぎとして拾わないよう前に置く（うなぎのパターンに「蒲焼」がある）
  { id: "conger-eel", name: "あなご", pattern: /(?:あなご|アナゴ|穴子)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "eel", name: "うなぎ", pattern: /(?:うなぎ|ウナギ|鰻|蒲焼)/, quantity: 1, unit: "パック", location: "冷蔵" },
  // ここから シート18〜20 の食材
  { id: "chirimen", name: "ちりめんじゃこ", pattern: /(?:ちりめんじゃこ|ちりめん雑魚|ちりめん|じゃこ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "ikura", name: "いくら", pattern: /(?:いくら|イクラ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "crab", name: "かに", pattern: /(?:ずわいがに|ズワイガニ|たらばがに|タラバガニ|かに(?!かま)|カニ(?!カマ|風味))/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "hamaguri", name: "はまぐり", pattern: /(?:はまぐり|ハマグリ|蛤)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "mozuku", name: "もずく", pattern: /(?:もずく|モズク)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "ika-shiokara", name: "いかの塩辛", pattern: /(?:塩辛|しおから)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "margarine", name: "マーガリン", pattern: /(?:マーガリン|まーがりん)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "ganmodoki", name: "がんもどき", pattern: /(?:がんもどき|ガンモドキ|がんも)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "yuba", name: "湯葉", pattern: /(?:湯葉|ゆば)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "okara", name: "おから", pattern: /(?:おから|オカラ|卯の花)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "brown-rice", name: "玄米", pattern: /(?:玄米)/, quantity: 2000, unit: "g", location: "常温" },
  { id: "mochi-rice", name: "もち米", pattern: /(?:もち米|もちごめ|糯米)/, quantity: 1000, unit: "g", location: "常温" },
  { id: "rice-raw", name: "米", pattern: /(?:無洗米|白米|精米|コシヒカリ|あきたこまち|ひとめぼれ|米(?!粉|油|酢|味噌|びつ|麹|こうじ))/, quantity: 5000, unit: "g", location: "常温" },
  { id: "croissant", name: "クロワッサン", pattern: /(?:クロワッサン)/, quantity: 1, unit: "個", location: "常温" },
  { id: "bagel", name: "ベーグル", pattern: /(?:ベーグル)/, quantity: 1, unit: "個", location: "常温" },
  { id: "english-muffin", name: "イングリッシュマフィン", pattern: /(?:イングリッシュマフィン|マフィン)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "naan", name: "ナン", pattern: /(?:ナン(?!プラー)|ナンブレッド)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "tortilla", name: "トルティーヤ", pattern: /(?:トルティーヤ|トルティージャ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "penne", name: "ペンネ", pattern: /(?:ペンネ|ぺんね)/, quantity: 100, unit: "g", location: "常温" },
  { id: "bifun", name: "ビーフン", pattern: /(?:ビーフン|びーふん)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "kishimen", name: "きしめん", pattern: /(?:きしめん|キシメン)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "pancake-mix", name: "ホットケーキミックス", pattern: /(?:ホットケーキミックス|パンケーキミックス)/, quantity: 600, unit: "g", location: "常温" },
  { id: "okonomiyaki-flour", name: "お好み焼き粉", pattern: /(?:お好み焼き粉|お好み焼粉|おこのみ焼き粉)/, quantity: 400, unit: "g", location: "常温" },
  { id: "bread-flour", name: "強力粉", pattern: /(?:強力粉|きょうりき粉)/, quantity: 500, unit: "g", location: "常温" },
  { id: "shiratamako", name: "白玉粉", pattern: /(?:白玉粉|しらたま粉)/, quantity: 200, unit: "g", location: "常温" },
  // ここから シート21〜27 の食材
  { id: "oatmeal", name: "オートミール", pattern: /(?:オートミール|オーツ麦)/, quantity: 300, unit: "g", location: "常温" },
  { id: "granola", name: "グラノーラ", pattern: /(?:グラノーラ|グラノラ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "corn-flakes", name: "コーンフレーク", pattern: /(?:コーンフレーク|コーンフレ-ク)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "tenkasu", name: "天かす", pattern: /(?:天かす|揚げ玉|あげ玉)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "dried-soybeans", name: "大豆", pattern: /(?:乾燥大豆|大豆(?!水煮|油|粉))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "azuki", name: "小豆", pattern: /(?:小豆|あずき|アズキ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "chickpeas", name: "ひよこ豆", pattern: /(?:ひよこ豆|ヒヨコ豆|ガルバンゾ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "lentils", name: "レンズ豆", pattern: /(?:レンズ豆|れんず豆)/, quantity: 1, unit: "袋", location: "常温" },
  // 白きくらげをきくらげとして拾わないよう前に置く
  { id: "white-kikurage", name: "白きくらげ", pattern: /(?:白きくらげ|白キクラゲ|白木耳|しろきくらげ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "kikurage", name: "きくらげ", pattern: /(?:きくらげ|キクラゲ|木耳)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "kanten", name: "寒天", pattern: /(?:寒天|かんてん)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "gelatin", name: "ゼラチン", pattern: /(?:ゼラチン|ぜらちん)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "corned-beef", name: "コンビーフ", pattern: /(?:コンビーフ|コーンビーフ)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "spam", name: "スパム", pattern: /(?:スパム|ランチョンミート)/, quantity: 1, unit: "缶", location: "常温" },
  { id: "mixed-beans", name: "ミックスビーンズ", pattern: /(?:ミックスビーンズ|ミックスビ-ンズ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "nametake", name: "なめたけ", pattern: /(?:なめたけ|ナメタケ|えのき茸味付)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "anko", name: "あんこ", pattern: /(?:あんこ|こしあん|つぶあん|小倉あん)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "menma", name: "メンマ", pattern: /(?:メンマ|めんま|支那竹)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "zasai", name: "ザーサイ", pattern: /(?:ザーサイ|搾菜)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "rakkyo", name: "らっきょう", pattern: /(?:らっきょう|ラッキョウ|辣韮)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "fukujinzuke", name: "福神漬", pattern: /(?:福神漬|ふくじん漬)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "nozawana", name: "野沢菜", pattern: /(?:野沢菜|のざわ菜)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "frozen-seafood-mix", name: "シーフードミックス", pattern: /(?:シーフードミックス|シーフードミツクス)/, quantity: 1, unit: "袋", location: "冷凍" },
  { id: "frozen-potato", name: "冷凍ポテト", pattern: /(?:冷凍ポテト|フライドポテト|シューストリング)/, quantity: 1, unit: "袋", location: "冷凍" },
  { id: "coriander", name: "パクチー", pattern: /(?:パクチー|香菜|コリアンダー)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "moroheiya", name: "モロヘイヤ", pattern: /(?:モロヘイヤ|もろへいや)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "water-spinach", name: "空芯菜", pattern: /(?:空芯菜|空心菜|くうしんさい)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "nanohana", name: "菜の花", pattern: /(?:菜の花|なばな|菜花)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "snap-peas", name: "スナップえんどう", pattern: /(?:スナップえんどう|スナップエンドウ|スナックえんどう)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "winter-melon", name: "冬瓜", pattern: /(?:冬瓜|とうがん)/, quantity: 300, unit: "g", location: "冷蔵" },
  { id: "fuki", name: "ふき", pattern: /(?:ふき(?!のとう)|フキ(?!ノトウ)|蕗)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "salad-greens", name: "サラダ菜", pattern: /(?:サラダ菜|サラダナ)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "raspberry", name: "ラズベリー", pattern: /(?:ラズベリー|木苺)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "ume", name: "梅", pattern: /(?:青梅|梅(?!干|酒|肉|昆布|茶|びしお))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "loquat", name: "びわ", pattern: /(?:びわ|ビワ|枇杷)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "hassaku", name: "はっさく", pattern: /(?:はっさく|ハッサク|八朔)/, quantity: 1, unit: "個", location: "常温" },
  { id: "beef-tendon", name: "牛すじ", pattern: /(?:牛すじ|牛スジ|牛筋)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "beef-tongue", name: "牛タン", pattern: /(?:牛タン|牛たん|牛舌)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "horumon", name: "ホルモン", pattern: /(?:ホルモン|もつ(?!煮込)|モツ)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "chicken-skin", name: "鶏皮", pattern: /(?:鶏皮|とり皮|鳥皮)/, quantity: 100, unit: "g", location: "冷蔵" },
  { id: "duck", name: "鴨肉", pattern: /(?:鴨肉|合鴨|かも肉)/, quantity: 200, unit: "g", location: "冷蔵" },
  { id: "roast-beef", name: "ローストビーフ", pattern: /(?:ローストビーフ|ロ-ストビ-フ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "atka-mackerel", name: "ほっけ", pattern: /(?:ほっけ|ホッケ|𩸽)/, quantity: 1, unit: "枚", location: "冷蔵" },
  { id: "spanish-mackerel", name: "さわら", pattern: /(?:さわら|サワラ|鰆)/, quantity: 1, unit: "切れ", location: "冷蔵" },
  { id: "shirako", name: "白子", pattern: /(?:白子|しらこ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "kazunoko", name: "数の子", pattern: /(?:数の子|かずのこ|カズノコ)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "uni", name: "うに", pattern: /(?:生うに|うに(?!ゅ)|ウニ|雲丹)/, quantity: 1, unit: "パック", location: "冷蔵" },
  { id: "sour-cream", name: "サワークリーム", pattern: /(?:サワークリーム|サワ-クリ-ム)/, quantity: 1, unit: "個", location: "冷蔵" },
  { id: "rye-bread", name: "ライ麦パン", pattern: /(?:ライ麦パン|ライムギパン|ライブレッド)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "wonton-wrapper", name: "ワンタンの皮", pattern: /(?:ワンタンの皮|わんたんの皮|雲呑の皮)/, quantity: 1, unit: "袋", location: "冷蔵" },
  { id: "pho-noodles", name: "フォー", pattern: /(?:フォー麺|ライスヌードル|フォー(?!ク|ル|マ|ラ))/, quantity: 1, unit: "袋", location: "常温" },
  { id: "pie-sheet", name: "パイシート", pattern: /(?:パイシート|冷凍パイ生地)/, quantity: 1, unit: "袋", location: "冷凍" },
  { id: "corn-starch", name: "コーンスターチ", pattern: /(?:コーンスターチ|コ-ンスタ-チ)/, quantity: 200, unit: "g", location: "常温" },
  { id: "almond", name: "アーモンド", pattern: /(?:アーモンド|ア-モンド)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "walnut", name: "くるみ", pattern: /(?:くるみ|クルミ|胡桃)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "cashew", name: "カシューナッツ", pattern: /(?:カシューナッツ|カシュ-ナッツ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "barley", name: "押し麦", pattern: /(?:押し麦|押麦|もち麦)/, quantity: 500, unit: "g", location: "常温" },
  { id: "couscous", name: "クスクス", pattern: /(?:クスクス)/, quantity: 300, unit: "g", location: "常温" },
  { id: "kanpyo", name: "かんぴょう", pattern: /(?:かんぴょう|カンピョウ|干瓢|乾瓢)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "tazukuri", name: "田作り", pattern: /(?:田作り|たづくり|たつくり|ごまめ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "aosa", name: "あおさ", pattern: /(?:あおさ|アオサ|石蓴)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "dashi-powder", name: "だしの素", pattern: /(?:だしの素|ダシの素|出汁の素|顆粒だし|顆粒ダシ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "dashi-pack", name: "出汁パック", pattern: /(?:出汁パック|だしパック|ダシパック|だし袋)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "pistachio", name: "ピスタチオ", pattern: /(?:ピスタチオ|ぴすたちお)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "pine-nut", name: "松の実", pattern: /(?:松の実|まつの実|マツの実|松実)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "furikake", name: "ふりかけ", pattern: /(?:ふりかけ|フリカケ)/, quantity: 1, unit: "袋", location: "常温" },
  // 一般語は既存の具体的な加工品・複合語より後に置く
  { id: "soy-sauce", name: "醤油", pattern: /(?:醤油|しょうゆ|しょう油|正油)/, quantity: 1, unit: "本", location: "常温" },
  { id: "mayonnaise", name: "マヨネーズ", pattern: /(?:マヨネーズ|マヨネ-ズ|マヨネ－ズ|マヨ)/, quantity: 1, unit: "本", location: "冷蔵" },
  { id: "consomme", name: "コンソメ", pattern: /(?:コンソメ|コンソメキューブ|固形コンソメ)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "curry-roux", name: "カレールー", pattern: /(?:カレールー|カレールウ|カレー・ルー|カレー・ルウ)/, quantity: 1, unit: "個", location: "常温" },
  { id: "pepper", name: "こしょう", pattern: /(?:(?<!柚子|ゆず|ユズ)(?:こしょう|コショウ|胡椒)|ブラックペッパー|ホワイトペッパー)/, quantity: 1, unit: "個", location: "常温" },
  { id: "honey", name: "はちみつ", pattern: /(?:はちみつ|ハチミツ|蜂蜜)/, quantity: 1, unit: "個", location: "常温" },
  { id: "sugar", name: "砂糖", pattern: /(?:砂糖|さとう|サトウ|上白糖|グラニュー糖|三温糖)/, quantity: 1, unit: "袋", location: "常温" },
  { id: "mirin", name: "みりん", pattern: /(?:みりん|ミリン|味醂|本みりん|みりん風調味料)/, quantity: 1, unit: "本", location: "常温" },
  { id: "cooking-sake", name: "料理酒", pattern: /(?:料理酒|調理酒|加塩料理酒|清酒)/, quantity: 1, unit: "本", location: "常温" },
  { id: "sauce", name: "ソース", pattern: /(?:中濃ソース|ウスターソース|とんかつソース|お好みソース|焼きそばソース|ソース)/, quantity: 1, unit: "本", location: "常温" },
  { id: "salt", name: "塩", pattern: /(?:食塩|あら塩|粗塩|岩塩|塩|しお|ソルト)/, quantity: 1, unit: "袋", location: "常温" }
];

const ILLUSTRATED_INGREDIENT_CATEGORIES = [
  {
    id: "vegetables",
    name: "野菜・きのこ",
    note: "葉物・根菜・果菜・きのこ・薬味",
    representatives: ["cabbage", "carrot", "tomato"],
    groups: [
      {
        name: "葉物・茎",
        items: ["cabbage", "chinese-cabbage", "lettuce", "sunny-lettuce", "salad-greens", "baby-leaf", "spinach", "komatsuna", "bok-choy", "mizuna", "shungiku", "moroheiya", "water-spinach", "nanohana", "rucola", "watercress", "celery", "asparagus", "broccoli", "cauliflower", "brussels-sprouts", "green-onion", "green-onion-small", "garlic-chives", "bean-sprouts", "pea-sprouts", "kaiware", "broccoli-sprout", "fuki", "cut-vegetables"]
      },
      {
        name: "根菜・いも",
        items: ["carrot", "onion", "red-onion", "potato", "sweet-potato", "taro", "yam", "radish", "turnip", "radish-red", "burdock", "lotus-root", "boiled-bamboo"]
      },
      {
        name: "果菜・豆",
        items: ["tomato", "cherry-tomato", "cucumber", "eggplant", "bell-pepper", "paprika", "shishito", "pumpkin", "zucchini", "winter-melon", "bitter-melon", "okra", "corn", "young-corn", "green-beans", "snow-peas", "snap-peas", "edamame", "broad-beans", "green-peas", "avocado"]
      },
      {
        name: "きのこ",
        items: ["mushroom", "shiitake", "enoki", "maitake", "shimeji-white", "eringi", "mushroom-button", "nameko"]
      },
      {
        name: "香味・薬味",
        items: ["garlic", "ginger", "new-ginger", "shiso", "myoga", "mitsuba", "parsley", "basil", "coriander", "yuzu"]
      }
    ]
  },
  {
    id: "fruit",
    name: "果物",
    note: "定番・柑橘・ベリー",
    representatives: ["banana", "apple"],
    groups: [
      {
        name: "定番",
        items: ["banana", "apple", "mandarin", "strawberry", "grape", "pear", "western-pear", "peach", "persimmon", "kiwi", "melon", "watermelon", "pineapple", "mango", "loquat", "plum", "cherry", "fig", "chestnut", "ume"]
      },
      {
        name: "柑橘",
        items: ["orange", "grapefruit", "lemon", "lime", "hassaku"]
      },
      {
        name: "ベリー・ドライ",
        items: ["blueberry", "raspberry", "raisin", "prune"]
      }
    ]
  },
  {
    id: "meat",
    name: "肉",
    note: "豚・鶏・牛・ひき肉・加工肉",
    representatives: ["pork", "chicken", "beef"],
    groups: [
      {
        name: "豚",
        items: ["pork", "pork-belly", "pork-loin", "pork-shoulder", "spare-ribs"]
      },
      {
        name: "鶏",
        items: ["chicken", "chicken-thigh", "chicken-tender", "chicken-wing", "chicken-wing-tip", "chicken-skin", "chicken-liver", "gizzard"]
      },
      {
        name: "牛",
        items: ["beef", "beef-steak", "beef-tongue", "beef-tendon", "horumon"]
      },
      {
        name: "ひき肉",
        items: ["ground-meat", "pork-mince", "chicken-mince"]
      },
      {
        name: "加工肉",
        items: ["bacon", "bacon-block", "ham", "sausage", "prosciutto", "salami", "char-siu", "roast-beef"]
      },
      {
        name: "その他",
        items: ["duck", "lamb"]
      }
    ]
  },
  {
    id: "seafood",
    name: "魚介",
    note: "魚・貝・練り物・魚卵",
    representatives: ["salmon", "mackerel", "shrimp"],
    groups: [
      {
        name: "魚",
        items: ["salmon", "mackerel", "yellowtail", "cod", "saury", "horse-mackerel", "sardine", "tuna-sashimi", "bonito-fresh", "swordfish", "flatfish", "sea-bream", "spanish-mackerel", "atka-mackerel", "shishamo", "eel", "conger-eel", "dried-aji", "shime-saba"]
      },
      {
        name: "貝・えび・いか・たこ",
        items: ["shrimp", "sweet-shrimp", "squid", "octopus", "clam", "freshwater-clam", "hamaguri", "scallop", "oyster", "crab"]
      },
      {
        name: "練り物",
        items: ["chikuwa", "kamaboko", "hanpen", "satsumaage", "kanikama", "fish-sausage"]
      },
      {
        name: "魚卵・魚加工",
        items: ["tuna", "cod-roe", "mentaiko", "ikura", "kazunoko", "shirako", "uni", "salmon-flake", "whitebait", "chirimen", "ika-shiokara"]
      }
    ]
  },
  {
    id: "protein",
    name: "卵・乳・大豆",
    note: "卵・乳製品・豆腐",
    representatives: ["eggs", "milk", "tofu"],
    groups: [
      {
        name: "卵",
        items: ["eggs", "quail-egg", "onsen-egg", "tamago-tofu"]
      },
      {
        name: "乳製品",
        items: ["milk", "yogurt", "cheese", "sliced-cheese", "pizza-cheese", "cream-cheese", "mozzarella", "powdered-cheese", "camembert", "blue-cheese", "cottage-cheese", "butter", "margarine", "fresh-cream", "sour-cream", "condensed-milk"]
      },
      {
        name: "豆腐・大豆製品",
        items: ["tofu", "grilled-tofu", "thick-fried-tofu", "fried-tofu", "ganmodoki", "koya-tofu", "yuba", "okara", "natto", "soy-milk", "miso"]
      }
    ]
  },
  {
    id: "staples",
    name: "主食・粉",
    note: "米・パン・麺・皮・粉",
    representatives: ["rice", "bread", "udon"],
    groups: [
      {
        name: "米・パン",
        items: ["rice", "rice-raw", "mochi-rice", "brown-rice", "mochi", "bread", "butter-roll", "french-bread", "croissant", "bagel", "english-muffin", "rye-bread", "naan", "tortilla"]
      },
      {
        name: "麺",
        items: ["pasta", "fresh-pasta", "fettuccine", "linguine", "capellini", "penne", "fusilli", "farfalle", "macaroni", "lasagna", "gnocchi", "ravioli", "udon", "frozen-udon", "soba", "somen", "hiyamugi", "kishimen", "yakisoba-noodles", "chinese-noodles", "instant-ramen", "cup-noodles", "bifun", "pho-noodles"]
      },
      {
        name: "皮",
        items: ["gyoza-wrapper", "wonton-wrapper", "spring-roll-wrapper", "pie-sheet"]
      },
      {
        name: "粉",
        items: ["flour", "bread-flour", "potato-starch", "corn-starch", "tempura-flour", "okonomiyaki-flour", "pancake-mix", "shiratamako", "buckwheat-flour", "breadcrumbs", "tenkasu"]
      },
      {
        name: "シリアル・雑穀",
        items: ["oatmeal", "granola", "corn-flakes", "barley", "couscous"]
      }
    ]
  },
  {
    id: "dry",
    name: "乾物・海藻・豆",
    note: "海藻・乾物・豆・ナッツ",
    representatives: ["wakame", "sesame"],
    groups: [
      {
        name: "海藻",
        items: ["wakame", "kombu", "cut-kombu", "tororo-kombu", "nori", "aonori", "aosa", "hijiki", "mozuku", "mekabu", "shio-kombu"]
      },
      {
        name: "乾物",
        items: ["bonito", "dashi-pack", "dried-sardine", "tazukuri", "dried-scallop", "surume", "dried-shiitake", "dried-radish", "kanpyo", "dried-sweet-potato", "kikurage", "white-kikurage", "sakura-shrimp", "dried-shrimp", "dried-tomato", "kanten", "gelatin", "fu", "glass-noodles", "sesame", "dried-mango"]
      },
      {
        name: "豆",
        items: ["dried-soybeans", "azuki", "chickpeas", "lentils", "soy-meat"]
      },
      {
        name: "ナッツ",
        items: ["almond", "peanut", "walnut", "cashew", "pistachio", "pine-nut"]
      }
    ]
  },
  {
    id: "processed",
    name: "缶詰・加工",
    note: "缶詰・瓶詰・こんにゃく",
    representatives: ["canned-tomato", "konnyaku"],
    groups: [
      {
        name: "缶詰",
        items: ["canned-tomato", "canned-tomato-cut", "canned-pineapple", "meat-sauce", "white-sauce", "demiglace", "canned-corn", "mushroom-can", "canned-mackerel", "saury-can", "canned-sardine", "oil-sardine", "anchovy", "clam-can", "scallop-can", "crab-can", "canned-peach", "mandarin-can", "coconut-milk", "yakitori-can", "corned-beef", "spam"]
      },
      {
        name: "瓶詰・その他",
        items: ["tomato-puree", "nametake", "nori-tsukudani", "peanut-butter", "anko", "mixed-beans", "boiled-soybeans", "menma", "zasai", "konnyaku", "shirataki", "furikake"]
      }
    ]
  },
  {
    id: "pickles",
    name: "漬物",
    note: "キムチ・梅干し",
    representatives: ["kimchi", "umeboshi"],
    groups: [
      {
        name: "漬物",
        items: ["kimchi", "takuan", "umeboshi", "nozawana", "beni-shoga", "rakkyo", "fukujinzuke"]
      }
    ]
  },
  {
    id: "frozen",
    name: "冷凍",
    note: "冷凍野菜・シーフード",
    representatives: ["mixed-vegetables", "frozen-potato"],
    groups: [
      {
        name: "冷凍",
        items: ["mixed-vegetables", "frozen-seafood-mix", "frozen-potato"]
      }
    ]
  },
  {
    id: "seasoning",
    name: "調味料",
    note: "醤油・油・粉・ルー",
    representatives: ["soy-sauce", "salt"],
    groups: [
      { name: "液体調味料", items: ["soy-sauce", "sauce", "ponzu", "mentsuyu", "vinegar", "mirin", "cooking-sake"] },
      { name: "油", items: ["sesame-oil", "olive-oil", "salad-oil"] },
      { name: "チューブ・瓶", items: ["mayonnaise", "ketchup", "honey", "jam"] },
      { name: "粉・だし・ルー", items: ["salt", "sugar", "pepper", "dashi-powder", "consomme", "curry-roux"] }
    ]
  }
];

const FRESHNESS_GROUP_DAYS = {
  "vegetables/葉物・茎": 4,
  "vegetables/根菜・いも": 14,
  "vegetables/果菜・豆": 7,
  "vegetables/きのこ": 5,
  "vegetables/香味・薬味": 7,
  "fruit/定番": 7,
  "fruit/柑橘": 14,
  "fruit/ベリー・ドライ": 4,
  "meat/豚": 3,
  "meat/鶏": 2,
  "meat/牛": 3,
  "meat/ひき肉": 2,
  "meat/加工肉": 7,
  "meat/その他": 3,
  "seafood/魚": 2,
  "seafood/貝・えび・いか・たこ": 2,
  "seafood/練り物": 7,
  "seafood/魚卵・魚加工": 5
};

const FRESHNESS_DAYS_BY_ID = {
  "bean-sprouts": 2, "cut-vegetables": 2, "salad-greens": 3, "baby-leaf": 3,
  kaiware: 3, "broccoli-sprout": 3, "pea-sprouts": 4, nameko: 3,
  potato: 30, onion: 30, "sweet-potato": 30, taro: 14, yam: 14, pumpkin: 14,
  garlic: 60, ginger: 21, "new-ginger": 14,
  avocado: 4, banana: 5, lemon: 21, lime: 21, chestnut: 14, ume: 5,
  raisin: null, prune: null
};

const FRESHNESS_GROUP_BY_ID = new Map(
  ILLUSTRATED_INGREDIENT_CATEGORIES.flatMap((category) =>
    category.groups.flatMap((group) =>
      group.items.map((id) => [id, `${category.id}/${group.name}`])
    )
  )
);

function freshnessDays(id) {
  if (Object.prototype.hasOwnProperty.call(FRESHNESS_DAYS_BY_ID, id)) {
    return FRESHNESS_DAYS_BY_ID[id];
  }
  return FRESHNESS_GROUP_DAYS[FRESHNESS_GROUP_BY_ID.get(id)] ?? null;
}

// 文字入力された名前から食材idを引く表。
//
// ★ALIASES は手で足した別名（「たまご」→ eggs など）だけを持っていて、
// カタログの正式名そのものは入っていなかった。そのため「サニーレタス」のように
// 一覧にある食材の名前を打っても引けず、custom- の新しい食材が作られていた。
// 絵が出ないだけでなく、レシピの材料としても認識されない。
// カタログの正式名を土台にして、手で足した別名を上から重ねる（別名のほうが優先）。
const NAME_TO_ID = new Map([
  ...RECEIPT_RULES.map((rule) => [rule.name, rule.id]),
  ...ALIASES
]);

const INVENTORY_UNITS = ["個", "g", "ml", "本", "株", "袋", "パック", "膳", "切れ", "缶", "枚"];
const INVENTORY_LOCATIONS = ["冷蔵", "冷凍", "常温"];
const DEFAULT_STORAGE_SHELF_COUNTS = { 冷蔵: 3, 冷凍: 1, 常温: 2 };
const STORAGE_SHELF_LIMITS = {
  冷蔵: { min: 1, max: 5 },
  冷凍: { min: 1, max: 3 },
  常温: { min: 1, max: 4 }
};
const STORAGE_SHELF_CAPACITIES = { 冷蔵: 6, 冷凍: 6, 常温: 6 };

const state = {
  inventory: [],
  shopping: [],
  cookingHistory: [],
  historyVisibleCount: HISTORY_PAGE_SIZE,
  location: "すべて",
  servings: 1,
  priority: "no-shop",
  selectedOptionals: {},
  visibleRecipeCount: RECIPE_PAGE_SIZE,
  storageEnabled: true,
  lastUndo: null,
  toastTimer: null,
  receiptCandidates: [],
  receiptWorker: null,
  receiptRunId: 0,
  receiptObjectUrl: null,
  fridgeDrag: null,
  suppressFridgeClickUntil: 0,
  shelfCounts: { ...DEFAULT_STORAGE_SHELF_COUNTS },
  ingredientNameSuggestion: null,
  dismissedIngredientSuggestionFor: "",
  ingredientTargetShelf: null,
  ingredientPreferredLocation: null,
  ingredientPickerCategory: null,
  selectedIngredientCatalogId: null,
  shoppingPickerCategory: null,
  recentIngredientIds: [],
  pendingCookRecipeId: null,
  pendingCookServings: 1,
  pendingCookExtras: [],
  // 作る前に量を確認した結果。{ 食材id: true（ある）/ false（足りない）}。
  // ダイアログを開くたびに空へ戻す（前回の答えを持ち回らない）
  cookAmountAnswers: {},
  editingHistoryId: null,
  historyEditChanges: [],
  // 初回登録。step 1 は主役選び、step 2 は候補の分かれ目を聞く
  onboarding: { step: 1, leads: [], extras: [] },
  // 売り場を順番に回って足していく画面。added はこの画面で入れたぶん
  refine: { index: 0, added: [] },
  // ホームで見せている収納。fridge（冷蔵・冷凍）か pantry（常温）
  fridgeTab: "fridge",
  // 読み込もうとしているファイルの中身。置き換えるまで在庫には触らない
  pendingBackup: null,
  // 同期の版と「まだ送っていない」印。実体とは別に持つ
  syncMeta: {},
  // 共有している冷蔵庫。fridgeId が空なら共有していない
  share: { fridgeId: "", seq: 0, syncedAt: "" },
  // 招待リンクを開いただけでは参加しない。確認画面で選ぶまでIDだけ預かる
  pendingShareJoinId: "",
  shareJoinReturnToSettings: false,
  syncing: false,
  // 端末名は本人が付ける表示名。deviceId は同名の端末を区別するためだけに使い、
  // アカウントや認証の代わりにはしない
  device: { id: "", name: "" },
  settings: { ...DEFAULT_SETTINGS }
};

const elements = {
  appVersion: document.querySelector("#app-version"),
  appHeader: document.querySelector("#app-header"),
  headerSync: document.querySelector("#header-sync"),
  headerSyncLabel: document.querySelector("#header-sync-label"),
  openSettings: document.querySelector("#open-settings"),
  settingsDialog: document.querySelector("#settings-dialog"),
  closeSettings: document.querySelector("#close-settings"),
  settingShowNutrition: document.querySelector("#setting-show-nutrition"),
  nutritionHelp: document.querySelector("#nutrition-help"),
  settingsNutritionNote: document.querySelector("#settings-nutrition-note"),
  deviceName: document.querySelector("#device-name"),
  fridgeScene: document.querySelector("#fridge-scene"),
  expiryAlert: document.querySelector("#expiry-alert"),
  expiryAlertTitle: document.querySelector("#expiry-alert-title"),
  expiryAlertSummary: document.querySelector("#expiry-alert-summary"),
  expiryAlertList: document.querySelector("#expiry-alert-list"),
  goInventoryList: document.querySelector("#go-inventory-list"),
  goFridgeScene: document.querySelector("#go-fridge-scene"),
  managementExpiring: document.querySelector("#management-expiring"),
  managementExpiringTitle: document.querySelector("#management-expiring-title"),
  managementExpiringList: document.querySelector("#management-expiring-list"),
  inventoryList: document.querySelector("#inventory-list"),
  finishedSection: document.querySelector("#finished-section"),
  finishedCount: document.querySelector("#finished-count"),
  finishedList: document.querySelector("#finished-list"),
  recipeList: document.querySelector("#recipe-list"),
  recipeMore: document.querySelector("#recipe-more"),
  showMoreRecipes: document.querySelector("#show-more-recipes"),
  recipeVisibleCount: document.querySelector("#recipe-visible-count"),
  todayIngredientTrigger: document.querySelector("#today-ingredient-trigger"),
  todayIngredientName: document.querySelector("#today-ingredient-name"),
  todayIngredientArt: document.querySelector("#today-ingredient-art"),
  todayIngredientDialog: document.querySelector("#today-ingredient-dialog"),
  todayIngredientOptions: document.querySelector("#today-ingredient-options"),
  seasonalGuide: document.querySelector("#seasonal-guide"),
  closeTodayIngredientDialog: document.querySelector("#close-today-ingredient-dialog"),
  clearTodayIngredient: document.querySelector("#clear-today-ingredient"),
  inventoryView: document.querySelector("#inventory-view"),
  managementView: document.querySelector("#management-view"),
  suggestionsView: document.querySelector("#suggestions-view"),
  shoppingView: document.querySelector("#shopping-view"),
  historyView: document.querySelector("#history-view"),
  cookingHistoryList: document.querySelector("#cooking-history-list"),
  shoppingOverview: document.querySelector("#shopping-overview"),
  shoppingForm: document.querySelector("#shopping-form"),
  shoppingName: document.querySelector("#shopping-name"),
  shoppingQuantity: document.querySelector("#shopping-quantity"),
  shoppingQuantityRange: document.querySelector("#shopping-quantity-range"),
  shoppingUnit: document.querySelector("#shopping-unit"),
  shoppingCategoryLayer: document.querySelector("#shopping-category-layer"),
  shoppingCategoryGrid: document.querySelector("#shopping-category-grid"),
  shoppingItemLayer: document.querySelector("#shopping-item-layer"),
  shoppingPickerBack: document.querySelector("#shopping-picker-back"),
  shoppingPickerCategoryTitle: document.querySelector("#shopping-picker-category-title"),
  shoppingFoodGrid: document.querySelector("#shopping-food-grid"),
  shoppingRecommendations: document.querySelector("#shopping-recommendations"),
  shoppingList: document.querySelector("#shopping-list"),
  shoppingNavCount: document.querySelector("#shopping-nav-count"),
  clearBought: document.querySelector("#clear-bought"),
  dialog: document.querySelector("#ingredient-dialog"),
  form: document.querySelector("#ingredient-form"),
  dialogTitle: document.querySelector("#dialog-title"),
  ingredientId: document.querySelector("#ingredient-id"),
  ingredientPicker: document.querySelector("#ingredient-picker"),
  ingredientCategoryLayer: document.querySelector("#ingredient-category-layer"),
  ingredientCategoryGrid: document.querySelector("#ingredient-category-grid"),
  ingredientItemLayer: document.querySelector("#ingredient-item-layer"),
  ingredientItemGrid: document.querySelector("#ingredient-item-grid"),
  ingredientPickerCategoryTitle: document.querySelector("#ingredient-picker-category-title"),
  ingredientManualMode: document.querySelector("#ingredient-manual-mode"),
  ingredientPickerBack: document.querySelector("#ingredient-picker-back"),
  ingredientPickerReselect: document.querySelector("#ingredient-picker-reselect"),
  ingredientDetails: document.querySelector("#ingredient-details"),
  selectedIngredientPreview: document.querySelector("#selected-ingredient-preview"),
  ingredientAddShortcuts: document.querySelector("#ingredient-add-shortcuts"),
  ingredientReceiptShortcut: document.querySelector("#ingredient-receipt-shortcut"),
  ingredientNameField: document.querySelector("#ingredient-name-field"),
  ingredientName: document.querySelector("#ingredient-name"),
  nameSuggestion: document.querySelector("#name-suggestion"),
  suggestedIngredientName: document.querySelector("#suggested-ingredient-name"),
  keepIngredientName: document.querySelector("#keep-ingredient-name"),
  acceptIngredientName: document.querySelector("#accept-ingredient-name"),
  ingredientQuantity: document.querySelector("#ingredient-quantity"),
  ingredientQuantityRange: document.querySelector("#ingredient-quantity-range"),
  ingredientUnit: document.querySelector("#ingredient-unit"),
  ingredientLocation: document.querySelector("#ingredient-location"),
  ingredientExpiry: document.querySelector("#ingredient-expiry"),
  ingredientPriority: document.querySelector("#ingredient-priority"),
  consumeIngredient: document.querySelector("#consume-ingredient"),
  discardIngredient: document.querySelector("#discard-ingredient"),
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
  receiptRaw: document.querySelector("#receipt-raw"),
  receiptRawText: document.querySelector("#receipt-raw-text"),
  receiptError: document.querySelector("#receipt-error"),
  receiptErrorMessage: document.querySelector("#receipt-error-message"),
  addReceiptCandidates: document.querySelector("#add-receipt-candidates"),
  cookConfirmDialog: document.querySelector("#cook-confirm-dialog"),
  cookConfirmForm: document.querySelector("#cook-confirm-form"),
  cookConfirmRecipe: document.querySelector("#cook-confirm-recipe"),
  cookServingOptions: document.querySelector("#cook-serving-options"),
  cookConfirmIngredients: document.querySelector("#cook-confirm-ingredients"),
  cookConfirmNutrition: document.querySelector("#cook-confirm-nutrition"),
  cookExtraItem: document.querySelector("#cook-extra-item"),
  cookExtraQuantity: document.querySelector("#cook-extra-quantity"),
  cookExtraUnit: document.querySelector("#cook-extra-unit"),
  cookExtraAdd: document.querySelector("#cook-extra-add"),
  cookExtraList: document.querySelector("#cook-extra-list"),
  historyEditDialog: document.querySelector("#history-edit-dialog"),
  historyEditForm: document.querySelector("#history-edit-form"),
  historyEditRecipe: document.querySelector("#history-edit-recipe"),
  historyEditIngredients: document.querySelector("#history-edit-ingredients"),
  historyEditAddItem: document.querySelector("#history-edit-add-item"),
  historyEditAddQuantity: document.querySelector("#history-edit-add-quantity"),
  historyEditAddUnit: document.querySelector("#history-edit-add-unit"),
  historyEditAdd: document.querySelector("#history-edit-add"),
  historyEditMessage: document.querySelector("#history-edit-message"),
  saveHistoryEdit: document.querySelector("#save-history-edit"),
  bottomNav: document.querySelector(".bottom-nav"),
  onboardingView: document.querySelector("#onboarding-view"),
  onboardingStepLabel: document.querySelector("#onboarding-step-label"),
  onboardingTitle: document.querySelector("#onboarding-title"),
  onboardingLead: document.querySelector("#onboarding-lead"),
  onboardingLeads: document.querySelector("#onboarding-leads"),
  onboardingExtras: document.querySelector("#onboarding-extras"),
  onboardingPreview: document.querySelector("#onboarding-preview"),
  onboardingExtraGrid: document.querySelector("#onboarding-extra-grid"),
  onboardingSkip: document.querySelector("#onboarding-skip"),
  onboardingNext: document.querySelector("#onboarding-next"),
  shareNote: document.querySelector("#share-note"),
  privacyNotes: [
    document.querySelector("#privacy-note-inventory"),
    document.querySelector("#privacy-note-shopping"),
    document.querySelector("#privacy-note-history")
  ],
  shareOff: document.querySelector("#share-off"),
  shareOn: document.querySelector("#share-on"),
  shareCreate: document.querySelector("#share-create"),
  shareJoinId: document.querySelector("#share-join-id"),
  shareJoinGo: document.querySelector("#share-join-go"),
  shareJoinDialog: document.querySelector("#share-join-dialog"),
  shareJoinIntro: document.querySelector("#share-join-intro"),
  shareJoinCounts: document.querySelector("#share-join-counts"),
  shareJoinReplace: document.querySelector("#share-join-replace"),
  shareJoinMerge: document.querySelector("#share-join-merge"),
  shareJoinWarning: document.querySelector("#share-join-warning"),
  shareJoinStatus: document.querySelector("#share-join-status"),
  shareJoinCancel: document.querySelector("#share-join-cancel"),
  shareJoinCancelIcon: document.querySelector("#share-join-cancel-icon"),
  shareLink: document.querySelector("#share-link"),
  shareCopy: document.querySelector("#share-copy"),
  shareNow: document.querySelector("#share-now"),
  shareStatus: document.querySelector("#share-status"),
  shareStop: document.querySelector("#share-stop"),
  shareMessage: document.querySelector("#share-message"),
  exportData: document.querySelector("#export-data"),
  importData: document.querySelector("#import-data"),
  importFile: document.querySelector("#import-file"),
  importPreview: document.querySelector("#import-preview"),
  importPreviewSummary: document.querySelector("#import-preview-summary"),
  importCancel: document.querySelector("#import-cancel"),
  importApply: document.querySelector("#import-apply"),
  importError: document.querySelector("#import-error"),
  refineView: document.querySelector("#refine-view"),
  refineProgress: document.querySelector("#refine-progress"),
  refineTitle: document.querySelector("#refine-title"),
  refineGrid: document.querySelector("#refine-grid"),
  refineNext: document.querySelector("#refine-next"),
  refineQuit: document.querySelector("#refine-quit"),
  openRefine: document.querySelector("#open-refine"),
  refineEntryNote: document.querySelector("#refine-entry-note"),
  dayAfterCheck: document.querySelector("#day-after-check"),
  dayAfterLead: document.querySelector("#day-after-lead"),
  dayAfterList: document.querySelector("#day-after-list"),
  dayAfterSkip: document.querySelector("#day-after-skip"),
  sampleNotice: document.querySelector("#sample-notice"),
  sampleNoticeList: document.querySelector("#sample-notice-list"),
  sampleNoticeKeep: document.querySelector("#sample-notice-keep"),
  sampleNoticeClear: document.querySelector("#sample-notice-clear"),
  cookConfirmMessage: document.querySelector("#cook-confirm-message"),
  cookFallback: document.querySelector("#cook-fallback"),
  cookFallbackSingle: document.querySelector("#cook-fallback-single"),
  cookFallbackAnyway: document.querySelector("#cook-fallback-anyway"),
  confirmCook: document.querySelector("#confirm-cook"),
  toast: document.querySelector("#toast"),
  toastMessage: document.querySelector("#toast-message"),
  toastAction: document.querySelector("#toast-action"),
  prioritySelect: document.querySelector("#priority-select")
};

function markStorageUnavailable() {
  state.storageEnabled = false;
  showToast("データを保存できません");
}

function loadInventory() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage自体が使えない。サンプルは入れない（提案が実際の冷蔵庫と無関係になる）
    state.inventory = [];
    markStorageUnavailable();
    return;
  }
  if (!saved) {
    // 初回はサンプルを入れない。他人の5品が入っていると、最初の料理提案が
    // 実際の冷蔵庫と無関係になる。代わりに初回登録へ案内する
    state.inventory = [];
    state.needsOnboarding = true;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(saved);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) {
    state.inventory = parsed;
    return;
  }
  // 壊れデータをサンプル5品で置き換えない。原本を退避してから空で始め、本人に知らせる。
  // 退避キーは上書き保存（読めた最後の壊れデータが1件残ればよい）
  try {
    localStorage.setItem(`${STORAGE_KEY}.corrupt-backup`, saved);
  } catch {
    // 退避に失敗しても起動は続ける
  }
  state.inventory = [];
  state.needsOnboarding = true;
  showToast("保存されていた在庫データを読み込めず、空の状態から始めました");
}

// 保存済みデータに残っているサンプルの5品。印が付いていない古いデータでも
// 拾えるよう、数量・単位・場所が初期値のままかどうかも見る。
// **一致しないものは触らない**（本人が同じ食材を足していることがある）。
function untouchedSampleItems() {
  return state.inventory.filter((item) => {
    const sample = DEFAULT_INVENTORY.find((candidate) => candidate.id === item.id);
    if (!sample) return false;
    if (item.origin === SAMPLE_ORIGIN) return true;
    return item.quantity === sample.quantity
      && item.unit === sample.unit
      && item.location === sample.location
      && item.active !== false;
  });
}

// ---- この端末の名前 ------------------------------------------------------
// 自動取得した機種名はブラウザから安定して得られないため、本人が分かる名前を
// 付ける。未設定でも区別できるよう、ランダムIDの末尾を短い既定名にする。
function makeDeviceId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultDeviceName(id) {
  const suffix = String(id).replaceAll("-", "").slice(-4).toUpperCase() || "0000";
  return `端末 ${suffix}`;
}

function loadDevice() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  const id = typeof saved?.id === "string" && saved.id ? saved.id : makeDeviceId();
  const name = typeof saved?.name === "string" && saved.name.trim()
    ? saved.name.trim().slice(0, 30)
    : defaultDeviceName(id);
  state.device = { id, name };
  persistDevice();
}

function persistDevice() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(state.device));
  } catch {
    markStorageUnavailable();
  }
}

function currentChangeAttribution() {
  return {
    changedAt: new Date().toISOString(),
    changedBy: { id: state.device.id, name: state.device.name }
  };
}

// ---- 同期の下ごしらえ（1品1行として扱う） ---------------------------------
// 二人で1つの冷蔵庫を共有する仕組み（SUPABASE_SETUP.md）は、食材1品ごとに
// 1行を持ち、行ごとに「サーバーで何版か」を申告して送る。いまの保存は配列を
// 丸ごと1件として書いているので、その形へ寄せる必要がある。
//
// ★実体（在庫アイテムなど）には同期用の項目を足さない。版・印・最終変更端末は
// 別の表で持つ。食材やレシピの判定へ同期情報を混ぜないため。
//
// ★どこで何が変わったかを、変更のたびに記録しない。保存のたびに前回の内容と
// 比べて差分を出す。在庫を消す場所がアプリ内に7箇所あり、全部へ印を付ける
// 細工を入れると、足し忘れが必ず起きるため。
const SYNC_STORAGE_KEY = "fridge-leftovers-sync-v1";
const AUTO_SYNC_DELAY_MS = 600;
let autoSyncTimer = null;

const SYNC_KINDS = [
  { kind: "item", list: () => state.inventory },
  { kind: "shopping", list: () => state.shopping },
  { kind: "cooking", list: () => state.cookingHistory },
  // 棚の数は冷蔵庫そのものの形なので、1行として扱う
  { kind: "shelves", list: () => [{ id: "shelves", ...state.shelfCounts }] }
];

function loadSyncMeta() {
  state.syncMeta = {};
  try {
    const saved = localStorage.getItem(SYNC_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      state.syncMeta = parsed;
    }
  } catch {
    markStorageUnavailable();
  }
}

function persistSyncMeta() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(state.syncMeta));
  } catch {
    markStorageUnavailable();
  }
}

// 保存のたびに呼ぶ。前回覚えた内容と比べ、変わった行へ「送る」印を付ける。
function markSyncChanges() {
  const seen = new Set();
  for (const { kind, list } of SYNC_KINDS) {
    for (const entity of list()) {
      if (!entity || entity.id === undefined || entity.id === null) continue;
      const key = `${kind}:${entity.id}`;
      seen.add(key);
      const body = JSON.stringify(entity);
      const meta = state.syncMeta[key];
      if (!meta) {
        state.syncMeta[key] = { version: 0, body, dirty: true, ...currentChangeAttribution() };
        continue;
      }
      // 一度消したものが同じidで戻ってきたら、墓石を取り消す
      // （使い切った食材を買い直したときに起きる）
      if (meta.deletedAt) delete meta.deletedAt;
      if (meta.body !== body) {
        meta.body = body;
        meta.dirty = true;
        Object.assign(meta, currentChangeAttribution());
      }
    }
  }

  for (const [key, meta] of Object.entries(state.syncMeta)) {
    if (seen.has(key) || meta.deletedAt) continue;
    // サーバーが知らないまま消えたものは、伝える相手がいない。
    // 墓石を残すと、足して消しただけで表が増え続ける
    if (!meta.version) {
      delete state.syncMeta[key];
      continue;
    }
    meta.deletedAt = new Date().toISOString();
    meta.dirty = true;
    Object.assign(meta, currentChangeAttribution());
  }
}

// 二人が同じものを同時に触ったときの決着（→ CLOUDFLARE_SYNC.md の 2.）。
//
// ★サーバーは「あなたが見ていた版と違う」と返すだけで、何を採るかは決めない。
// 何が安全かはアプリの都合だから、ここで決める。
//
// 在庫でいちばん困るのは**多く見積もること**。「材料あり」と出て買い物に行かず、
// 帰ってから足りないと分かる。少なく見積もれば余分に買うだけで済む。
// だから迷ったら少ないほう・確かでないほう・無いほうを採る。
function mergeEntity(kind, mine, theirs) {
  if (!theirs) return mine;
  if (!mine) return theirs;

  if (kind === "item") {
    // 片方が「使い切った」と言っているなら、無いものとして扱う
    const active = mine.active !== false && theirs.active !== false;
    const merged = { ...theirs, ...mine };
    merged.active = active;
    merged.quantity = Math.min(Number(mine.quantity) || 0, Number(theirs.quantity) || 0);
    merged.quantityConfidence = lessCertain(
      quantityConfidence(mine),
      quantityConfidence(theirs)
    );
    // 満量は大きいほうを残す。残量の帯（ある／少ない）の目盛りが縮むと、
    // 同じ量なのに「少ない」に見えてしまう
    merged.maxQuantity = Math.max(
      Number(mine.maxQuantity) || 0,
      Number(theirs.maxQuantity) || 0
    ) || merged.quantity;
    if (!active) merged.consumedAt = mine.consumedAt || theirs.consumedAt || todayIso();
    return merged;
  }

  if (kind === "shopping") {
    // 消した（買った）ほうが勝つ。同じものを二度買わないため
    const checked = Boolean(mine.checked) || Boolean(theirs.checked);
    return { ...theirs, ...mine, checked };
  }

  if (kind === "shelves") {
    // 棚が減ると、そこに乗っていた食材の行き場が無くなる。多いほうを採る
    const merged = { ...theirs, ...mine };
    for (const location of Object.keys(STORAGE_SHELF_CAPACITIES)) {
      const both = [Number(mine[location]), Number(theirs[location])].filter(Number.isFinite);
      if (both.length) merged[location] = Math.max(...both);
    }
    return merged;
  }

  if (kind === "cooking") {
    // 履歴は通常別IDで追記する。調理内容を両端末で直したときだけ同じIDが
    // ぶつかるので、修正・取り消しの日時が新しいほうを採る。
    const changedAt = (entry) => Math.max(
      ...[entry.editedAt, entry.undoneAt, entry.occurredAt, entry.cookedAt]
        .map((value) => Date.parse(value || "") || 0)
    );
    return changedAt(mine) >= changedAt(theirs) ? mine : theirs;
  }

  return theirs;
}

// まだ送っていない変更。サーバーへ渡す形（SUPABASE_SETUP.md の apply_mutation）
function pendingSyncChanges() {
  return Object.entries(state.syncMeta)
    .filter(([, meta]) => meta.dirty)
    .map(([key, meta]) => {
      const at = key.indexOf(":");
      return {
        key,
        kind: key.slice(0, at),
        id: key.slice(at + 1),
        baseVersion: meta.version,
        deleted: Boolean(meta.deletedAt),
        body: meta.deletedAt ? null : JSON.parse(meta.body),
        changedAt: meta.changedAt || meta.deletedAt || new Date().toISOString(),
        changedBy: meta.changedBy || null
      };
    });
}

// ---- 共有サーバーとのやりとり ---------------------------------------------
// 設計は CLOUDFLARE_SYNC.md。サーバーの中身は worker/src/index.js。
//
// ★端末側が主体。冷蔵庫の中身は今までどおり端末に持ち、圏外でも全部動く。
// つながったときに差分だけをやりとりする。
const SYNC_API = "https://fridge-leftovers.juggler-arata.workers.dev";
const SHARE_STORAGE_KEY = "fridge-leftovers-share-v1";

function loadShare() {
  state.share = { fridgeId: "", seq: 0, syncedAt: "" };
  try {
    const saved = localStorage.getItem(SHARE_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (typeof parsed?.fridgeId === "string") {
      state.share = {
        fridgeId: parsed.fridgeId,
        seq: Number(parsed.seq) || 0,
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : ""
      };
    }
  } catch {
    markStorageUnavailable();
  }
}

function persistShare() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(SHARE_STORAGE_KEY, JSON.stringify(state.share));
  } catch {
    markStorageUnavailable();
  }
}

async function shareFetch(path, { method = "GET", body } = {}) {
  const response = await fetch(`${SYNC_API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = new Error(parsed?.error || `通信に失敗しました（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

// 受け取った変更を自分の在庫へ入れる。
// 自分がまだ送っていない行とぶつかったら、決着ルールで混ぜる（→ mergeEntity）。
function applyOneIncoming(change) {
  const lists = new Map(SYNC_KINDS.map((entry) => [entry.kind, entry]));
  const entry = lists.get(change.kind);
  if (!entry) return false;
  const key = `${change.kind}:${change.id}`;
  const meta = state.syncMeta[key];
  const list = entry.list();

  if (change.deleted) {
    // 相手が消したものは消す。自分がまだ送っていない変更があっても、
    // 「無いほうを採る」の考えに沿って消す側を採る
    if (change.kind === "item") state.inventory = state.inventory.filter((item) => item.id !== change.id);
    if (change.kind === "shopping") state.shopping = state.shopping.filter((item) => item.id !== change.id);
    if (change.kind === "cooking") state.cookingHistory = state.cookingHistory.filter((item) => item.id !== change.id);
    delete state.syncMeta[key];
    return true;
  }

  const mineIsDirty = Boolean(meta?.dirty);
  const current = list.find((item) => String(item.id) === String(change.id)) || null;
  const merged = mineIsDirty
    ? mergeEntity(change.kind, current, change.body)
    : change.body;

  if (change.kind === "shelves") {
    const { id, ...counts } = merged;
    void id;
    state.shelfCounts = { ...state.shelfCounts, ...counts };
  } else if (current) {
    Object.assign(current, merged);
  } else if (change.kind === "item") {
    state.inventory.push(merged);
  } else if (change.kind === "shopping") {
    state.shopping.push(merged);
  } else if (change.kind === "cooking") {
    state.cookingHistory.unshift(merged);
  }

  // 混ぜた結果が相手の中身と違うなら、こちらから送り直す必要がある
  const settled = JSON.stringify(merged) === JSON.stringify(change.body);
  const remoteAttribution = {
    changedAt: typeof change.changedAt === "string" ? change.changedAt : "",
    changedBy: change.changedBy && typeof change.changedBy === "object"
      ? {
          id: typeof change.changedBy.id === "string" ? change.changedBy.id : "",
          name: typeof change.changedBy.name === "string" ? change.changedBy.name : ""
        }
      : null
  };
  // 競合を混ぜてこちらから送り直すなら、この端末の変更として残す。
  // 相手の内容をそのまま採った場合だけ、相手の端末・時刻を引き継ぐ。
  const attribution = settled
    ? remoteAttribution
    : {
        changedAt: meta?.changedAt || new Date().toISOString(),
        changedBy: meta?.changedBy || { ...state.device }
      };
  state.syncMeta[key] = {
    version: change.version,
    body: JSON.stringify(merged),
    dirty: !settled,
    ...attribution
  };
  return true;
}

function applyIncoming(changes) {
  let touched = false;
  for (const change of changes) {
    touched = applyOneIncoming(change) || touched;
  }
  return touched;
}

// 1回の往復。受け取ってから送る（先に受け取らないと、こちらの版が古いまま
// ぶつかって毎回競合になる）。
async function syncOnce() {
  if (!state.share.fridgeId || state.syncing) return { skipped: true };
  state.syncing = true;
  renderHeaderSync();
  let completed = false;
  try {
    let touched = false;
    let hasMore = false;
    do {
      const previousSeq = state.share.seq;
      const pulled = await shareFetch(
        `/v1/fridges/${state.share.fridgeId}/changes?since=${previousSeq}`
      );
      touched = applyIncoming(pulled.changes || []) || touched;
      const nextSeq = Number(pulled.seq);
      if (Number.isFinite(nextSeq) && nextSeq >= previousSeq) {
        state.share.seq = nextSeq;
      }
      hasMore = pulled.hasMore === true;
      if (hasMore && state.share.seq <= previousSeq) {
        throw new Error("同期の続き位置を更新できませんでした");
      }
    } while (hasMore);

    markSyncChanges();
    const pending = pendingSyncChanges();
    if (pending.length) {
      const sent = await shareFetch(
        `/v1/fridges/${state.share.fridgeId}/changes`,
        {
          method: "POST",
          body: {
            changes: pending.slice(0, 200).map((change) => ({
              kind: change.kind,
              id: change.id,
              body: change.body,
              baseVersion: change.baseVersion,
              deleted: change.deleted,
              changedAt: change.changedAt,
              changedBy: change.changedBy
            }))
          }
        }
      );
      for (const result of sent.results || []) {
        const key = `${result.kind}:${result.id}`;
        if (result.status === "applied") {
          applySyncResult(key, result.version);
        } else if (result.status === "conflict") {
          // 競合はその場でサーバー状態を混ぜる
          if (result.server) {
            applyOneIncoming({
              kind: result.kind,
              id: result.id,
              body: result.server.body,
              version: result.server.version,
              deleted: result.server.deleted,
              changedAt: result.server.changedAt,
              changedBy: result.server.changedBy
            });
          } else {
            const meta = state.syncMeta[key];
            if (meta?.deletedAt) {
              delete state.syncMeta[key];
            } else if (meta) {
              meta.version = 0;
            }
          }
          touched = true;
        }
      }
      // seq はPOSTでは進めない。進めると相手の変更を飛ばす
      touched = true;
    }

    state.share.syncedAt = new Date().toISOString();
    persistShare();
    persistSyncMeta();
    if (touched) {
      persistInventory();
      persistShoppingList();
      persistCookingHistory();
      persistShelfCounts();
      renderAll();
      renderDayAfterCheck();
    }
    const result = { changed: touched, pending: pendingSyncChanges().length };
    completed = true;
    return result;
  } finally {
    state.syncing = false;
    renderHeaderSync();
    // 通信中に新しい操作が入った場合や競合が起きた場合は、残った変更だけを
    // もう一度送る。通信失敗時は連続再試行せず、上部の「未同期」から手で戻せる。
    if (completed && pendingSyncChanges().length) scheduleAutoSync();
  }
}

async function createSharedFridge() {
  const created = await shareFetch("/v1/fridges", { method: "POST" });
  if (!created?.id) throw new Error("冷蔵庫を作れませんでした");
  state.share = { fridgeId: created.id, seq: 0, syncedAt: "" };
  // いま持っているものを全部送る。作った直後はサーバーが空なので、
  // 版はすべて0から始める
  for (const meta of Object.values(state.syncMeta)) {
    meta.version = 0;
    meta.dirty = true;
  }
  persistShare();
  persistSyncMeta();
  await syncOnce();
  return created.id;
}

// 送信が通ったときに呼ぶ。墓石は通った時点で表から外す（もう伝える用が無い）
function applySyncResult(key, version) {
  const meta = state.syncMeta[key];
  if (!meta) return;
  if (meta.deletedAt) {
    delete state.syncMeta[key];
    return;
  }
  meta.version = Number(version) || meta.version;
  meta.dirty = false;
}

// ---- データの書き出し・読み込み --------------------------------------------
// 端末のブラウザ内にしか無いので、機種変更でも消える。ファイル1つに出せる
// ようにしておく。二人で1つの冷蔵庫を共有する仕組み（SUPABASE_SETUP.md）の
// 前段でもあり、それ抜きでもバックアップとして意味がある。
const EXPORT_FORMAT = 1;
const EXPORT_APP = "fridge-leftovers";

// 書き出す中身。保存キーとの対応をここ1箇所にまとめる
const EXPORT_SECTIONS = [
  { key: "inventory", label: "冷蔵庫の中身", storage: STORAGE_KEY, expected: "array", itemsHaveId: true, get: () => state.inventory },
  { key: "shopping", label: "買い物リスト", storage: SHOPPING_STORAGE_KEY, expected: "array", itemsHaveId: true, get: () => state.shopping },
  { key: "cookingHistory", label: "履歴", storage: COOKING_HISTORY_STORAGE_KEY, expected: "array", itemsHaveId: true, get: () => state.cookingHistory },
  { key: "shelfCounts", label: "棚の数", storage: SHELF_COUNTS_STORAGE_KEY, expected: "object", get: () => state.shelfCounts },
  { key: "recentIngredientIds", label: "最近追加した食材", storage: RECENT_INGREDIENTS_STORAGE_KEY, expected: "array", get: () => state.recentIngredientIds },
  { key: "settings", label: "設定", storage: SETTINGS_STORAGE_KEY, expected: "object", get: () => state.settings },
  // 同期の版も一緒に持ち出す。持ち越さないと、読み込んだ先で全部が
  // 「サーバーの知らない新しい行」になり、二重に登録されてしまう
  { key: "syncMeta", label: "同期の記録", storage: SYNC_STORAGE_KEY, expected: "object", get: () => state.syncMeta },
  // 共有している冷蔵庫。機種変更したとき、同じ冷蔵庫へ戻れるように持ち出す
  { key: "share", label: "共有の設定", storage: SHARE_STORAGE_KEY, expected: "object", get: () => state.share }
];

function backupPayload() {
  const data = {};
  for (const section of EXPORT_SECTIONS) data[section.key] = section.get();
  return {
    app: EXPORT_APP,
    format: EXPORT_FORMAT,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data
  };
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(backupPayload(), null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fridge-leftovers-${todayIso()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // すぐ解放すると保存が始まらない端末があるので、少し待ってから捨てる
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  showToast("冷蔵庫のデータを書き出しました");
}

// 読み込みは今のデータを置き換えるので、まず中身を確かめる。
// **ファイルに入っている項目だけを置き換える。** 入っていない項目は今のまま
// 残す（黙って消さないため）。
function readBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ファイルを読めませんでした。書き出したJSONファイルを選んでください。");
  }
  if (parsed?.app !== EXPORT_APP) {
    throw new Error("このアプリで書き出したファイルではないようです。");
  }
  if (Number(parsed.format) > EXPORT_FORMAT) {
    throw new Error("新しい版のアプリで書き出したファイルです。アプリを更新してから読み込んでください。");
  }
  const data = parsed.data;
  if (!data || typeof data !== "object") {
    throw new Error("中身が入っていないファイルです。");
  }

  const found = EXPORT_SECTIONS
    .filter((section) => data[section.key] !== undefined)
    .map((section) => {
      const value = data[section.key];
      const validType = section.expected === "array"
        ? Array.isArray(value)
        : value !== null && typeof value === "object" && !Array.isArray(value);
      const validItems = !section.itemsHaveId || (Array.isArray(value) && value.every((item) =>
        item !== null
        && typeof item === "object"
        && !Array.isArray(item)
        && Object.prototype.hasOwnProperty.call(item, "id")
        && item.id !== null
        && item.id !== undefined));
      if (!validType || !validItems) {
        throw new Error(`ファイルの「${section.label}」が壊れています。`);
      }
      const count = Array.isArray(value) ? value.length : null;
      return { section, value, count };
    });
  if (!found.length) throw new Error("読み込める項目がありませんでした。");
  return { payload: parsed, found };
}

function describeBackup({ payload, found }) {
  const when = String(payload.exportedAt || "").slice(0, 10);
  const parts = found.map(({ section, count }) =>
    count === null ? section.label : `${section.label}${count}件`);
  const now = state.inventory.filter((item) => item.active !== false).length;
  return `${when || "日付不明"}に書き出したファイルです。${parts.join("・")}を読み込みます。`
    + `いまの冷蔵庫（${now}品）は置き換わります。`;
}

function applyBackup({ found }) {
  let storedValues;
  try {
    storedValues = Object.fromEntries(
      EXPORT_SECTIONS.map(({ storage }) => [storage, localStorage.getItem(storage)])
    );
  } catch {
    markStorageUnavailable();
    return false;
  }

  let writing = true;
  try {
    for (const { section, value } of found) {
      localStorage.setItem(section.storage, JSON.stringify(value));
    }
    writing = false;
    // 保存し直したあとは、通常の読み込みをそのまま通す。
    loadSyncMeta();
    loadShare();
    loadSettings();
    loadShelfCounts();
    loadRecentIngredients();
    loadInventory();
    loadShoppingList();
    loadCookingHistory();
    state.needsOnboarding = false;
    elements.settingShowNutrition.checked = state.settings.showNutrition;
    setNutritionHelpExpanded(false);
    renderAll();
    renderRefineEntry();
    renderDayAfterCheck();
    renderSampleNotice();
    return true;
  } catch {
    let restoreFailed = false;
    try {
      for (const [key, value] of Object.entries(storedValues)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    } catch {
      restoreFailed = true;
    }

    try {
      loadSyncMeta();
      loadShare();
      loadSettings();
      loadShelfCounts();
      loadRecentIngredients();
      loadInventory();
      loadShoppingList();
      loadCookingHistory();
    } catch {
      // 復元できた範囲で画面を戻し、読み込み失敗として扱う
    }
    try {
      elements.settingShowNutrition.checked = state.settings.showNutrition;
      setNutritionHelpExpanded(false);
      renderAll();
      renderRefineEntry();
      renderDayAfterCheck();
      renderSampleNotice();
    } catch {
      // 画面の復元に失敗しても、壊れたバックアップは適用済みにしない
    }
    if (writing || restoreFailed) markStorageUnavailable();
    return false;
  }
}

// ---- 翌日の在庫確認・補正 ------------------------------------------------
// 「これを作る」で引くのはレシピ上の分量なので、実際に使った量とはズレる。
// 放っておくと使うほど推定在庫が実物から離れていく（方針書「在庫更新の流れ」の3と4）。
//
// 聞き方は3状態にする。グラム数を思い出させるのは負担が大きく、
// 「記憶と判断の負担を減らす」という核に反する。数量は内部で保ち、
// 答えた状態に対応する代表値へ寄せる。境目は残量ゲージと同じ（0.5 / 0.25）
// にしてあるので、答えた直後の見た目と食い違わない。
const DAY_AFTER_LEVELS = {
  plenty: 0.6,
  little: 0.35
};
const DAY_AFTER_LIMIT = 4;

// 昨日以前に作った分で、まだ実物と突き合わせていない食材。
// 一度に全部聞くと重いので、使い切ったことになっているものと、
// 残りが少ないものを先に、4品までにする。
function pendingDayAfterItems() {
  if (state.settings.dayAfterSkippedOn === todayIso()) return { recipeName: "", items: [] };

  const today = todayIso();
  const entries = state.cookingHistory.filter((entry) =>
    historyEntryType(entry) === "cooking"
    && !entry.undoneAt
    && String(historyEntryTime(entry)).slice(0, 10) < today);
  if (!entries.length) return { recipeName: "", items: [] };

  const seen = new Set();
  const items = [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      if (seen.has(change.itemId)) continue;
      seen.add(change.itemId);
      const item = state.inventory.find((candidate) => candidate.id === change.itemId);
      if (!item || quantityConfidence(item) !== QUANTITY_ESTIMATED) continue;
      items.push(item);
    }
  }

  items.sort((a, b) => {
    const consumed = Number(b.active === false) - Number(a.active === false);
    return consumed || inventoryLevel(a) - inventoryLevel(b);
  });

  return { recipeName: entries[0].recipeName, items: items.slice(0, DAY_AFTER_LIMIT) };
}

function renderDayAfterCheck() {
  const { recipeName, items } = pendingDayAfterItems();
  elements.dayAfterCheck.hidden = items.length === 0;
  if (!items.length) return;

  elements.dayAfterLead.textContent = recipeName
    ? `${recipeName}のあと、レシピ上の分量で在庫を減らしました。`
    : "レシピ上の分量で在庫を減らしました。";
  elements.dayAfterList.innerHTML = items.map((item) => `
    <li class="day-after-row">
      <span class="day-after-item">
        ${renderIngredientIllustration(item.id, item.name, true)}
        <span>
          <strong>${escapeHtml(item.name)}</strong>
          <small>${item.active === false ? "使い切ったことになっています" : `残り ${formatQuantity(item.quantity, item.unit)}のはず`}</small>
        </span>
      </span>
      <span class="day-after-choices" role="group" aria-label="${escapeHtml(item.name)}の残り">
        <button type="button" data-day-after="plenty" data-day-after-id="${escapeHtml(item.id)}">ある</button>
        <button type="button" data-day-after="little" data-day-after-id="${escapeHtml(item.id)}">少ない</button>
        <button type="button" data-day-after="none" data-day-after-id="${escapeHtml(item.id)}">ない</button>
      </span>
    </li>
  `).join("");
}

// 3つの答えを数量へ落とす。答えた状態と、そのあと画面に出る残量の帯が
// 食い違わないようにするのが目的。
function dayAfterCorrection(item, answer) {
  const maxQuantity = Number(item.maxQuantity) > 0 ? Number(item.maxQuantity) : item.quantity;
  if (answer === "none") {
    item.quantity = 0;
    item.active = false;
    item.consumedAt = todayIso();
  } else {
    const level = DAY_AFTER_LEVELS[answer] ?? DAY_AFTER_LEVELS.little;
    // 下げはしない。減らすのは「これを作る」と残量の操作の役目
    item.quantity = Number(Math.max(item.quantity, maxQuantity * level).toFixed(2));
    item.active = true;
    delete item.consumedAt;
  }
  // 実物を見て答えてもらったので、量は確認済みへ戻る
  item.quantityConfidence = QUANTITY_CONFIRMED;
  item.confirmedAt = todayIso();
  return item;
}

function answerDayAfter(id, answer) {
  const item = state.inventory.find((candidate) => candidate.id === id);
  if (!item) return;
  const before = { ...item };
  dayAfterCorrection(item, answer);
  recordInventoryAdjustment(before, item);
  persistInventory();
  persistCookingHistory();
  renderAll();
  renderDayAfterCheck();
}

// ---- 冷蔵庫をもっと正確にする ---------------------------------------------
// 初回登録の続き。売り場を順番に回って、持っているものをタップするだけ。
// 方針書ではカテゴリー式を第一案から「あとで足す精度向上機能」へ格下げした。
// ここはその格下げ後の姿で、初回に押し付けず、いつでも途中でやめられる。
//
// 見終わった売り場を覚えておく（reviewed）。**在庫の判定には使わない**。
// 見ていない売り場を「その食材は無い」と決めつけないためで、用途は進み具合の
// 表示だけ。全部見た人に「ここまで見た」と返せるようにしている。

function reviewedCategories() {
  const saved = state.settings.reviewedCategories;
  return Array.isArray(saved) ? saved : [];
}

function refineCategories() {
  return displayedIngredientCategories();
}

function renderRefineEntry() {
  const categories = refineCategories();
  const reviewed = reviewedCategories().filter(
    (name) => categories.some((category) => category.name === name)
  );
  elements.refineEntryNote.textContent = reviewed.length
    ? `${categories.length}の売り場のうち ${reviewed.length} を見ました`
    : `${categories.length}の売り場を順番に見て、あるものをタップします`;
}

function renderRefine() {
  const categories = refineCategories();
  const category = categories[state.refine.index];
  if (!category) {
    finishRefine();
    return;
  }

  const owned = new Set(state.inventory.filter((item) => item.active !== false).map((item) => item.id));
  elements.refineProgress.textContent = `${state.refine.index + 1} / ${categories.length}`;
  elements.refineTitle.textContent = category.name;
  elements.refineGrid.innerHTML = categoryDisplayGroups(category).map((group) => `
    <section class="refine-group">
      ${group.name ? `<h3>${escapeHtml(group.name)}</h3>` : ""}
      <div class="refine-tile-grid">
        ${group.items.map((id) => {
          const item = illustratedIngredientItem(id);
          if (!item) return "";
          const has = owned.has(id);
          const justAdded = state.refine.added.includes(id);
          return `
            <button
              type="button"
              class="onboarding-tile${has ? " is-selected" : ""}"
              data-refine-pick="${escapeHtml(id)}"
              aria-pressed="${has ? "true" : "false"}"
              ${has && !justAdded ? "disabled" : ""}
            >
              ${renderIngredientIllustration(item.id, item.name)}
              <span>${escapeHtml(item.name)}</span>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `).join("");

  const last = state.refine.index === categories.length - 1;
  elements.refineNext.textContent = last ? "見終わった" : "次の売り場へ";
}

function toggleRefineItem(id) {
  const at = state.refine.added.indexOf(id);
  if (at >= 0) {
    // この画面で入れたものだけ取り消せる。前から入っていた在庫は消さない
    state.refine.added.splice(at, 1);
    state.inventory = state.inventory.filter((item) => item.id !== id);
  } else {
    const item = illustratedIngredientItem(id);
    if (!item) return;
    addOrMergeInventoryItem({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      location: item.location,
      confidence: QUANTITY_UNKNOWN
    });
    rememberRecentIngredient(id);
    state.refine.added.push(id);
  }
  persistInventory();
  renderRefine();
}

function markCategoryReviewed() {
  const category = refineCategories()[state.refine.index];
  if (!category) return;
  const reviewed = new Set(reviewedCategories());
  reviewed.add(category.name);
  state.settings.reviewedCategories = [...reviewed];
  persistSettings();
}

function startRefine() {
  state.refine = { index: 0, added: [] };
  renderRefine();
  showView("refine");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function finishRefine() {
  renderAll();
  renderRefineEntry();
  showView("inventory");
}

function renderSampleNotice() {
  const samples = state.settings.sampleNoticeDone ? [] : untouchedSampleItems();
  elements.sampleNotice.hidden = samples.length === 0;
  if (!samples.length) return;
  elements.sampleNoticeList.textContent = samples
    .map((item) => `${item.name} ${formatQuantity(item.quantity, item.unit)}`)
    .join("・");
}

function clearSampleItems() {
  const removed = untouchedSampleItems();
  if (!removed.length) return;
  const ids = new Set(removed.map((item) => item.id));
  state.inventory = state.inventory.filter((item) => !ids.has(item.id));
  state.settings.sampleNoticeDone = true;
  persistInventory();
  persistSettings();
  renderAll();
  renderSampleNotice();
  showToast(`はじめに入っていた${removed.length}品を片付けました`);
}

function persistInventory() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.inventory));
  } catch {
    markStorageUnavailable();
  }
  markSyncChanges();
  persistSyncMeta();
  scheduleAutoSync();
}

function loadRecentIngredients() {
  try {
    const saved = localStorage.getItem(RECENT_INGREDIENTS_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    state.recentIngredientIds = Array.isArray(parsed)
      ? [...new Set(parsed)]
        .filter((id) => Boolean(INGREDIENT_ILLUSTRATIONS[id]))
        .slice(0, 24)
      : [];
  } catch {
    state.recentIngredientIds = [];
  }
}

function rememberRecentIngredient(id) {
  if (!INGREDIENT_ILLUSTRATIONS[id]) return;
  state.recentIngredientIds = [
    id,
    ...state.recentIngredientIds.filter((candidate) => candidate !== id)
  ].slice(0, 24);
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(
      RECENT_INGREDIENTS_STORAGE_KEY,
      JSON.stringify(state.recentIngredientIds)
    );
  } catch {
    markStorageUnavailable();
  }
}

function loadSettings() {
  state.settings = { ...DEFAULT_SETTINGS };
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (typeof parsed?.showNutrition === "boolean") {
      state.settings.showNutrition = parsed.showNutrition;
    }
    if (typeof parsed?.sampleNoticeDone === "boolean") {
      state.settings.sampleNoticeDone = parsed.sampleNoticeDone;
    }
    if (typeof parsed?.dayAfterSkippedOn === "string") {
      state.settings.dayAfterSkippedOn = parsed.dayAfterSkippedOn;
    }
    if (Array.isArray(parsed?.reviewedCategories)) {
      state.settings.reviewedCategories = parsed.reviewedCategories.filter(
        (name) => typeof name === "string"
      );
    }
  } catch {
    markStorageUnavailable();
  }
}

function persistSettings() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    markStorageUnavailable();
  }
}

function setNutritionHelpExpanded(expanded) {
  elements.nutritionHelp.setAttribute("aria-expanded", String(expanded));
  elements.settingsNutritionNote.hidden = !expanded;
}

function loadShelfCounts() {
  state.shelfCounts = { ...DEFAULT_STORAGE_SHELF_COUNTS };
  try {
    const saved = localStorage.getItem(SHELF_COUNTS_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    for (const [location, limits] of Object.entries(STORAGE_SHELF_LIMITS)) {
      const count = Number(parsed?.[location]);
      if (Number.isInteger(count)) {
        state.shelfCounts[location] = Math.min(limits.max, Math.max(limits.min, count));
      }
    }
  } catch {
    markStorageUnavailable();
  }
}

function persistShelfCounts() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(SHELF_COUNTS_STORAGE_KEY, JSON.stringify(state.shelfCounts));
  } catch {
    markStorageUnavailable();
  }
  markSyncChanges();
  persistSyncMeta();
  scheduleAutoSync();
}

function loadShoppingList() {
  try {
    const saved = localStorage.getItem(SHOPPING_STORAGE_KEY);
    if (!saved) {
      state.shopping = [];
      return;
    }
    const parsed = JSON.parse(saved);
    state.shopping = Array.isArray(parsed) ? parsed : [];
  } catch {
    state.shopping = [];
  }
}

function persistShoppingList() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(SHOPPING_STORAGE_KEY, JSON.stringify(state.shopping));
  } catch {
    markStorageUnavailable();
  }
  markSyncChanges();
  persistSyncMeta();
  scheduleAutoSync();
}

function loadCookingHistory() {
  try {
    const saved = localStorage.getItem(COOKING_HISTORY_STORAGE_KEY);
    if (!saved) {
      state.cookingHistory = [];
      return;
    }
    const parsed = JSON.parse(saved);
    state.cookingHistory = Array.isArray(parsed)
      ? parsed.filter((entry) => entry && Array.isArray(entry.changes)).slice(0, HISTORY_STORAGE_LIMIT)
      : [];
  } catch {
    state.cookingHistory = [];
  }
}

function persistCookingHistory() {
  if (!state.storageEnabled) return;
  try {
    localStorage.setItem(
      COOKING_HISTORY_STORAGE_KEY,
      JSON.stringify(state.cookingHistory.slice(0, HISTORY_STORAGE_LIMIT))
    );
  } catch {
    markStorageUnavailable();
  }
  markSyncChanges();
  persistSyncMeta();
  scheduleAutoSync();
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
  const known = NAME_TO_ID.get(name.trim());
  if (known) return known;
  if (globalThis.crypto?.randomUUID) return `custom-${crypto.randomUUID()}`;
  return `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// 既に custom- で登録されてしまった食材も、名前がカタログと一致すれば絵を出す
function canonicalIngredientId(id, name) {
  if (INGREDIENT_ILLUSTRATIONS[id]) return id;
  return NAME_TO_ID.get(String(name).trim()) || id;
}

function normalizeIngredientNameForMatch(value) {
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[ぁ-ゖ]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) + 0x60)
    )
    .toLowerCase();
}

function ingredientNameDistance(left, right) {
  const a = [...left];
  const b = [...right];
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) rows[row][0] = row;
  for (let column = 0; column <= b.length; column += 1) rows[0][column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = rows[row - 1][column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        substitution
      );
    }
  }
  return rows[a.length][b.length];
}

function suggestIngredientName(value) {
  const trimmed = String(value).trim();
  if (ALIASES.has(trimmed)) return null;
  const normalized = normalizeIngredientNameForMatch(trimmed);
  if ([...normalized].length < 3) return null;

  const candidates = new Map();
  ALIASES.forEach((id, alias) => {
    const normalizedAlias = normalizeIngredientNameForMatch(alias);
    if (Math.abs([...normalizedAlias].length - [...normalized].length) > 1) return;
    const distance = ingredientNameDistance(normalized, normalizedAlias);
    if (distance > 1) return;
    const current = candidates.get(id);
    if (!current || distance < current.distance) candidates.set(id, { distance });
  });

  if (!candidates.size) return null;
  const bestDistance = Math.min(...[...candidates.values()].map((candidate) => candidate.distance));
  const matches = [...candidates.entries()].filter(([, candidate]) => candidate.distance === bestDistance);
  if (matches.length !== 1) return null;

  const [id] = matches[0];
  const canonical = RECEIPT_RULES.find((rule) => rule.id === id)?.name
    || [...ALIASES.entries()].find(([, candidateId]) => candidateId === id)?.[0];
  if (!canonical || canonical === trimmed) return null;
  return { id, name: canonical, distance: bestDistance };
}

function updateIngredientNameSuggestion() {
  const typedName = elements.ingredientName.value;
  const normalized = normalizeIngredientNameForMatch(typedName);
  const suggestion = suggestIngredientName(typedName);
  const dismissed = state.dismissedIngredientSuggestionFor === normalized;
  state.ingredientNameSuggestion = suggestion;
  elements.nameSuggestion.hidden = !suggestion || dismissed;
  if (suggestion) elements.suggestedIngredientName.textContent = suggestion.name;
  return suggestion && !dismissed ? suggestion : null;
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

// 小分類の見出しで区切るのは、これ以上並ぶときだけ。数が少ないうちに
// 見出しを出すと、1件だけの見出しが並んで逆に読みにくくなる。
const CATEGORY_HEADING_THRESHOLD = 8;

function hasIngredientIllustration(id) {
  return id === "rice" || Boolean(INGREDIENT_ILLUSTRATIONS[id]);
}

// イラストが無い食材は一覧に出さない（頭文字だけのカードが混ざると
// イラストで選ぶという中心の作りが崩れるため）。空になった小分類も落とす。
function categoryDisplayGroups(category) {
  return category.groups
    .map((group) => ({ name: group.name, items: group.items.filter(hasIngredientIllustration) }))
    .filter((group) => group.items.length > 0);
}

function categoryDisplayItems(category) {
  return categoryDisplayGroups(category).flatMap((group) => group.items);
}

function displayedIngredientCategories() {
  return ILLUSTRATED_INGREDIENT_CATEGORIES.filter(
    (category) => categoryDisplayItems(category).length > 0
  );
}

function categoryRepresentatives(category) {
  const shown = categoryDisplayItems(category);
  const preferred = category.representatives.filter((id) => shown.includes(id));
  return (preferred.length ? preferred : shown).slice(0, 3);
}

function illustratedIngredientItem(id) {
  if (id === "rice") {
    return {
      id: "rice",
      name: "ごはん",
      quantity: 1,
      unit: "膳",
      location: "冷凍"
    };
  }

  const rule = RECEIPT_RULES.find((candidate) => candidate.id === id);
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    quantity: rule.quantity,
    unit: rule.unit,
    location: rule.location
  };
}

function renderIngredientCategoryPicker() {
  elements.ingredientCategoryGrid.innerHTML = displayedIngredientCategories().map((category) => `
    <button
      class="ingredient-category-card"
      type="button"
      data-ingredient-category="${category.id}"
      aria-label="${escapeHtml(category.name)}から選ぶ"
    >
      <span class="ingredient-category-pictures" aria-hidden="true">
        ${categoryRepresentatives(category).map((id) => {
          const item = illustratedIngredientItem(id);
          return item ? renderIngredientIllustration(item.id, item.name) : "";
        }).join("")}
      </span>
      <span class="ingredient-category-copy">
        <strong>${escapeHtml(category.name)}</strong>
        <small>${escapeHtml(category.note)}</small>
      </span>
      <span class="ingredient-category-arrow" aria-hidden="true">›</span>
    </button>
  `).join("");
}

function showIngredientCategoryLayer({ focus = false } = {}) {
  state.ingredientPickerCategory = null;
  state.selectedIngredientCatalogId = null;
  elements.ingredientCategoryLayer.hidden = false;
  elements.ingredientItemLayer.hidden = true;
  elements.ingredientPicker.hidden = false;
  elements.ingredientDetails.hidden = true;
  renderIngredientCategoryPicker();
  if (focus) {
    requestAnimationFrame(() => {
      elements.ingredientCategoryGrid.querySelector("button")?.focus();
    });
  }
}

function showIngredientItemLayer(categoryId) {
  const category = ILLUSTRATED_INGREDIENT_CATEGORIES.find((candidate) => candidate.id === categoryId);
  if (!category) return;

  state.ingredientPickerCategory = category.id;
  state.selectedIngredientCatalogId = null;
  elements.ingredientPicker.hidden = false;
  elements.ingredientDetails.hidden = true;
  elements.ingredientPickerCategoryTitle.textContent = category.name;
  const groups = categoryDisplayGroups(category);
  const shown = groups.flatMap((group) => group.items);
  // 小分類はタップして潜る階層にせず、見出しで区切るだけにする。
  // 手数を今の2回に保ったまま、探しやすさだけ上げるため。
  const useHeadings = shown.length >= CATEGORY_HEADING_THRESHOLD && groups.length >= 2;

  const sections = [];
  if (useHeadings) {
    const recent = state.recentIngredientIds.filter((id) => shown.includes(id)).slice(0, 4);
    if (recent.length) sections.push({ name: "最近使ったもの", items: recent });
    sections.push(...groups);
  } else {
    // 数が少ないときは見出しを付けず、最近使ったものを先頭へ寄せるだけにする
    const recentOrder = new Map(state.recentIngredientIds.map((id, index) => [id, index]));
    sections.push({
      name: "",
      items: [...shown].sort((left, right) =>
        (recentOrder.get(left) ?? Number.POSITIVE_INFINITY) - (recentOrder.get(right) ?? Number.POSITIVE_INFINITY)
      )
    });
  }

  elements.ingredientItemGrid.innerHTML = sections.map((section) => `
    <section class="ingredient-item-group">
      ${section.name ? `<h4 class="ingredient-item-group-title">${escapeHtml(section.name)}</h4>` : ""}
      <div class="ingredient-item-group-grid">
        ${section.items.map((id) => {
          const item = illustratedIngredientItem(id);
          if (!item) return "";
          return `
            <button
              class="ingredient-item-card"
              type="button"
              data-ingredient-item="${escapeHtml(item.id)}"
              aria-label="${escapeHtml(item.name)}を追加"
            >
              ${renderIngredientIllustration(item.id, item.name)}
              <strong>${escapeHtml(item.name)}</strong>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `).join("");
  elements.ingredientCategoryLayer.hidden = true;
  elements.ingredientItemLayer.hidden = false;
  requestAnimationFrame(() => {
    elements.ingredientItemGrid.querySelector("button")?.focus();
  });
}

function showIngredientDetails({ catalogItem = null, manual = false, editing = false } = {}) {
  elements.ingredientPicker.hidden = true;
  elements.ingredientDetails.hidden = false;
  elements.ingredientPickerReselect.hidden = editing;
  elements.nameSuggestion.hidden = true;

  if (catalogItem) {
    state.selectedIngredientCatalogId = catalogItem.id;
    elements.ingredientName.value = catalogItem.name;
    elements.ingredientQuantity.value = catalogItem.quantity;
    elements.ingredientUnit.value = catalogItem.unit;
    elements.ingredientLocation.value = state.ingredientPreferredLocation || catalogItem.location;
    elements.ingredientNameField.hidden = true;
    elements.selectedIngredientPreview.hidden = false;
    elements.selectedIngredientPreview.innerHTML = `
      ${renderIngredientIllustration(catalogItem.id, catalogItem.name)}
      <span>
        <small>3. 残量と保存場所を確認</small>
        <strong>${escapeHtml(catalogItem.name)}</strong>
      </span>
    `;
  } else {
    state.selectedIngredientCatalogId = null;
    elements.ingredientNameField.hidden = false;
    elements.selectedIngredientPreview.hidden = true;
    elements.selectedIngredientPreview.innerHTML = "";
    if (manual) elements.ingredientName.value = "";
  }

  syncQuantityControl(
    elements.ingredientQuantity,
    elements.ingredientQuantityRange,
    elements.ingredientUnit.value
  );
  requestAnimationFrame(() => {
    if (manual) {
      elements.ingredientName.focus();
    } else if (catalogItem) {
      elements.ingredientQuantity.focus();
      elements.ingredientQuantity.select();
    }
  });
}

function stepForUnit(unit) {
  if (unit === "g" || unit === "ml") return 50;
  if (unit === "株") return 0.25;
  return 1;
}

function rangeStepForUnit(unit) {
  if (unit === "g" || unit === "ml") return 10;
  if (unit === "株" || unit === "個" || unit === "本") return 0.25;
  if (unit === "袋") return 0.1;
  return 1;
}

function quantityRangeMax(unit, currentValue = 1) {
  const current = Number(currentValue) || rangeStepForUnit(unit);
  if (unit === "g" || unit === "ml") return Math.max(1000, Math.ceil((current * 2) / 50) * 50);
  if (unit === "株") return Math.max(5, Math.ceil(current * 2 * 4) / 4);
  return Math.max(10, Math.ceil(current * 2));
}

function syncQuantityControl(input, range, unit, source = "input") {
  if (!input || !range) return;
  const step = rangeStepForUnit(unit);
  const sourceElement = source === "range" ? range : input;
  const rawValue = Number(sourceElement.value);
  if (!Number.isFinite(rawValue)) return;
  const value = Math.max(0.01, rawValue);
  const max = quantityRangeMax(unit, value);

  input.min = "0.01";
  input.step = "any";
  input.removeAttribute("max");
  range.min = String(step);
  range.step = String(step);
  range.max = String(max);
  range.value = String(Math.max(step, value));
  if (source !== "input-live") input.value = String(Number(value.toFixed(2)));
}

function adjustQuantityControl(input, range, unit, direction) {
  const step = stepForUnit(unit);
  const minimum = rangeStepForUnit(unit);
  const current = Number(input.value) || minimum;
  input.value = String(Number(Math.max(minimum, current + step * direction).toFixed(2)));
  syncQuantityControl(input, range, unit);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function formatQuantity(quantity, unit) {
  if (unit === "株" && quantity === 0.25) return "1/4株";
  if (unit === "株" && quantity === 0.5) return "1/2株";
  if (unit === "株" && quantity === 0.75) return "3/4株";
  if (unit === "本" && quantity === 0.25) return "1/4本";
  if (unit === "個" && quantity === 0.25) return "1/4個";
  if (unit === "個" && quantity === 0.5) return "1/2個";
  if (unit === "個" && quantity === 0.75) return "3/4個";
  if (unit === "小さじ" || unit === "大さじ") return `${unit}${quantity}`;
  const number = Number.isInteger(quantity) ? quantity : Number(quantity.toFixed(2));
  return `${number}${unit}`;
}

function addNutrition(target, source, factor = 1) {
  target.kcal += source.kcal * factor;
  target.p += source.p * factor;
  target.f += source.f * factor;
  target.c += source.c * factor;
}

function ingredientNutrition(ingredient) {
  const reference = NUTRITION_REFERENCES[ingredient.id]?.[ingredient.unit];
  if (!reference) return { kcal: 0, p: 0, f: 0, c: 0 };
  const [baseAmount, kcal, p, f, c] = reference;
  const factor = ingredient.quantity / baseAmount;
  return {
    kcal: kcal * factor,
    p: p * factor,
    f: f * factor,
    c: c * factor
  };
}

function pantryNutrition(recipe) {
  const text = recipe.pantry || "";
  const result = { kcal: 15, p: 0.3, f: 0.2, c: 3 };
  if (/(?:油|ごま油|バター|マヨネーズ)/.test(text)) {
    addNutrition(result, { kcal: 45, p: 0, f: 5, c: 0 });
  }
  if (/(?:小麦粉|餃子の皮|カレールウ)/.test(text)) {
    addNutrition(result, { kcal: 55, p: 1, f: 1.5, c: 10 });
  }
  if (/(?:砂糖|みりん|ケチャップ|ソース)/.test(text)) {
    addNutrition(result, { kcal: 25, p: 0, f: 0, c: 6 });
  }
  return result;
}

function estimateRecipeNutrition(recipe, servings = 1, ingredients = recipe.required) {
  const total = { kcal: 0, p: 0, f: 0, c: 0 };
  ingredients.forEach((ingredient) => addNutrition(total, ingredientNutrition(ingredient), servings));
  addNutrition(total, pantryNutrition(recipe), servings);
  return {
    kcal: Math.max(0, Math.round(total.kcal / 10) * 10),
    p: Math.max(0, Number(total.p.toFixed(1))),
    f: Math.max(0, Number(total.f.toFixed(1))),
    c: Math.max(0, Number(total.c.toFixed(1)))
  };
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

function expiringItems(today = localDateIso()) {
  return activeInventory()
    .map((item) => {
      const expiry = expiryAlertState(item.expiryDate, today);
      const expectedDays = freshnessDays(item.id);
      const elapsedDays = typeof expectedDays === "number"
        ? expiryDayDifference(today, purchasedOn(item))
        : null;
      const left = elapsedDays === null ? null : expectedDays - elapsedDays;
      const freshness = elapsedDays !== null && elapsedDays >= 1 && left <= 2
        ? {
            days: elapsedDays,
            left,
            kind: left < 0 ? "over" : "soon",
            label: `買って${elapsedDays}日`
          }
        : null;
      return { item, expiry, freshness };
    })
    .filter(({ expiry, freshness }) => expiry || freshness)
    .sort((a, b) => {
      const urgencyA = Math.min(a.expiry?.days ?? Infinity, a.freshness?.left ?? Infinity);
      const urgencyB = Math.min(b.expiry?.days ?? Infinity, b.freshness?.left ?? Infinity);
      return urgencyA - urgencyB || a.item.name.localeCompare(b.item.name, "ja");
    });
}

function renderExpiringList() {
  const alerts = expiringItems();
  elements.managementExpiring.hidden = alerts.length === 0;
  elements.managementExpiringTitle.textContent = `そろそろ使いたいもの ${alerts.length}件`;

  if (!alerts.length) {
    elements.managementExpiringList.innerHTML = "";
    return;
  }

  elements.managementExpiringList.innerHTML = alerts.map(({ item, expiry, freshness }) => {
    const alertKind = expiry?.kind || (freshness.kind === "over" ? "today" : "soon");
    const labels = [expiry?.label, freshness?.label].filter(Boolean).join("・");
    return `
    <div class="management-expiring-item is-${alertKind}">
      <button class="management-expiring-main" type="button" data-fridge-edit="${escapeHtml(item.id)}">
        ${renderIngredientIllustration(item.id, item.name)}
        <span class="management-expiring-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(item.location)}${expiry ? `・${escapeHtml(formatExpiryDate(item.expiryDate))}` : ""}</small>
        </span>
        <span class="management-expiring-state">${escapeHtml(labels)}</span>
      </button>
      <button class="management-expiring-discard" type="button" data-expiry-discard="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を捨てる">捨てる</button>
    </div>
  `;
  }).join("");
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

function ensureInventoryGaugeBaselines() {
  let changed = false;
  state.inventory.forEach((item) => {
    if (item.active === false || item.quantity <= 0) return;
    const maxQuantity = Number(item.maxQuantity);
    if (!Number.isFinite(maxQuantity) || maxQuantity <= 0 || maxQuantity < item.quantity) {
      item.maxQuantity = item.quantity;
      changed = true;
    }
  });
  if (changed) persistInventory();
}

function ensureInventoryShelves() {
  let changed = false;

  for (const location of INVENTORY_LOCATIONS) {
    const shelfCount = state.shelfCounts[location];
    const items = state.inventory.filter((item) =>
      item.location === location && item.active !== false && item.quantity > 0
    );
    const assigned = items.filter((item) =>
      Number.isInteger(item.shelf) && item.shelf >= 0 && item.shelf < shelfCount
    );
    const missing = items.filter((item) => !assigned.includes(item));
    if (!missing.length) continue;

    // 上の棚から詰める。以前は棚数で割って均等に散らしていたので、
    // 3品を3段の冷蔵室へ入れると1段に1品ずつ浮いた状態になり、
    // 「冷蔵庫が埋まっていく」感じが出なかった（方針書の核）。
    const shelfSizes = Array.from({ length: shelfCount }, (_, shelf) =>
      assigned.filter((item) => item.shelf === shelf).length
    );
    const capacity = STORAGE_SHELF_CAPACITIES[location];
    missing.forEach((item) => {
      const room = shelfSizes.findIndex((size) => size < capacity);
      // どの棚も満杯なら、いちばん少ない棚へ足す（あふれ分は「ほか◯品」で見せる）
      const shelf = room >= 0 ? room : shelfSizes.indexOf(Math.min(...shelfSizes));
      item.shelf = shelf;
      shelfSizes[shelf] += 1;
      changed = true;
    });
  }

  if (changed) persistInventory();
}

function renderInventory() {
  ensureInventoryGaugeBaselines();
  ensureInventoryShelves();
  const active = activeInventory();
  const filtered = active.filter((item) => state.location === "すべて" || item.location === state.location);
  renderExpiryAlerts();
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
        ${renderChangeAttribution("item", item.id)}
      </span>
      <button class="restore-button" type="button" data-action="restore" data-id="${escapeHtml(item.id)}">戻す</button>
    </div>
  `).join("");
  scheduleInventoryScrollLock();
}

// 冷蔵庫画面のお知らせと在庫画面の一覧は、同じ抽出（expiringItems）を使う。
// 別々に書くと、片方だけ条件を直したときに表示が食い違う
function renderExpiryAlerts() {
  const alerts = expiringItems();

  elements.expiryAlert.hidden = alerts.length === 0;
  if (!alerts.length) {
    elements.expiryAlertList.innerHTML = "";
    return;
  }

  elements.expiryAlertTitle.textContent = "そろそろ使いたい食材があります";
  elements.expiryAlertSummary.textContent = `${alerts.length}品`;
  elements.expiryAlertList.innerHTML = alerts.map(({ item, expiry, freshness }) => {
    const alertKind = expiry?.kind || (freshness.kind === "over" ? "today" : "soon");
    const labels = [expiry?.label, freshness?.label].filter(Boolean).join("・");
    return `
    <div class="expiry-alert-item is-${alertKind}">
      <button class="expiry-alert-main" type="button" data-expiry-edit="${escapeHtml(item.id)}">
        ${renderIngredientIllustration(item.id, item.name)}
        <span class="expiry-alert-copy">
          <strong>${escapeHtml(item.name)}</strong>
          ${expiry ? `<small>賞味期限 ${escapeHtml(formatExpiryDate(item.expiryDate))}</small>` : ""}
        </span>
        <span class="expiry-alert-state">${escapeHtml(labels)}</span>
      </button>
      <button class="expiry-alert-discard" type="button" data-expiry-discard="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を捨てる">捨てる</button>
    </div>
  `;
  }).join("");
}

function inventoryLevel(item) {
  const maxQuantity = Number(item.maxQuantity);
  if (!Number.isFinite(maxQuantity) || maxQuantity <= 0) return 1;
  return Math.max(0, Math.min(1, item.quantity / maxQuantity));
}

// 残量は連続の割合ではなく3段階で見せる（方針書「在庫の見せ方」）。
// トップ画面の役目は「あるか、少ないか」が一目で分かることで、
// 78%と74%の違いに意味は無い。境目は翌日の確認と同じ 0.5 / 0.25。
function inventoryLevelState(item) {
  const level = inventoryLevel(item);
  if (level <= 0.25) return { label: "残りわずか", width: 25, className: " is-critical" };
  if (level <= 0.5) return { label: "少なめ", width: 50, className: " is-warning" };
  return { label: "まだあります", width: 100, className: "" };
}

// 料理の完成イラスト。完成絵が準備中の追加レシピは主役食材を代わりに見せる。
function renderRecipeIllustration(recipeId) {
  const illustration = RECIPE_ILLUSTRATIONS[recipeId];
  if (!illustration) {
    const fallbackId = RECIPE_ILLUSTRATION_FALLBACKS[recipeId];
    const item = fallbackId ? illustratedIngredientItem(fallbackId) : null;
    return item
      ? `<span class="recipe-illustration-fallback" aria-hidden="true">${renderIngredientIllustration(item.id, item.name, true)}</span>`
      : "";
  }
  const [column, row, sheet] = illustration;
  const x = ((4.4 * ((column + 0.5) / 4) - 0.5) / 3.4) * 100;
  const y = ((3.3 * ((row + 0.5) / 3) - 0.5) / 2.3) * 100;
  return `<span class="recipe-illustration recipe-illustration-${sheet}" style="--atlas-x:${x}%;--atlas-y:${y}%;" aria-hidden="true"></span>`;
}

function renderFridgeFood(item) {
  const state3 = inventoryLevelState(item);
  const expiry = expiryAlertState(item.expiryDate);
  const expiryLabel = expiry ? `、賞味期限${expiry.label}` : "";
  return `
    <button class="fridge-food${item.priority ? " is-priority" : ""}${expiry ? ` is-expiry-${expiry.kind}` : ""}" type="button" data-fridge-edit="${escapeHtml(item.id)}" data-drag-item="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}、${state3.label}${expiryLabel}。タップで在庫を編集、長押しで棚を移動">
      <span class="food-hp-gauge${state3.className}" aria-hidden="true"><span style="--food-level:${state3.width}%"></span></span>
      ${renderIngredientIllustration(item.id, item.name)}
      ${expiry ? `<span class="food-expiry-badge is-${expiry.kind}" aria-hidden="true">${expiry.kind === "expired" ? "!" : expiry.days}</span>` : ""}
    </button>
  `;
}

function renderShelfAddButton(location, shelf) {
  const storageName = location === "常温" ? "パントリー" : `${location}室`;
  const locationClass = location === "冷凍"
    ? "freezer"
    : location === "常温"
      ? "pantry"
      : "chilled";
  return `
    <button class="shelf-add-food shelf-add-food-${locationClass}" type="button" data-shelf-add="${escapeHtml(location)}" data-shelf-add-index="${shelf}" aria-label="${storageName}${shelf + 1}段目に食材を追加">
      <span aria-hidden="true">＋</span>
    </button>
  `;
}

function renderFridgeShelf(items, location, shelf, showAdd = false) {
  return `
    <div class="fridge-foods">
      ${items.map(renderFridgeFood).join("")}
      ${showAdd ? renderShelfAddButton(location, shelf) : ""}
    </div>
  `;
}

function itemsOnShelf(active, location, shelf) {
  return active.filter((item) => item.location === location && item.shelf === shelf);
}

function addShelfForStorage(shelves, location) {
  return shelves.findIndex((items) => items.length < STORAGE_SHELF_CAPACITIES[location]);
}

// 画面に出す呼び名。常温は「常温室」ではなく「パントリー」と呼んでいる
function storageDisplayName(location) {
  return location === "常温" ? "パントリー" : `${location}室`;
}

function renderShelfControl(location) {
  const count = state.shelfCounts[location];
  const limits = STORAGE_SHELF_LIMITS[location];
  const name = storageDisplayName(location);
  const locationClass = location === "冷凍"
    ? "freezer"
    : location === "常温"
      ? "pantry"
      : "chamber";
  return `
    <div class="shelf-count-control shelf-count-control-${locationClass}">
      <button type="button" data-shelf-location="${location}" data-shelf-change="-1" aria-label="${name}の棚を1段減らす"${count <= limits.min ? " disabled" : ""}>−</button>
      <span aria-live="polite">${count}段</span>
      <button type="button" data-shelf-location="${location}" data-shelf-change="1" aria-label="${name}の棚を1段増やす"${count >= limits.max ? " disabled" : ""}>＋</button>
    </div>
  `;
}

function renderFridgeScene(active) {
  const pantry = active.filter((item) => item.location === "常温");
  const frozenShelves = Array.from(
    { length: state.shelfCounts.冷凍 },
    (_, shelf) => itemsOnShelf(active, "冷凍", shelf)
  );
  const chilledShelves = Array.from(
    { length: state.shelfCounts.冷蔵 },
    (_, shelf) => itemsOnShelf(active, "冷蔵", shelf)
  );
  const pantryShelves = Array.from(
    { length: state.shelfCounts.常温 },
    (_, shelf) => itemsOnShelf(active, "常温", shelf)
  );
  const visibleFrozenShelves = frozenShelves.map((items) =>
    items.slice(0, STORAGE_SHELF_CAPACITIES.冷凍)
  );
  const visibleChilledShelves = chilledShelves.map((items) =>
    items.slice(0, STORAGE_SHELF_CAPACITIES.冷蔵)
  );
  const visiblePantryShelves = pantryShelves.map((items) =>
    items.slice(0, STORAGE_SHELF_CAPACITIES.常温)
  );
  const frozenAddShelf = addShelfForStorage(frozenShelves, "冷凍");
  const chilledAddShelf = addShelfForStorage(chilledShelves, "冷蔵");
  const pantryAddShelf = addShelfForStorage(pantryShelves, "常温");
  const hiddenFridgeCount = frozenShelves.reduce((count, items, shelf) =>
    count + items.length - visibleFrozenShelves[shelf].length, 0)
    + chilledShelves.reduce((count, items, shelf) =>
      count + items.length - visibleChilledShelves[shelf].length, 0);
  const hiddenPantryCount = pantryShelves.reduce((count, items, shelf) =>
    count + items.length - visiblePantryShelves[shelf].length, 0);

  // パントリーは冷蔵庫と同じ筐体で、色だけ木調にして見分ける（本人の指定）。
  // 縦に2台並べず、上のタブで切り替える
  const showPantry = state.fridgeTab === "pantry";
  const heading = document.querySelector("#fridge-visual-title");
  if (heading) heading.textContent = showPantry ? "わたしのパントリー" : "わたしの冷蔵庫";

  const applianceHtml = showPantry
    ? `
    <div class="fridge-appliance is-pantry">
      <div class="fridge-chamber pantry-chamber">
        <span class="fridge-compartment-label">常温ストック</span>
        ${visiblePantryShelves.map((items, shelf) => `
          <div class="fridge-shelf" data-drop-location="常温" data-drop-shelf="${shelf}">
            ${renderFridgeShelf(items, "常温", shelf, shelf === pantryAddShelf)}
          </div>
        `).join("")}
        ${renderShelfControl("常温")}
      </div>
      ${hiddenPantryCount ? `<span class="fridge-overflow">ほか ${hiddenPantryCount}品</span>` : ""}
    </div>`
    : `
    <div class="fridge-appliance">
      <!-- 冷蔵室が上、冷凍室が下。国内の家庭用冷蔵庫の一般的な配置に合わせている（本人の指定） -->
      <div class="fridge-chamber">
        <span class="fridge-light" aria-hidden="true"></span>
        <span class="fridge-compartment-label">冷蔵室</span>
        ${visibleChilledShelves.map((items, shelf) => `
          <div class="fridge-shelf" data-drop-location="冷蔵" data-drop-shelf="${shelf}">
            ${renderFridgeShelf(items, "冷蔵", shelf, shelf === chilledAddShelf)}
          </div>
        `).join("")}
        ${renderShelfControl("冷蔵")}
      </div>
      <div class="fridge-freezer">
        <span class="fridge-compartment-label">冷凍室</span>
        ${visibleFrozenShelves.map((items, shelf) => `
          <div class="freezer-shelf" data-drop-location="冷凍" data-drop-shelf="${shelf}">
            ${renderFridgeShelf(items, "冷凍", shelf, shelf === frozenAddShelf)}
          </div>
        `).join("")}
        ${renderShelfControl("冷凍")}
      </div>
      ${hiddenFridgeCount ? `<span class="fridge-overflow">ほか ${hiddenFridgeCount}品</span>` : ""}
    </div>`;

  elements.fridgeScene.innerHTML = `
    <div class="fridge-unit-tabs" role="group" aria-label="収納を切り替える">
      <button type="button" data-fridge-tab="fridge" class="${showPantry ? "" : "is-active"}" aria-pressed="${!showPantry}">
        冷蔵庫
      </button>
      <button type="button" data-fridge-tab="pantry" class="is-pantry-tab ${showPantry ? "is-active" : ""}" aria-pressed="${showPantry}">
        パントリー${pantry.length ? `<small>${pantry.length}</small>` : ""}
      </button>
    </div>
    ${applianceHtml}

    <section class="food-consume-station" data-consume-drop aria-label="食べて使い切った食材をここへ">
      <div class="food-consume-copy">
        <p class="eyebrow">食べたらここへ</p>
        <strong>ぱくっと使い切り</strong>
        <small>食材を子どもへ運ぶ</small>
      </div>
      <div class="food-child-character" aria-hidden="true">
        <span class="food-child-bubble">ぱくっ</span>
        <img src="assets/food-child-drop-target.png?v=20260724-1" alt="">
      </div>
    </section>
  `;
}

function renderInventoryRow(item) {
  const unknownAmount = quantityUnknown(item);
  const confirmation = confirmationLabel(item);
  const expiry = expiryAlertState(item.expiryDate);
  // 賞味期限は任意登録で、未設定のままがふつう。全行に「未設定」と出しても
  // 読む情報は増えないので、入っているときだけ見せる（設定は行をタップ）。
  const expiryText = normalizedExpiryDate(item.expiryDate)
    ? `賞味期限 ${formatExpiryDate(item.expiryDate)}${expiry ? `・${expiry.label}` : ""}`
    : "";
  return `
    <article class="inventory-row${item.priority ? " is-priority" : ""}">
      <div class="item-identity">
        ${renderIngredientIllustration(item.id, item.name)}
        <button class="item-name-button" type="button" data-action="edit" data-id="${escapeHtml(item.id)}">
          <span class="item-name">${escapeHtml(item.name)}</span>
          <span class="item-meta${confirmation.stale ? " is-stale" : ""}">
            ${escapeHtml(item.location)}・${unknownAmount ? "量は未確認" : confirmation.text}${item.priority ? '<strong>・先に使う</strong>' : ""}
          </span>
          ${expiryText ? `<span class="item-expiry${expiry ? ` is-${expiry.kind}` : ""}">${escapeHtml(expiryText)}</span>` : ""}
          ${renderChangeAttribution("item", item.id)}
        </button>
      </div>

      <div class="quantity-control" aria-label="${escapeHtml(item.name)}の残量">
        <button class="quantity-button" type="button" data-action="decrease" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を減らす">−</button>
        <output class="quantity-output${unknownAmount ? " is-unknown" : ""}"${unknownAmount ? ' title="この量はまだ確認していません"' : ""}>${formatQuantity(item.quantity, item.unit)}</output>
        <button class="quantity-button" type="button" data-action="increase" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を増やす">＋</button>
      </div>

      <div class="row-actions">
        <button class="row-action" type="button" data-action="confirm" data-id="${escapeHtml(item.id)}">まだある</button>
        <button class="row-action${item.priority ? " is-priority" : ""}" type="button" data-action="priority" data-id="${escapeHtml(item.id)}">${item.priority ? "優先を解除" : "先に使う"}</button>
        <button class="row-action" type="button" data-action="consume" data-id="${escapeHtml(item.id)}">使い切った</button>
        <button class="row-action is-delete" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">完全削除</button>
      </div>
    </article>
  `;
}

// 代用の指定を { id, ratio } の形へそろえる。文字列だけのものは、
// 総称と同じ単位で持っている場合にだけ使える（ratio 1）。
function normalizedSubstitute(entry) {
  return typeof entry === "string" ? { id: entry, ratio: null } : entry;
}

// 初期単位（＝標準の単位）を id から引く。換算のたびに配列を走査しないよう一度だけ作る。
const INITIAL_UNIT_BY_ID = new Map(RECEIPT_RULES.map((rule) => [rule.id, rule.unit]));

// 在庫1つ分が、要求の単位でいくつ分に相当するか。換算できなければ null。
function conversionRatio(item, requirement) {
  if (item.id === requirement.id) {
    if (item.unit === requirement.unit) return 1;
    // 同じ食材を別の単位で登録した場合（キャベツを「1個」で入れた等）。
    // 換算表は標準の単位を基準に書いてあるので、在庫側と要求側の両方を
    // 標準の単位へ寄せてから割る。こうするとレシピ側が標準でない単位を
    // 使う場合（ごま油の「小さじ」）も扱える。
    const conversions = UNIT_CONVERSIONS[requirement.id] || {};
    const standardUnit = INITIAL_UNIT_BY_ID.get(item.id);
    // ごはんのように、買うものでないため初期単位を持たない食材は
    // 従来どおり「在庫の単位」を引くだけにする
    if (!standardUnit) return conversions[item.unit] ?? null;
    const itemRatio = item.unit === standardUnit ? 1 : conversions[item.unit];
    const requirementRatio = requirement.unit === standardUnit ? 1 : conversions[requirement.unit];
    return itemRatio && requirementRatio ? itemRatio / requirementRatio : null;
  }

  const entry = (INGREDIENT_SUBSTITUTES[requirement.id] || [])
    .map(normalizedSubstitute)
    .find((candidate) => candidate.id === item.id);
  if (!entry) return null;
  if (entry.ratio === null) return item.unit === requirement.unit ? 1 : null;

  // 換算つきの代用は、その食材の標準の単位で持っているときだけ扱う。
  // 代用と単位変更が二重にかかると、量の推定が当てにならなくなるため。
  // 標準の単位が分からない食材（まだ登録していないもの）も扱わない。
  const rule = RECEIPT_RULES.find((candidate) => candidate.id === item.id);
  if (!rule || item.unit !== rule.unit) return null;
  return entry.ratio;
}

// 要求に対して使える在庫を、要求の単位へ直した数量つきで返す。
// available = 要求の単位での数量、ratio = 在庫1つ分が要求の単位でいくつ分か。
function stockForRequirement(requirement) {
  const inventory = inventoryMap();

  const usable = (item) => {
    if (!item) return null;
    const ratio = conversionRatio(item, requirement);
    return ratio ? { item, ratio, available: item.quantity * ratio } : null;
  };

  const exact = usable(inventory.get(requirement.id));
  if (exact) return exact;

  // 総称そのものが無ければ、代用できる部位・商品を探す（→ INGREDIENT_SUBSTITUTES）
  const substitutes = (INGREDIENT_SUBSTITUTES[requirement.id] || [])
    .map((entry) => usable(inventory.get(normalizedSubstitute(entry).id)))
    .filter(Boolean);
  if (!substitutes.length) return null;

  // 使い切り優先を指定してあるものから先に使う
  return substitutes.find((stock) => stock.item.priority) || substitutes[0];
}

function availableForRequirement(requirement) {
  return stockForRequirement(requirement)?.available ?? 0;
}

// 代用で埋めた材料は、レシピの総称に加えて実際に使う食材の名前も見せる。
// item は呼び出し側が既に求めているものを渡す（inventoryMap の作り直しを避ける）。
function requirementDisplayName(requirement, item) {
  if (!item || item.id === requirement.id) return escapeHtml(requirement.name);
  return `${escapeHtml(requirement.name)}<small class="ingredient-substitute">${escapeHtml(item.name)}で代用</small>`;
}

function requiredAmount(requirement, servings = state.servings) {
  return requirement.quantity * servings;
}

// 不足しているのは「持っていないもの」と「持っているが明らかに足りないもの」。
// 量が未確認のものは、数値を信じて落とすと本当は作れる料理まで消えるため、
// 不足として数えない（代わりに作る直前に量を確認する）。
function shortageFor(recipe, servings = state.servings) {
  return recipe.required.filter((requirement) => {
    const stock = stockForRequirement(requirement);
    if (!stock) return true;
    if (quantityUnknown(stock.item)) return false;
    return stock.available < requiredAmount(requirement, servings);
  });
}

// 作る直前に量を確認したい材料。持っているが数量が未確認のもの。
// 人数には依らない（何人分でも「量を見る」ことは変わらない）。
function unconfirmedFor(recipe) {
  return recipe.required.filter((requirement) => {
    const stock = stockForRequirement(requirement);
    return Boolean(stock) && quantityUnknown(stock.item);
  });
}

// 材料1行の表示。数値だけで決めると、量が未確認の食材に対して
// カード見出しの「材料あり」と行の「足りません」が同時に出る（実際に起きていた）。
// 見出しとボタンの「量を見て作る」に語彙を合わせ、確信度を先に見る。
const REQUIREMENT_LINE_LABELS = {
  enough: { text: "あります", className: "is-ready" },
  unknown: { text: "量は未確認", className: "is-unknown" },
  short: { text: "足りません", className: "is-short" },
  missing: { text: "ありません", className: "is-short" }
};

function requirementLineState(requirement, servings = state.servings) {
  const stock = stockForRequirement(requirement);
  if (!stock) return "missing";
  if (quantityUnknown(stock.item)) return "unknown";
  return stock.available >= requiredAmount(requirement, servings) ? "enough" : "short";
}

// 作るのを止めているもの。answers は作る前の量確認への回答で、
// 未回答は「ある」として扱う（実物を見て違うものだけ外してもらう形）。
function cookBlockers(recipe, servings, answers = {}) {
  const shortages = shortageFor(recipe, servings);
  const unconfirmed = unconfirmedFor(recipe);
  const denied = unconfirmed.filter((requirement) => answers[requirement.id] === false);
  return { shortages, unconfirmed, denied, canCook: !shortages.length && !denied.length };
}

// 「ある」と答えてもらった食材の量を確定する。必要量に届いていなければ
// 必要量まで上げる（本人が実物を見て足りると言っているため）。
// 「足りない」と答えたものは不明のまま残し、次に作るときまた確認する。
function confirmUnknownAmounts(recipe, servings, answers = {}) {
  unconfirmedFor(recipe).forEach((requirement) => {
    if (answers[requirement.id] === false) return;
    const stock = stockForRequirement(requirement);
    if (!stock) return;
    const { item, ratio } = stock;
    const needed = Number(((requirement.quantity * servings) / ratio).toFixed(2));
    item.quantity = Math.max(Number(item.quantity) || 0, needed);
    item.maxQuantity = Math.max(Number(item.maxQuantity) || 0, item.quantity);
    item.quantityConfidence = QUANTITY_CONFIRMED;
    item.confirmedAt = todayIso();
  });
}

function optionalReady(option, servings = state.servings) {
  return availableForRequirement(option) >= option.quantity * servings;
}

function makeShoppingItemId() {
  if (globalThis.crypto?.randomUUID) return `shopping-${crypto.randomUUID()}`;
  return `shopping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function shoppingIngredientId(name) {
  const trimmed = name.trim();
  const known = ALIASES.get(trimmed);
  if (known) return known;
  const existing = [...state.shopping, ...state.inventory].find((item) => item.name === trimmed);
  return existing?.ingredientId || existing?.id || makeId(trimmed);
}

function suggestedLocation(id) {
  return RECEIPT_RULES.find((rule) => rule.id === id)?.location || "冷蔵";
}

function addShoppingItem({
  ingredientId,
  name,
  quantity,
  unit,
  source = "manual",
  reason = "",
  location
}) {
  const existing = state.shopping.find((item) =>
    !item.checked
    && item.ingredientId === ingredientId
    && item.unit === unit
  );

  if (existing) {
    existing.quantity = source === "recommendation"
      ? Math.max(existing.quantity, quantity)
      : Number((existing.quantity + quantity).toFixed(2));
    if (reason) existing.reason = reason;
    return "merged";
  }

  state.shopping.push({
    id: makeShoppingItemId(),
    ingredientId,
    name,
    quantity,
    unit,
    location: location || suggestedLocation(ingredientId),
    source,
    reason,
    checked: false,
    addedAt: todayIso()
  });
  return "added";
}

function shoppingRecommendations() {
  const recommendations = new Map();

  const addRecommendation = (ingredient, recipe, score, reason, unlocksRecipe) => {
    if (!INVENTORY_UNITS.includes(ingredient.unit)) return;
    const currentAmount = availableForRequirement(ingredient);
    const quantity = Number(Math.max(ingredient.quantity - currentAmount, 0).toFixed(2));
    const key = `${ingredient.id}:${ingredient.unit}`;
    const entry = recommendations.get(key) || {
      ingredientId: ingredient.id,
      name: ingredient.name,
      quantity,
      unit: ingredient.unit,
      location: suggestedLocation(ingredient.id),
      score: 0,
      reasons: [],
      unlocks: [],
      bestReason: "",
      bestReasonScore: -Infinity
    };

    entry.quantity = Math.max(entry.quantity, quantity);
    entry.score += score;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    if (score > entry.bestReasonScore) {
      entry.bestReason = reason;
      entry.bestReasonScore = score;
    }
    if (unlocksRecipe && !entry.unlocks.includes(recipe.name)) entry.unlocks.push(recipe.name);
    recommendations.set(key, entry);
  };

  RECIPES.forEach((recipe) => {
    const heldRequired = recipe.required.filter((ingredient) => {
      return availableForRequirement(ingredient) > 0;
    });
    const heldOptional = recipe.optional.filter((ingredient) => {
      return availableForRequirement(ingredient) > 0;
    });
    const connectionCount = heldRequired.length + heldOptional.length;
    if (!connectionCount) return;

    const missingRequired = recipe.required.filter((ingredient) => {
      return availableForRequirement(ingredient) < ingredient.quantity;
    });

    if (missingRequired.length) {
      missingRequired.forEach((ingredient) => {
        const unlocksRecipe = missingRequired.length === 1;
        const score = 24
          + heldRequired.length * 9
          + heldOptional.length * 3
          - missingRequired.length * 7
          + (unlocksRecipe ? 18 : 0);
        const reason = unlocksRecipe
          ? `これで「${recipe.name}」が作れます`
          : `今ある食材と「${recipe.name}」につながります`;
        addRecommendation(ingredient, recipe, score, reason, unlocksRecipe);
      });
      return;
    }

    recipe.optional
      .filter((ingredient) => {
        return availableForRequirement(ingredient) < ingredient.quantity;
      })
      .slice(0, 2)
      .forEach((ingredient) => {
        addRecommendation(
          ingredient,
          recipe,
          7 + heldRequired.length * 2,
          `「${recipe.name}」をもっとおいしく`,
          false
        );
      });
  });

  return [...recommendations.values()]
    .map((recommendation) => ({
      ...recommendation,
      added: state.shopping.some((item) =>
        item.ingredientId === recommendation.ingredientId
        && item.unit === recommendation.unit
      ),
      reason: recommendation.unlocks.length
        ? `これで「${recommendation.unlocks[0]}」が作れます`
        : recommendation.bestReason
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"))
    .slice(0, 6);
}

function renderShoppingRecommendation(recommendation) {
  return `
    <article class="shopping-recommendation${recommendation.added ? " is-added" : ""}">
      ${renderIngredientIllustration(recommendation.ingredientId, recommendation.name, true)}
      <div>
        <h4>${escapeHtml(recommendation.name)} <span>${formatQuantity(recommendation.quantity, recommendation.unit)}</span></h4>
        <p>${escapeHtml(recommendation.reason)}</p>
      </div>
      <button class="recommend-add-button" type="button"
        data-recommend-id="${escapeHtml(recommendation.ingredientId)}"
        data-recommend-unit="${escapeHtml(recommendation.unit)}"
        ${recommendation.added ? "disabled" : ""}>
        ${recommendation.added ? "追加済み" : "追加"}
      </button>
    </article>
  `;
}

function renderShoppingItem(item) {
  return `
    <article class="shopping-item${item.checked ? " is-checked" : ""}">
      <label class="shopping-check">
        <input type="checkbox" data-shopping-check="${escapeHtml(item.id)}"${item.checked ? " checked" : ""}>
        <span class="check-mark" aria-hidden="true"></span>
        <span class="visually-hidden">${escapeHtml(item.name)}を購入済みにする</span>
      </label>
      ${renderIngredientIllustration(item.ingredientId, item.name, true)}
      <div class="shopping-item-copy">
        <strong>${escapeHtml(item.name)} <span>${formatQuantity(item.quantity, item.unit)}</span></strong>
        <small>${item.reason ? escapeHtml(item.reason) : "自分で追加"}</small>
        ${renderChangeAttribution("shopping", item.id)}
      </div>
      <div class="shopping-item-actions">
        ${item.checked ? `<button type="button" data-shopping-stock="${escapeHtml(item.id)}">在庫へ</button>` : ""}
        <button type="button" class="shopping-delete" data-shopping-delete="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を買い物リストから削除">削除</button>
      </div>
    </article>
  `;
}

function renderShoppingCheckItem(item) {
  return `
    <details class="shopping-check-item">
      <summary aria-label="${escapeHtml(item.name)}の詳細を表示">
        ${renderIngredientIllustration(item.ingredientId, item.name)}
        <span class="shopping-check-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(formatQuantity(item.quantity, item.unit))}</small>
        </span>
      </summary>
      <div class="shopping-check-detail">
        <div class="shopping-check-detail-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${formatQuantity(item.quantity, item.unit)}</span>
          <small>${item.reason ? escapeHtml(item.reason) : "自分で追加"}</small>
          ${renderChangeAttribution("shopping", item.id)}
        </div>
        <div class="shopping-check-detail-actions">
          <label class="shopping-purchase-button">
            <input type="checkbox" data-shopping-check="${escapeHtml(item.id)}">
            <span class="check-mark" aria-hidden="true"></span>
            <span>購入済みにする</span>
          </label>
          <button type="button" class="shopping-detail-delete" data-shopping-delete="${escapeHtml(item.id)}">削除</button>
        </div>
      </div>
    </details>
  `;
}

function renderShoppingPicker() {
  const category = ILLUSTRATED_INGREDIENT_CATEGORIES.find(
    (candidate) => candidate.id === state.shoppingPickerCategory
  );
  elements.shoppingCategoryLayer.hidden = Boolean(category);
  elements.shoppingItemLayer.hidden = !category;

  if (!category) {
    elements.shoppingCategoryGrid.innerHTML = displayedIngredientCategories().map((candidate) => `
      <button
        class="shopping-category-button"
        type="button"
        data-shopping-category="${candidate.id}"
        aria-label="${escapeHtml(candidate.name)}から買うものを選ぶ"
      >
        <span class="shopping-category-art" aria-hidden="true">
          ${categoryRepresentatives(candidate).slice(0, 2).map((id) => {
            const item = illustratedIngredientItem(id);
            return item ? renderIngredientIllustration(item.id, item.name) : "";
          }).join("")}
        </span>
        <strong>${escapeHtml(candidate.name)}</strong>
      </button>
    `).join("");
    return;
  }

  elements.shoppingPickerCategoryTitle.textContent = category.name;
  const groups = categoryDisplayGroups(category);
  const total = groups.reduce((count, group) => count + group.items.length, 0);
  const useHeadings = total >= CATEGORY_HEADING_THRESHOLD && groups.length >= 2;

  elements.shoppingFoodGrid.innerHTML = groups.map((group) => `
    <section class="shopping-food-group">
      ${useHeadings ? `<h4 class="shopping-food-group-title">${escapeHtml(group.name)}</h4>` : ""}
      <div class="shopping-food-group-grid">
        ${group.items.map((id) => {
          const item = illustratedIngredientItem(id);
          if (!item) return "";
          const added = state.shopping.some((shoppingItem) =>
            !shoppingItem.checked
            && shoppingItem.ingredientId === item.id
            && shoppingItem.unit === item.unit
          );
          return `
            <button
              class="shopping-food-button${added ? " is-added" : ""}"
              type="button"
              data-shopping-food="${escapeHtml(item.id)}"
              aria-pressed="${added ? "true" : "false"}"
              aria-label="${escapeHtml(item.name)}${added ? "を買うものから外す" : "を買うものに追加"}"
            >
              ${renderIngredientIllustration(item.id, item.name)}
              <strong>${escapeHtml(item.name)}</strong>
              <small>${added ? "✓ 追加済み" : formatQuantity(item.quantity, item.unit)}</small>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `).join("");
}

function renderShopping() {
  renderShoppingPicker();
  const unchecked = state.shopping.filter((item) => !item.checked).length;
  const checked = state.shopping.length - unchecked;
  elements.shoppingOverview.textContent = state.shopping.length
    ? `未購入 ${unchecked}品${checked ? `・購入済み ${checked}品` : ""}`
    : "まだ何もありません";

  elements.shoppingNavCount.textContent = unchecked;
  elements.shoppingNavCount.hidden = unchecked === 0;
  elements.clearBought.hidden = checked === 0;

  const recommendations = shoppingRecommendations();
  elements.shoppingRecommendations.innerHTML = recommendations.length
    ? recommendations.map(renderShoppingRecommendation).join("")
    : '<p class="shopping-empty-recommendation">在庫を増やすと、組み合わせの候補がここに出ます。</p>';

  const waitingItems = state.shopping.filter((item) => !item.checked);
  const boughtItems = state.shopping.filter((item) => item.checked);
  const waitingMarkup = waitingItems.length
    ? `<div class="shopping-check-grid">${waitingItems.map(renderShoppingCheckItem).join("")}</div>`
    : '<p class="shopping-empty-list">店内でチェックするものはありません。</p>';
  const boughtMarkup = boughtItems.length
    ? `
      <details class="shopping-completed">
        <summary>購入済み ${boughtItems.length}品</summary>
        <div class="shopping-completed-list">${boughtItems.map(renderShoppingItem).join("")}</div>
      </details>
    `
    : "";
  elements.shoppingList.innerHTML = waitingMarkup + boughtMarkup;
}

function renderTodayIngredientControl() {
  const inventory = activeInventory();
  const priorityItems = inventory.filter((item) => item.priority);
  elements.todayIngredientName.textContent = priorityItems.length > 1
    ? `${priorityItems.length}品を優先中`
    : priorityItems.length === 1
      ? `${priorityItems[0].name}を優先中`
      : inventory.length
        ? "イラストから選ぶ"
        : "在庫を追加すると選べます";
  elements.todayIngredientArt.innerHTML = priorityItems.length
    ? priorityItems.slice(0, 3).map((item, index) => `
      <span class="today-ingredient-art-piece" style="--priority-art-index:${index};">
        ${renderIngredientIllustration(item.id, item.name)}
      </span>
    `).join("")
    : '<span class="today-ingredient-empty-art"><span>＋</span></span>';
  elements.todayIngredientTrigger.setAttribute(
    "aria-label",
    priorityItems.length
      ? `今日使いたい食材は${priorityItems.map((item) => item.name).join("、")}です。タップして選び直す`
      : "今日使いたい食材を冷蔵庫から選ぶ"
  );
  elements.prioritySelect.value = state.priority === "quick" ? "quick" : "no-shop";
  renderTodayIngredientOptions();
}

function renderTodayIngredientOptions() {
  const inventory = activeInventory();
  const groups = [
    { location: "冷凍", label: "冷凍室", className: "is-freezer" },
    { location: "冷蔵", label: "冷蔵室", className: "is-fridge" },
    { location: "常温", label: "パントリー", className: "is-pantry" }
  ];

  elements.todayIngredientOptions.innerHTML = groups.map((group) => {
    const items = inventory.filter((item) => item.location === group.location);
    const foods = items.length
      ? items.map((item) => `
        <button
          class="priority-food-option${item.priority ? " is-selected" : ""}"
          type="button"
          data-today-ingredient="${escapeHtml(item.id)}"
          aria-pressed="${item.priority ? "true" : "false"}"
          aria-label="${escapeHtml(item.name)}を今日使いたい食材にする"
        >
          ${renderIngredientIllustration(item.id, item.name)}
          <span>${escapeHtml(item.name)}</span>
        </button>
      `).join("")
      : '<small class="priority-fridge-empty">食材はまだありません</small>';

    return `
      <section class="priority-fridge-compartment ${group.className}">
        <h3>${group.label}</h3>
        <div class="priority-fridge-foods">${foods}</div>
      </section>
    `;
  }).join("");
  elements.clearTodayIngredient.classList.toggle(
    "is-active",
    inventory.every((item) => !item.priority)
  );
}

function setTodayIngredientPriority(selectedId) {
  state.inventory.forEach((item) => {
    item.priority = item.active !== false && item.id === selectedId;
  });
  state.visibleRecipeCount = RECIPE_PAGE_SIZE;
  persistInventory();
  renderAll();
}

function openTodayIngredientDialog() {
  renderTodayIngredientOptions();
  elements.todayIngredientDialog.showModal();
  requestAnimationFrame(() => {
    const selected = elements.todayIngredientOptions.querySelector(".priority-food-option.is-selected");
    (selected || elements.todayIngredientOptions.querySelector(".priority-food-option") || elements.clearTodayIngredient).focus();
  });
}

function closeTodayIngredientDialog() {
  if (elements.todayIngredientDialog.open) elements.todayIngredientDialog.close();
}

function seasonalRecipeState(recipe, date = new Date()) {
  const month = date.getMonth() + 1;
  const seasonalIds = new Set(SEASONAL_INGREDIENTS[month] || []);
  const explicit = (SEASONAL_RECIPE_MONTHS[recipe.id] || []).includes(month);
  const ingredientHits = [...recipe.required, ...recipe.optional]
    .filter((ingredient) => seasonalIds.has(ingredient.id)).length;
  return {
    month,
    explicit,
    ingredientHits,
    boost: (explicit ? 14 : 0) + Math.min(ingredientHits, 3) * 3
  };
}

function renderSeasonalGuide() {
  const month = new Date().getMonth() + 1;
  const inventoryIds = new Set(activeInventory().flatMap((item) => {
    const generic = SUBSTITUTE_GENERICS.get(item.id);
    return generic ? [item.id, generic] : [item.id];
  }));
  const items = (SEASONAL_INGREDIENTS[month] || [])
    .map((id) => illustratedIngredientItem(id))
    .filter(Boolean);
  elements.seasonalGuide.innerHTML = `
    <div class="seasonal-guide-heading">
      <div>
        <span>${month}月</span>
        <strong>この時期のおすすめ</strong>
      </div>
      <small>旬は地域や品種で前後します</small>
    </div>
    <div class="seasonal-food-list">
      ${items.map((item) => `
        <span class="seasonal-food${inventoryIds.has(item.id) ? " is-stocked" : ""}">
          ${renderIngredientIllustration(item.id, item.name, true)}
          <span>${escapeHtml(item.name)}</span>
          ${inventoryIds.has(item.id) ? "<em>在庫あり</em>" : ""}
        </span>
      `).join("")}
    </div>
  `;
}

function priorityIngredientUse(recipe) {
  // 「先に使う」を指定した食材が部位・商品のときは、総称の要求にも効かせる
  const priorityIds = new Set();
  activeInventory().filter((item) => item.priority).forEach((item) => {
    priorityIds.add(item.id);
    const generic = SUBSTITUTE_GENERICS.get(item.id);
    if (generic) priorityIds.add(generic);
  });
  return [...recipe.required, ...recipe.optional]
    .filter((ingredient) => priorityIds.has(ingredient.id)).length;
}

function recipeScore(recipe) {
  const shortagePenalty = shortageFor(recipe, RECIPE_LIST_SERVINGS).length * 100;
  const priorityBoost = priorityIngredientUse(recipe) * 40;
  const seasonBoost = seasonalRecipeState(recipe).boost;
  if (state.priority === "quick") return priorityBoost + seasonBoost + 30 - recipe.minutes - shortagePenalty;
  return priorityBoost + seasonBoost + 50 - shortagePenalty - recipe.minutes / 10;
}

function compareRecipes(a, b) {
  // 旬は使いたい食材が無いときの手がかり。利用者が選んだ意思を先にする。
  const aPriorityUse = priorityIngredientUse(a);
  const bPriorityUse = priorityIngredientUse(b);
  if ((aPriorityUse === 0) !== (bPriorityUse === 0)) return aPriorityUse > 0 ? -1 : 1;

  if (state.priority === "quick") {
    const shortageDifference = shortageFor(a, RECIPE_LIST_SERVINGS).length
      - shortageFor(b, RECIPE_LIST_SERVINGS).length;
    if (shortageDifference) return shortageDifference;
    const minuteDifference = a.minutes - b.minutes;
    if (minuteDifference) return minuteDifference;
  }
  return recipeScore(b) - recipeScore(a);
}

function renderRecipes() {
  renderTodayIngredientControl();
  renderSeasonalGuide();
  const ordered = [...RECIPES].sort(compareRecipes);
  const visibleCount = Math.min(state.visibleRecipeCount, ordered.length);
  const visible = ordered.slice(0, visibleCount);
  elements.recipeList.innerHTML = visible.map((recipe, index) => renderRecipe(recipe, index)).join("");
  elements.recipeMore.hidden = visibleCount >= ordered.length;
  elements.recipeVisibleCount.textContent = `${visibleCount} / ${ordered.length}件を表示`;
}

function renderRecipe(recipe, index) {
  const shortages = shortageFor(recipe, RECIPE_LIST_SERVINGS);
  const featured = index === 0;
  const searchQuery = encodeURIComponent(recipe.name);
  const googleSearchUrl = `https://www.google.com/search?q=${searchQuery}`;
  const youtubeSearchUrl = `https://www.youtube.com/results?search_query=${searchQuery}`;
  // 文言は方針書「初回オンボーディングの設計」で確定したもの。
  // 「作れそう」は判断をユーザーへ投げ返すため却下している。
  const status = shortages.length
    ? `あと ${shortages.map((item) => `${item.name}${formatQuantity(requiredAmount(item, RECIPE_LIST_SERVINGS), item.unit)}`).join("、")}`
    : "材料あり";
  const ingredientSummary = recipe.required.map((requirement) => `
    <span class="${shortages.some((item) => item.id === requirement.id) ? "is-missing" : ""}">
      ${renderIngredientIllustration(requirement.id, requirement.name, true)}
      ${escapeHtml(requirement.name)}
    </span>
  `).join("");
  const quickSteps = (RECIPE_STEPS[recipe.id] || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const nutrition = estimateRecipeNutrition(recipe);
  const seasonal = seasonalRecipeState(recipe);

  const requiredLines = recipe.required.map((requirement) => {
    const stock = stockForRequirement(requirement);
    const item = stock?.item || null;
    const line = REQUIREMENT_LINE_LABELS[requirementLineState(requirement, RECIPE_LIST_SERVINGS)];
    return `
      <li class="ingredient-line">
        <span class="ingredient-with-icon">
          ${renderIngredientIllustration(item?.id || requirement.id, item?.name || requirement.name, true)}
          <span>${requirementDisplayName(requirement, item)} ${formatQuantity(requiredAmount(requirement, RECIPE_LIST_SERVINGS), requirement.unit)}</span>
        </span>
        <span class="ingredient-state ${line.className}">${line.text}</span>
      </li>
    `;
  }).join("");

  const optionalLines = recipe.optional.map((option) => {
    const ready = optionalReady(option, RECIPE_LIST_SERVINGS);
    const key = `${recipe.id}:${option.id}`;
    const checked = ready && state.selectedOptionals[key] !== false;
    return `
      <li>
        <label class="optional-choice">
          <input type="checkbox" data-optional="${escapeHtml(key)}"${checked ? " checked" : ""}${ready ? "" : " disabled"}>
          <span class="ingredient-with-icon">
            ${renderIngredientIllustration(option.id, option.name, true)}
            <span>
              ${escapeHtml(option.name)} ${formatQuantity(option.quantity * RECIPE_LIST_SERVINGS, option.unit)}
              <small>${escapeHtml(option.benefit)}・${ready ? "冷蔵庫にあります" : "なくても作れます"}</small>
            </span>
          </span>
        </label>
      </li>
    `;
  }).join("");

  return `
    <article class="recipe${featured ? " is-featured" : " is-alternative"}">
      <div class="recipe-heading-row">
        ${renderRecipeIllustration(recipe.id)}
        <div>
          <p class="recipe-rank">${featured ? "今日のおすすめ" : "ほかの候補"}</p>
          <h3>${escapeHtml(recipe.name)}</h3>
          ${seasonal.explicit ? `<span class="recipe-season-badge">${seasonal.month}月のおすすめ</span>` : ""}
        </div>
        <nav class="recipe-search-links" aria-label="${escapeHtml(recipe.name)}を外部サイトで検索">
          <a class="recipe-search-link is-google" href="${googleSearchUrl}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(recipe.name)}をGoogleで検索" title="Googleで検索">
            <span class="recipe-search-icon is-magnifier" aria-hidden="true"></span>
          </a>
          <a class="recipe-search-link is-youtube" href="${youtubeSearchUrl}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(recipe.name)}をYouTubeで検索" title="YouTubeで検索">
            <span class="recipe-search-icon is-youtube-play" aria-hidden="true"></span>
          </a>
        </nav>
      </div>
      <p class="recipe-meta">調理時間の目安 約${recipe.minutes}分</p>
      ${state.settings.showNutrition ? `
      <p class="recipe-nutrition" aria-label="1人分の栄養目安">
        <span>約${nutrition.kcal} kcal</span>
        <span>P ${nutrition.p}g</span>
        <span>F ${nutrition.f}g</span>
        <span>C ${nutrition.c}g</span>
      </p>` : ""}
      <div class="recipe-ingredient-summary" aria-label="主に使う食材">${ingredientSummary}</div>
      <p class="recipe-status${shortages.length ? " is-missing" : ""}">${status}</p>

      <details class="quick-recipe">
        <summary>
          <span>簡単な作り方</span>
          <small>3手順を見る</small>
        </summary>
        <ol>${quickSteps}</ol>
        <p class="recipe-steps-note">手順は要点だけの簡易版です。加熱時間や細かい下ごしらえは、検索ボタンから詳しいレシピを見てください。肉・魚は中心まで火を通してください。</p>
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
      </details>

      <button class="button button-primary cook-button" type="button" data-cook="${escapeHtml(recipe.id)}"${shortages.length ? " disabled" : ""}>
        ${shortages.length
          ? "材料が足りません"
          : (unconfirmedFor(recipe).length ? "量を見て作る" : "これを作る")}
      </button>
    </article>
  `;
}

function formatCookingTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatChangedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function changeAttributionText(kind, id) {
  // 「誰がいつ変えたか」は相手がいるときだけ意味を持つ。共有していない端末では
  // 全行に自分の端末名が並ぶだけで、読む情報が増えないまま行が縦に伸びる。
  if (!state.share.fridgeId) return "";
  const meta = state.syncMeta[`${kind}:${id}`];
  const when = formatChangedTime(meta?.changedAt);
  if (!when) return "";
  const device = typeof meta?.changedBy?.name === "string" && meta.changedBy.name.trim()
    ? meta.changedBy.name.trim()
    : "端末不明";
  return `最終変更 ${when}・${device}`;
}

function renderChangeAttribution(kind, id) {
  const text = changeAttributionText(kind, id);
  return text ? `<span class="change-attribution">${escapeHtml(text)}</span>` : "";
}

function historyEntryType(entry) {
  return entry?.type || "cooking";
}

function historyEntryTime(entry) {
  return entry?.occurredAt || entry?.cookedAt;
}

function adjustmentSummary(change) {
  const before = change.before || {};
  const after = change.after || {};
  const parts = [];
  if (before.name !== after.name) parts.push(`${before.name || "名称なし"} → ${after.name || "名称なし"}`);
  if (before.quantity !== after.quantity || before.unit !== after.unit) {
    parts.push(`${formatQuantity(before.quantity, before.unit)} → ${formatQuantity(after.quantity, after.unit)}`);
  }
  if (before.location !== after.location) parts.push(`${before.location || "場所不明"} → ${after.location || "場所不明"}`);
  if (before.expiryDate !== after.expiryDate) {
    const beforeDate = before.expiryDate ? formatExpiryDate(before.expiryDate) : "未設定";
    const afterDate = after.expiryDate ? formatExpiryDate(after.expiryDate) : "未設定";
    parts.push(`賞味期限 ${beforeDate} → ${afterDate}`);
  }
  if (before.active !== after.active) parts.push(after.active === false ? "在庫から外した" : "在庫へ戻した");
  return parts.join("・") || "在庫情報を確認";
}

function historyMonthKey(entry) {
  const date = new Date(historyEntryTime(entry));
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function historyMonthLabel(entry) {
  const date = new Date(historyEntryTime(entry));
  if (Number.isNaN(date.getTime())) return "日付不明";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long"
  }).format(date);
}

function renderHistoryEntry(entry) {
  const type = historyEntryType(entry);
  const undone = Boolean(entry.undoneAt);
  const isCooking = type === "cooking";
  const isAdjustment = type === "adjustment";
  const changes = isAdjustment
    ? ""
    : entry.changes.map((change) => `
      <li>
        ${renderIngredientIllustration(change.itemId, change.name, true)}
        <span>${escapeHtml(change.name)}</span>
        <strong>−${formatQuantity(change.quantity, change.unit)}</strong>
      </li>
    `).join("");
  const title = isCooking
    ? entry.recipeName
    : entry.title || entry.changes?.[0]?.name || "在庫の変更";
  const stateLabel = undone
    ? "取り消し済み"
    : isCooking
      ? (entry.editedAt ? "修正済み" : "在庫に反映済み")
      : type === "discard"
        ? "廃棄"
        : type === "consume"
          ? "使い切り"
          : "在庫修正";
  const timeSuffix = isCooking ? `・${Number(entry.servings) || 1}人分` : "";
  const adjustment = isAdjustment
    ? `<p class="history-summary">${escapeHtml(adjustmentSummary(entry.changes[0] || {}))}</p>`
    : `<ul class="history-changes" aria-label="減った食材">${changes}</ul>`;
  const actions = isCooking
    ? `<div class="history-entry-actions">
        <button class="history-edit-button" type="button" data-history-edit="${escapeHtml(entry.id)}"${undone ? " disabled" : ""}>使った食材を修正</button>
        <button class="history-undo-button" type="button" data-history-undo="${escapeHtml(entry.id)}"${undone ? " disabled" : ""}>
          ${undone ? "取り消しました" : "この調理を取り消す"}
        </button>
      </div>`
    : "";

  return `
    <article class="history-entry is-${escapeHtml(type)}${undone ? " is-undone" : ""}">
      <div class="history-entry-heading">
        <div>
          <p class="history-time">${escapeHtml(formatCookingTime(historyEntryTime(entry)))}${timeSuffix}</p>
          <h3>${escapeHtml(title)}</h3>
          ${renderChangeAttribution("cooking", entry.id)}
        </div>
        <span class="history-state">${stateLabel}</span>
      </div>
      ${adjustment}
      ${actions}
    </article>
  `;
}

function renderCookingHistory() {
  if (!state.cookingHistory.length) {
    elements.cookingHistoryList.innerHTML = `
      <div class="history-empty">
        <svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 10.7h12v5.5a3.3 3.3 0 0 1-3.3 3.3H9.3A3.3 3.3 0 0 1 6 16.2Z"/><path d="M4.4 10.7h15.2"/><path d="M6 13h-2.6"/><path d="M18 13h2.6"/><path d="M9.6 8c.8-1.1.8-2.3 0-3.4"/><path d="M14.4 8c.8-1.1.8-2.3 0-3.4"/></svg>
        <p><strong>まだ履歴はありません</strong><br>調理・使い切り・廃棄・在庫の修正がここに記録されます。</p>
      </div>
    `;
    return;
  }

  const orderedHistory = [...state.cookingHistory].sort((a, b) => {
    const aTime = Date.parse(historyEntryTime(a)) || 0;
    const bTime = Date.parse(historyEntryTime(b)) || 0;
    return bTime - aTime;
  });
  const visibleCount = Math.min(state.historyVisibleCount, orderedHistory.length);
  const groups = [];
  orderedHistory.slice(0, visibleCount).forEach((entry) => {
    const key = historyMonthKey(entry);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label: historyMonthLabel(entry), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  });
  const remaining = orderedHistory.length - visibleCount;
  const months = groups.map((group) => `
    <section class="history-month" aria-labelledby="history-month-${escapeHtml(group.key)}">
      <h3 class="history-month-title" id="history-month-${escapeHtml(group.key)}">${escapeHtml(group.label)}</h3>
      <div class="history-month-entries">${group.entries.map(renderHistoryEntry).join("")}</div>
    </section>
  `).join("");
  const more = remaining > 0
    ? `<button class="history-more-button" type="button" data-history-more>
        <span>さらに${Math.min(HISTORY_PAGE_SIZE, remaining)}件見る</span>
        <small>${visibleCount} / ${state.cookingHistory.length}件を表示</small>
      </button>`
    : `<p class="history-count-note">${state.cookingHistory.length}件すべて表示しています</p>`;
  elements.cookingHistoryList.innerHTML = months + more;
}

// ---- 初回登録 ------------------------------------------------------------
// 「最初の一食を決める過程をそのまま登録にする」。指標は登録完了率ではなく、
// 最初の正直で有用な提案までの時間（PRODUCT_DIRECTION.md）。

const ONBOARDING_MAX_LEADS = 2;
const ONBOARDING_EXTRA_LIMIT = 6;

// 持っている食材で、この材料を満たせるか。代用も見る
function ownedCovers(requirement, owned) {
  if (owned.has(requirement.id)) return true;
  return (INGREDIENT_SUBSTITUTES[requirement.id] || [])
    .some((entry) => owned.has(normalizedSubstitute(entry).id));
}

// 主役から料理候補を出す。2品目は**両方必須にしない**。
// 実データで、両方必須にすると0件になる組み合わせがある（鶏ひき肉＋鶏むね肉など）。
// 両方使うレシピを上に、片方だけのレシピも候補に残す。
function onboardingCandidates(leads, extras) {
  const owned = new Set([...leads, ...extras]);
  const leadSet = new Set(leads);
  const ranked = RECIPES
    .map((recipe) => {
      let leadHits = 0;
      let covered = 0;
      for (const requirement of recipe.required) {
        if (ownedCovers(requirement, leadSet)) leadHits += 1;
        if (ownedCovers(requirement, owned)) covered += 1;
      }
      return { recipe, leadHits, missing: recipe.required.length - covered };
    })
    .filter((entry) => entry.leadHits > 0)
    .sort((a, b) =>
      b.leadHits - a.leadHits
      || a.missing - b.missing
      || a.recipe.minutes - b.recipe.minutes)
    .map((entry) => entry.recipe);

  if (leads.length < 2) return ranked;

  // 両方を使うレシピが無い組み合わせがある（豚こま＋卵は0件）。そのまま並べると
  // 材料の少ない側だけが上に来て、**選んだのに一度も出てこない主役**が生まれる。
  // 聞いた意味が無くなるので、それぞれの最上位を先に持ってくる。
  const uses = (recipe, id) =>
    recipe.required.some((requirement) => ownedCovers(requirement, new Set([id])));
  const promoted = [];
  for (const id of leads) {
    const best = ranked.find((recipe) => uses(recipe, id) && !promoted.includes(recipe));
    if (best) promoted.push(best);
  }
  return [...promoted, ...ranked.filter((recipe) => !promoted.includes(recipe))];
}

// 候補を分けるのに効く食材。上位の候補で多く使われていて、まだ持っていないもの。
// ここで全部の食材を並べると「カテゴリー式7画面」に戻ってしまうので、少数に絞る。
function onboardingExtraChoices(leads) {
  const leadSet = new Set(leads);
  const counts = new Map();
  for (const recipe of onboardingCandidates(leads, []).slice(0, 8)) {
    for (const requirement of recipe.required) {
      if (ownedCovers(requirement, leadSet)) continue;
      if (!INGREDIENT_ILLUSTRATIONS[requirement.id]) continue;
      if (!illustratedIngredientItem(requirement.id)) continue;
      counts.set(requirement.id, (counts.get(requirement.id) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ONBOARDING_EXTRA_LIMIT)
    .map(([id]) => id);
}

function onboardingTile(id, selected) {
  const item = illustratedIngredientItem(id);
  if (!item) return "";
  return `
    <button
      type="button"
      class="onboarding-tile${selected ? " is-selected" : ""}"
      data-onboarding-pick="${escapeHtml(id)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      ${renderIngredientIllustration(item.id, item.name)}
      <span>${escapeHtml(item.name)}</span>
    </button>
  `;
}

function renderOnboarding() {
  const { step, leads, extras } = state.onboarding;

  if (step === 1) {
    elements.onboardingStepLabel.textContent = "はじめに";
    elements.onboardingTitle.textContent = "今夜、何を使いますか？";
    elements.onboardingLead.textContent = leads.length >= ONBOARDING_MAX_LEADS
      ? "2つまで選べます。変えるときは、もう一度タップして外してください。"
      : "1つでも2つでも。あとから増やせます。";
    elements.onboardingLeads.hidden = false;
    elements.onboardingExtras.hidden = true;
    elements.onboardingLeads.innerHTML = LEAD_INGREDIENTS.map((group) => `
      <div class="onboarding-group">
        <h3>${escapeHtml(group.name)}</h3>
        <div class="onboarding-tile-grid">
          ${group.ids.map((id) => onboardingTile(id, leads.includes(id))).join("")}
        </div>
      </div>
    `).join("");
    elements.onboardingNext.disabled = leads.length === 0;
    elements.onboardingNext.textContent = "候補を見る";
    elements.onboardingSkip.textContent = "あとで入れる";
    return;
  }

  const candidates = onboardingCandidates(leads, extras).slice(0, 3);
  const choices = onboardingExtraChoices(leads);
  const leadNames = leads.map((id) => illustratedIngredientItem(id)?.name || id).join("と");

  elements.onboardingStepLabel.textContent = "あと1問";
  elements.onboardingTitle.textContent = `${leadNames}で作れそうな料理`;
  elements.onboardingLead.textContent = "下の食材のうち、家にあるものをタップしてください。候補が絞られます。";
  elements.onboardingLeads.hidden = true;
  elements.onboardingExtras.hidden = false;

  elements.onboardingPreview.innerHTML = candidates.length
    ? candidates.map((recipe, at) => {
      const shortages = recipe.required.filter(
        (requirement) => !ownedCovers(requirement, new Set([...leads, ...extras]))
      );
      return `
        <div class="onboarding-candidate${at === 0 ? " is-top" : ""}">
          <strong>${escapeHtml(recipe.name)}</strong>
          <small>${shortages.length
            ? `あと ${shortages.map((item) => item.name).join("、")}`
            : "材料あり"}</small>
        </div>
      `;
    }).join("")
    : `<p class="onboarding-empty">この組み合わせに合う料理がまだありません。次の画面で食材を足してください。</p>`;

  elements.onboardingExtraGrid.innerHTML = choices
    .map((id) => onboardingTile(id, extras.includes(id)))
    .join("");
  elements.onboardingNext.disabled = false;
  elements.onboardingNext.textContent = "これで始める";
  elements.onboardingSkip.textContent = "主役を選び直す";
}

// 登録は「ある・量は不明」で入れる。数量を聞かずに始められるようにするためで、
// 量は最初に料理を作るときに確認する（→ unconfirmedFor / cookBlockers）。
function finishOnboarding() {
  const { leads, extras } = state.onboarding;
  for (const id of [...leads, ...extras]) {
    const item = illustratedIngredientItem(id);
    if (!item) continue;
    addOrMergeInventoryItem({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      location: item.location,
      confidence: QUANTITY_UNKNOWN
    });
    rememberRecentIngredient(id);
  }
  persistInventory();
  state.needsOnboarding = false;
  persistSettings();
  renderAll();
  // 主役を選んだ人には、その主役の候補から見せる
  showView(leads.length ? "suggestions" : "inventory");
}

function startOnboarding() {
  state.onboarding = { step: 1, leads: [], extras: [] };
  renderOnboarding();
  showView("onboarding");
}

// 在庫の一覧は独立した画面ではなく「冷蔵庫」タブの中の別の見せ方。
// タブは4つのままにして、現在地は冷蔵庫を点ける。
const NAV_VIEW_ALIAS = { management: "inventory" };

function showView(viewName) {
  // 初回登録の途中は下のタブを隠す。まだ「どの画面」でもないため
  elements.bottomNav.hidden = viewName === "onboarding" || viewName === "refine";
  elements.onboardingView.hidden = viewName !== "onboarding";
  elements.refineView.hidden = viewName !== "refine";
  // ヘッダーはタイトルを持たない細い帯（バージョン＋設定）になったので、
  // どの画面でも出したままにする。バージョンを常に見せておくため
  elements.inventoryView.hidden = viewName !== "inventory";
  elements.managementView.hidden = viewName !== "management";
  elements.suggestionsView.hidden = viewName !== "suggestions";
  elements.shoppingView.hidden = viewName !== "shopping";
  elements.historyView.hidden = viewName !== "history";
  const navView = NAV_VIEW_ALIAS[viewName] || viewName;
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.view === navView;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  if (viewName === "suggestions") renderRecipes();
  if (viewName === "shopping") renderShopping();
  if (viewName === "history") renderCookingHistory();
  window.scrollTo({ top: 0, behavior: "auto" });
  scheduleInventoryScrollLock();
}

let inventoryScrollLockFrame = 0;

function updateInventoryScrollLock() {
  inventoryScrollLockFrame = 0;
  const shell = document.querySelector(".app-shell");
  const inventoryIsVisible = !elements.inventoryView.hidden && !elements.bottomNav.hidden;
  const viewportHeight = Math.floor(window.visualViewport?.height || window.innerHeight);
  // fixed のナビは文書高に入らないが、main の余白で同じ高さを確保している。
  // scrollHeight が表示領域以下なら、縦パン自体を止めてiOSの端の揺れも出さない。
  const fits = Boolean(
    shell
    && inventoryIsVisible
    && Math.ceil(shell.scrollHeight) <= viewportHeight + 2
  );

  if (fits && window.scrollY) window.scrollTo({ top: 0, behavior: "auto" });
  document.documentElement.classList.toggle("is-inventory-fit", fits);
  document.body.classList.toggle("is-inventory-fit", fits);
}

function scheduleInventoryScrollLock() {
  if (inventoryScrollLockFrame) cancelAnimationFrame(inventoryScrollLockFrame);
  inventoryScrollLockFrame = requestAnimationFrame(updateInventoryScrollLock);
}

function normalizedReceiptLine(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[|｜]/g, " ")
    .replace(/[●■◆◇※*＊]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 端末内OCRは濁点・半濁点を取り違えやすい。実機のレシートでは「バターロール」が
// 「パターロール」と読まれ、候補を1件も作れなかった。照合前に濁点・半濁点を落として
// 同じ形へ寄せるための変換。
function withoutKanaMarks(value) {
  return String(value).normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
}

// 各ルールの濁点なし版は、必要になった時だけ作って覚えておく。
const looseRulePatterns = new WeakMap();

function looseRulePattern(rule) {
  let pattern = looseRulePatterns.get(rule);
  if (!pattern) {
    pattern = new RegExp(withoutKanaMarks(rule.pattern.source), rule.pattern.flags);
    looseRulePatterns.set(rule, pattern);
  }
  return pattern;
}

function receiptRuleForLine(compactLine) {
  const strict = RECEIPT_RULES.find((candidate) => candidate.pattern.test(compactLine));
  if (strict) return strict;

  // 濁点・半濁点を無視すると当たる範囲が広がり誤検出も増えるので、
  // 通常の照合で決まらなかった行だけを対象にする。
  const looseLine = withoutKanaMarks(compactLine);
  return RECEIPT_RULES.find((candidate) => looseRulePattern(candidate).test(looseLine));
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
  // 店名の行。地名がそのまま食材名になることがある
  // （「seiyu蓮根店」の蓮根をレンコンとして拾ってしまった実例がある）。
  // 商品名が「店」で終わることはまず無いので、行末の「店」で見分ける。
  const storeLine = /(?:店$|支店|株式会社|有限会社|\(株\)|（株）|〒)/;
  const candidates = [];

  String(rawText).split(/\r?\n/).forEach((rawLine) => {
    const line = normalizedReceiptLine(rawLine);
    const compactLine = line.replace(/\s+/g, "");
    if (compactLine.length < 2 || ignoredLine.test(compactLine)) return;
    if (storeLine.test(compactLine)) return;

    const rule = receiptRuleForLine(compactLine);
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
  // 候補が作れなかった原因を追えるよう、成功・失敗のどちらでも読み取り結果を残す
  elements.receiptRaw.hidden = false;

  if (!state.receiptCandidates.length) {
    elements.receiptRaw.open = true;
    showReceiptError("文字は読み取れましたが、登録できる一般的な食材を見つけられませんでした。下の「読み取った元の文字」を確認してください。");
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
  elements.receiptRaw.hidden = true;
  elements.receiptRaw.open = false;
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

function addOrMergeInventoryItem({
  name,
  quantity,
  unit,
  location,
  priority = false,
  expiryDate = null,
  shelf = null,
  confidence = QUANTITY_CONFIRMED
}) {
  const canonicalId = ALIASES.get(name) || makeId(name);
  const existing = state.inventory.find((item) =>
    item.id === canonicalId || item.name === name
  );

  if (existing) {
    const wasInactive = existing.active === false;
    const sameUnit = existing.unit === unit;
    if (existing.location !== location || wasInactive) delete existing.shelf;
    existing.quantity = !wasInactive && sameUnit
      ? Number((existing.quantity + quantity).toFixed(2))
      : quantity;
    existing.maxQuantity = wasInactive || !sameUnit
      ? existing.quantity
      : Math.max(Number(existing.maxQuantity) || 0, existing.quantity);
    existing.unit = unit;
    existing.location = location;
    existing.priority = existing.priority || priority;
    if (expiryDate !== null) existing.expiryDate = normalizedExpiryDate(expiryDate);
    existing.active = true;
    existing.confirmedAt = todayIso();
    existing.step = stepForUnit(unit);
    // 数量を置き換えたなら新しい確信度。足し合わせたなら、
    // 元が不確かなら合計も不確かなので低いほうへ寄せる
    existing.quantityConfidence = wasInactive || !sameUnit
      ? confidence
      : lessCertain(quantityConfidence(existing), confidence);
    if (Number.isInteger(shelf)) existing.shelf = shelf;
    delete existing.consumedAt;
    return "merged";
  }

  const item = {
    id: canonicalId,
    name,
    quantity,
    unit,
    location,
    priority,
    active: true,
    addedAt: todayIso(),
    confirmedAt: todayIso(),
    step: stepForUnit(unit),
    maxQuantity: quantity,
    quantityConfidence: confidence
  };
  item.expiryDate = expiryDate === null ? "" : normalizedExpiryDate(expiryDate);
  if (Number.isInteger(shelf)) item.shelf = shelf;
  state.inventory.push(item);
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
      location: row.querySelector("[data-receipt-location]").value,
      // レシートの数量は、商品名から引いた標準の買い方を初期値にしている。
      // 直さずに通した分は実物と違いうるので、確認済みとは区別する
      confidence: QUANTITY_ESTIMATED
    });
  }

  entries.forEach(addOrMergeInventoryItem);
  persistInventory();
  renderAll();
  closeReceiptDialog();
  showView("management");
  showToast(`レシートから${entries.length}品を在庫に追加しました`);
}

function openIngredientDialog(item = null, preferredLocation = null, preferredShelf = null) {
  elements.form.reset();
  state.ingredientNameSuggestion = null;
  state.dismissedIngredientSuggestionFor = "";
  state.ingredientTargetShelf = null;
  state.ingredientPreferredLocation = preferredLocation
    || (state.location === "すべて" ? null : state.location);
  state.ingredientPickerCategory = null;
  state.selectedIngredientCatalogId = null;
  elements.nameSuggestion.hidden = true;
  elements.ingredientPicker.hidden = true;
  elements.ingredientDetails.hidden = true;
  elements.selectedIngredientPreview.hidden = true;
  elements.ingredientNameField.hidden = false;
  elements.ingredientAddShortcuts.hidden = Boolean(item);
  if (item) {
    showIngredientDetails({ editing: true });
    elements.dialogTitle.textContent = `${item.name}の在庫`;
    elements.ingredientId.value = item.id;
    elements.ingredientName.value = item.name;
    elements.ingredientQuantity.value = item.quantity;
    elements.ingredientUnit.value = item.unit;
    elements.ingredientLocation.value = item.location;
    elements.ingredientExpiry.value = normalizedExpiryDate(item.expiryDate);
    elements.ingredientPriority.checked = item.priority;
    elements.consumeIngredient.hidden = false;
    elements.discardIngredient.hidden = false;
    elements.deleteIngredient.hidden = false;
  } else {
    const hasShelfTarget = (
      INVENTORY_LOCATIONS.includes(preferredLocation)
      && Number.isInteger(preferredShelf)
      && preferredShelf >= 0
      && preferredShelf < state.shelfCounts[preferredLocation]
    );
    if (hasShelfTarget) {
      state.ingredientTargetShelf = {
        location: preferredLocation,
        shelf: preferredShelf
      };
    }
    const storageName = preferredLocation === "常温"
      ? "パントリー"
      : preferredLocation
        ? `${preferredLocation}室`
        : "";
    elements.dialogTitle.textContent = hasShelfTarget
      ? `${storageName} ${preferredShelf + 1}段目に追加`
      : "食材を追加";
    elements.ingredientId.value = "";
    elements.ingredientQuantity.value = 1;
    elements.ingredientUnit.value = "個";
    elements.ingredientLocation.value = preferredLocation || (state.location === "すべて" ? "冷蔵" : state.location);
    elements.ingredientExpiry.value = "";
    elements.consumeIngredient.hidden = true;
    elements.discardIngredient.hidden = true;
    elements.deleteIngredient.hidden = true;
    showIngredientCategoryLayer();
  }
  syncQuantityControl(
    elements.ingredientQuantity,
    elements.ingredientQuantityRange,
    elements.ingredientUnit.value
  );
  elements.dialog.showModal();
  requestAnimationFrame(() => {
    if (item) {
      elements.dialog.querySelector("#close-dialog").focus();
    } else {
      elements.ingredientCategoryGrid.querySelector("button")?.focus();
    }
  });
}

function closeIngredientDialog() {
  state.ingredientNameSuggestion = null;
  state.dismissedIngredientSuggestionFor = "";
  state.ingredientTargetShelf = null;
  state.ingredientPreferredLocation = null;
  state.ingredientPickerCategory = null;
  state.selectedIngredientCatalogId = null;
  elements.nameSuggestion.hidden = true;
  elements.dialog.close();
}

function saveIngredient(event) {
  event.preventDefault();
  const name = elements.ingredientName.value.trim();
  const quantity = Number(elements.ingredientQuantity.value);
  const unit = elements.ingredientUnit.value;
  const location = elements.ingredientLocation.value;
  const expiryDate = normalizedExpiryDate(elements.ingredientExpiry.value);
  if (!name || !Number.isFinite(quantity) || quantity <= 0) return;
  if (updateIngredientNameSuggestion()) {
    elements.acceptIngredientName.focus();
    return;
  }

  const editingId = elements.ingredientId.value;
  if (editingId) {
    const item = state.inventory.find((candidate) => candidate.id === editingId);
    if (item) {
      const before = { ...item };
      const maxQuantity = item.unit === unit
        ? Math.max(Number(item.maxQuantity) || 0, quantity)
        : quantity;
      if (item.location !== location) delete item.shelf;
      Object.assign(item, {
        name,
        quantity,
        unit,
        location,
        expiryDate,
        priority: elements.ingredientPriority.checked,
        active: true,
        confirmedAt: todayIso(),
        step: stepForUnit(unit),
        maxQuantity,
        // 本人が数量欄を見て保存したので、量は確認済みになる
        quantityConfidence: QUANTITY_CONFIRMED
      });
      recordInventoryAdjustment(before, item);
      showToast(`${name}を更新しました`);
    }
  } else {
    const selectedCatalogId = state.selectedIngredientCatalogId;
    const targetShelf = state.ingredientTargetShelf?.location === location
      ? state.ingredientTargetShelf.shelf
      : null;
    const result = addOrMergeInventoryItem({
      name,
      quantity,
      unit,
      location,
      // 既存品への追加で空欄なら、登録済みの期限を消さない。
      // 期限を解除するときは、その食材を編集して空欄で保存する。
      expiryDate: expiryDate || null,
      priority: elements.ingredientPriority.checked,
      shelf: targetShelf
    });
    if (selectedCatalogId) rememberRecentIngredient(selectedCatalogId);
    showToast(result === "merged" ? `${name}の残量に追加しました` : `${name}を追加しました`);
  }

  persistInventory();
  persistCookingHistory();
  renderAll();
  closeIngredientDialog();
}

function updateItem(id, updater, { recordHistory = false } = {}) {
  const item = state.inventory.find((candidate) => candidate.id === id);
  if (!item) return;
  const before = { ...item };
  updater(item);
  if (recordHistory) recordInventoryAdjustment(before, item);
  persistInventory();
  if (recordHistory) persistCookingHistory();
  renderAll();
}

function removeInventoryItemWithHistory(item, type, message) {
  const snapshot = { ...item };
  item.active = false;
  item.consumedAt = todayIso();
  const entry = recordDepletionHistory(item, snapshot, type);
  state.lastUndo = () => {
    Object.keys(item).forEach((key) => {
      if (!(key in snapshot)) delete item[key];
    });
    Object.assign(item, snapshot);
    entry.undoneAt = new Date().toISOString();
    persistInventory();
    persistCookingHistory();
    renderAll();
  };
  persistInventory();
  persistCookingHistory();
  renderAll();
  showToast(message, true);
}

function consumeItem(item, message = `${item.name}を使い切りとして履歴へ記録しました`) {
  removeInventoryItemWithHistory(item, "consume", message);
}

function discardItem(item) {
  removeInventoryItemWithHistory(item, "discard", `${item.name}を廃棄として履歴へ記録しました`);
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
  showToast(`${item.name}を完全に削除しました（履歴には残りません）`, true);
}

function deleteCurrentIngredient() {
  const item = state.inventory.find((candidate) => candidate.id === elements.ingredientId.value);
  deleteItem(item);
  closeIngredientDialog();
}

function consumeCurrentIngredient() {
  const item = state.inventory.find((candidate) => candidate.id === elements.ingredientId.value);
  if (!item) return;
  closeIngredientDialog();
  consumeItem(item);
}

function discardCurrentIngredient() {
  const item = state.inventory.find((candidate) => candidate.id === elements.ingredientId.value);
  if (!item) return;
  closeIngredientDialog();
  discardItem(item);
}

function restoreItem(id) {
  updateItem(id, (item) => {
    item.active = true;
    item.confirmedAt = todayIso();
    delete item.consumedAt;
  }, { recordHistory: true });
}

function makeCookingHistoryId(type = "cooking") {
  if (globalThis.crypto?.randomUUID) return `${type}-${crypto.randomUUID()}`;
  return `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function addHistoryEntry(entry) {
  state.cookingHistory.unshift(entry);
  state.cookingHistory = state.cookingHistory.slice(0, HISTORY_STORAGE_LIMIT);
  return entry;
}

function inventoryHistoryComparable(item) {
  return {
    name: item?.name || "",
    quantity: Number(item?.quantity) || 0,
    unit: item?.unit || "",
    location: item?.location || "",
    expiryDate: normalizedExpiryDate(item?.expiryDate),
    active: item?.active !== false
  };
}

function recordInventoryAdjustment(before, after) {
  const beforeComparable = inventoryHistoryComparable(before);
  const afterComparable = inventoryHistoryComparable(after);
  if (JSON.stringify(beforeComparable) === JSON.stringify(afterComparable)) return null;
  const occurredAt = new Date().toISOString();
  return addHistoryEntry({
    id: makeCookingHistoryId("adjustment"),
    type: "adjustment",
    title: `${afterComparable.name || beforeComparable.name}を修正`,
    occurredAt,
    cookedAt: occurredAt,
    undoneAt: null,
    changes: [{
      itemId: after?.id || before?.id,
      name: afterComparable.name || beforeComparable.name,
      before: beforeComparable,
      after: afterComparable
    }]
  });
}

function recordDepletionHistory(item, snapshot, type) {
  const occurredAt = new Date().toISOString();
  const label = type === "discard" ? "廃棄" : "使い切り";
  return addHistoryEntry({
    id: makeCookingHistoryId(type),
    type,
    title: `${snapshot.name}を${label}`,
    occurredAt,
    cookedAt: occurredAt,
    undoneAt: null,
    changes: [{
      itemId: item.id,
      name: snapshot.name,
      unit: snapshot.unit,
      quantity: Number(snapshot.quantity) || 0,
      snapshot
    }]
  });
}

function undoCookingHistoryEntry(historyId) {
  const entry = state.cookingHistory.find((candidate) => candidate.id === historyId);
  if (!entry || entry.undoneAt) return;

  const incompatible = entry.changes.find((change) => {
    const item = state.inventory.find((candidate) => candidate.id === change.itemId);
    return item && item.unit !== change.unit;
  });
  if (incompatible) {
    showToast(`${incompatible.name}の単位が変わっているため取り消せません`);
    return;
  }

  entry.changes.forEach((change) => {
    let item = state.inventory.find((candidate) => candidate.id === change.itemId);
    if (!item) {
      item = {
        ...change.snapshot,
        id: change.itemId,
        name: change.name,
        unit: change.unit,
        quantity: 0,
        active: true
      };
      state.inventory.push(item);
    }
    item.quantity = Number(((Number(item.quantity) || 0) + change.quantity).toFixed(2));
    item.active = true;
    item.confirmedAt = todayIso();
    // 調理を巻き戻すので、調理が下げた確信度も戻す。戻さないと、
    // 作っていないのに翌日の確認へ出てくる
    item.quantityConfidence = quantityConfidence(change.snapshot);
    delete item.consumedAt;
  });

  entry.undoneAt = new Date().toISOString();
  state.lastUndo = null;
  persistInventory();
  persistCookingHistory();
  renderAll();
  showToast(`${entry.recipeName}の調理を取り消し、食材を戻しました`);
}

function setServings(servings, { render = true } = {}) {
  const next = Number(servings);
  if (![1, 2, 3, 4].includes(next)) return false;
  state.servings = next;
  if (render) renderRecipes();
  return true;
}

function baseCookUsage(recipe, servings) {
  const ingredients = [...recipe.required];
  recipe.optional.forEach((option) => {
    const key = `${recipe.id}:${option.id}`;
    if (optionalReady(option, servings) && state.selectedOptionals[key] !== false) ingredients.push(option);
  });

  const usage = new Map();
  ingredients.forEach((ingredient) => {
    const stock = stockForRequirement(ingredient);
    if (!stock) return;
    const quantity = Number(((ingredient.quantity * servings) / stock.ratio).toFixed(2));
    const existing = usage.get(stock.item.id);
    if (existing) existing.quantity = Number((existing.quantity + quantity).toFixed(2));
    else usage.set(stock.item.id, { item: stock.item, quantity });
  });
  return usage;
}

function cookExtraAvailable(itemId, recipe, servings) {
  const item = state.inventory.find((candidate) => candidate.id === itemId && candidate.active !== false);
  if (!item) return 0;
  const base = baseCookUsage(recipe, servings).get(itemId)?.quantity || 0;
  return Number(Math.max(0, (Number(item.quantity) || 0) - base).toFixed(2));
}

function syncCookExtraPicker(recipe, servings) {
  const selected = new Set(state.pendingCookExtras.map((extra) => extra.itemId));
  const choices = activeInventory().filter((item) => !selected.has(item.id));
  const current = elements.cookExtraItem.value;
  elements.cookExtraItem.innerHTML = choices.length
    ? choices.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")
    : '<option value="">追加できる在庫はありません</option>';
  if (choices.some((item) => item.id === current)) elements.cookExtraItem.value = current;
  const item = choices.find((candidate) => candidate.id === elements.cookExtraItem.value) || choices[0];
  elements.cookExtraAdd.disabled = !item;
  elements.cookExtraQuantity.disabled = !item;
  if (!item) {
    elements.cookExtraQuantity.value = "";
    elements.cookExtraUnit.textContent = "";
    return;
  }
  const available = cookExtraAvailable(item.id, recipe, servings);
  const step = stepForUnit(item.unit);
  elements.cookExtraQuantity.max = String(available);
  if (!Number(elements.cookExtraQuantity.value) || current !== item.id) {
    elements.cookExtraQuantity.value = String(Math.min(step, available));
  }
  elements.cookExtraUnit.textContent = item.unit;
}

function cookExtraIssues(recipe, servings) {
  return state.pendingCookExtras.filter((extra) => {
    const quantity = Number(extra.quantity);
    return !Number.isFinite(quantity)
      || quantity <= 0
      || quantity > cookExtraAvailable(extra.itemId, recipe, servings);
  });
}

function captureCookExtraQuantities() {
  elements.cookExtraList.querySelectorAll("[data-cook-extra-quantity]").forEach((input) => {
    const extra = state.pendingCookExtras.find((candidate) =>
      candidate.itemId === input.dataset.cookExtraQuantity);
    if (extra) extra.quantity = Number(input.value);
  });
}

function renderCookExtras(recipe, servings) {
  elements.cookExtraList.innerHTML = state.pendingCookExtras.map((extra) => {
    const item = state.inventory.find((candidate) => candidate.id === extra.itemId);
    const maximum = cookExtraAvailable(extra.itemId, recipe, servings);
    return `
      <li class="cook-extra-row">
        <span>${escapeHtml(item?.name || extra.name)}</span>
        <span class="quantity-with-unit">
          <input type="number" min="0.01" max="${maximum}" step="any" value="${Number(extra.quantity)}" data-cook-extra-quantity="${escapeHtml(extra.itemId)}" aria-label="${escapeHtml(item?.name || extra.name)}を追加で使う量">
          <span>${escapeHtml(extra.unit)}</span>
        </span>
        <button class="cook-extra-remove" type="button" data-cook-extra-remove="${escapeHtml(extra.itemId)}" aria-label="${escapeHtml(item?.name || extra.name)}を追加分から外す">×</button>
      </li>
    `;
  }).join("");
  syncCookExtraPicker(recipe, servings);
}

function updateCookConfirmation() {
  const recipe = RECIPES.find((candidate) => candidate.id === state.pendingCookRecipeId);
  if (!recipe) return;

  const servings = state.pendingCookServings;
  elements.cookServingOptions.querySelectorAll("[data-cook-servings]").forEach((button) => {
    const active = Number(button.dataset.cookServings) === servings;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const selectedIngredients = [...recipe.required];
  const requiredRows = recipe.required.map((requirement) => {
    const stock = stockForRequirement(requirement);
    const item = stock?.item || null;
    const amount = requiredAmount(requirement, servings);
    const main = `
      <span class="cook-ingredient-main">
        ${renderIngredientIllustration(item?.id || requirement.id, item?.name || requirement.name, true)}
        <span><strong>${requirementDisplayName(requirement, item)}</strong><small>${formatQuantity(amount, requirement.unit)}</small></span>
      </span>
    `;

    // 量が未確認のものだけ、ここで聞く。既定は「ある」にして、実物を見て
    // 違うものだけ外してもらう（毎回タップさせない）
    if (item && quantityUnknown(item)) {
      const answered = state.cookAmountAnswers[requirement.id] !== false;
      return `
        <li class="cook-ingredient-row is-unconfirmed">
          <label class="cook-amount-choice">
            <input type="checkbox" data-cook-amount="${escapeHtml(requirement.id)}"${answered ? " checked" : ""}>
            ${main}
            <span class="cook-ingredient-state${answered ? " is-ready" : " is-missing"}">${answered ? "ある" : "足りない"}</span>
          </label>
        </li>
      `;
    }

    const enough = (stock?.available ?? 0) >= amount;
    return `
      <li class="cook-ingredient-row">
        ${main}
        <span class="cook-ingredient-state${enough ? " is-ready" : " is-missing"}">${enough ? "あります" : "不足"}</span>
      </li>
    `;
  }).join("");

  const optionalRows = recipe.optional.map((option) => {
    const ready = optionalReady(option, servings);
    const key = `${recipe.id}:${option.id}`;
    const checked = ready && state.selectedOptionals[key] !== false;
    if (checked) selectedIngredients.push(option);
    return `
      <li class="cook-ingredient-row is-optional">
        <label class="cook-optional-choice">
          <input
            type="checkbox"
            data-cook-optional="${escapeHtml(key)}"
            ${checked ? "checked" : ""}
            ${ready ? "" : "disabled"}
          >
          <span class="cook-ingredient-main">
            ${renderIngredientIllustration(option.id, option.name, true)}
            <span>
              <strong>${escapeHtml(option.name)}</strong>
              <small>${formatQuantity(option.quantity * servings, option.unit)}・${escapeHtml(option.benefit)}</small>
            </span>
          </span>
          <span class="cook-optional-state">${ready ? (checked ? "使う" : "使わない") : "在庫なし"}</span>
        </label>
      </li>
    `;
  }).join("");

  elements.cookConfirmIngredients.innerHTML = `
    <h4>最低限必要</h4>
    <ul>${requiredRows}</ul>
    ${optionalRows ? `<h4>あるとより良い <small>使うものを選択</small></h4><ul>${optionalRows}</ul>` : ""}
  `;
  renderCookExtras(recipe, servings);
  const nutritionIngredients = [...selectedIngredients];
  state.pendingCookExtras.forEach((extra) => {
    const item = state.inventory.find((candidate) => candidate.id === extra.itemId);
    if (item) nutritionIngredients.push({
      id: item.id,
      name: item.name,
      quantity: Number(extra.quantity) / servings,
      unit: item.unit
    });
  });
  const nutrition = estimateRecipeNutrition(recipe, servings, nutritionIngredients);
  elements.cookConfirmNutrition.hidden = !state.settings.showNutrition;
  elements.cookConfirmNutrition.textContent = state.settings.showNutrition
    ? `合計目安 ${nutrition.kcal} kcal・P ${nutrition.p}g・F ${nutrition.f}g・C ${nutrition.c}g`
    : "";

  const { shortages, unconfirmed, denied, canCook: baseCanCook } =
    cookBlockers(recipe, servings, state.cookAmountAnswers);
  const extraIssues = cookExtraIssues(recipe, servings);
  const canCook = baseCanCook && !extraIssues.length;

  elements.cookConfirmMessage.classList.toggle("is-missing", !canCook);
  if (extraIssues.length) {
    elements.cookConfirmMessage.textContent = `${extraIssues.map((extra) => extra.name).join("、")}の追加量が在庫を超えています。`;
  } else if (shortages.length) {
    const missingText = shortages.map((requirement) => {
      const missing = Math.max(
        0,
        requiredAmount(requirement, servings) - availableForRequirement(requirement)
      );
      return `${requirement.name} あと${formatQuantity(missing, requirement.unit)}`;
    }).join("、");
    elements.cookConfirmMessage.textContent = `${servings}人分には、${missingText}が足りません。`;
  } else if (denied.length) {
    // 量が足りないことは失敗ではなく、人数を落とすか妥協するかの選択でしかない
    elements.cookConfirmMessage.textContent =
      `${denied.map((requirement) => requirement.name).join("、")}が${servings}人分に届かないようです。`;
  } else if (unconfirmed.length) {
    elements.cookConfirmMessage.textContent =
      `${unconfirmed.map((requirement) => requirement.name).join("、")}の量はまだ確認していません。実物を見て、足りないものだけチェックを外してください。`;
  } else {
    elements.cookConfirmMessage.textContent = `${servings}人分として、使った食材を在庫から減らします。`;
  }

  // 逃げ道は、数量が未確認で「足りない」と答えたときだけ出す。
  // 数値で不足しているものは買い足しの話なので、ここでは出さない。
  const showFallback = Boolean(denied.length) && !shortages.length;
  elements.cookFallback.hidden = !showFallback;
  elements.cookFallbackSingle.hidden = servings <= 1;

  elements.confirmCook.disabled = !canCook;
  elements.confirmCook.textContent = `${servings}人分で作る`;
}

// 量の答えは「2人分の卵」のように特定の量に対するもの。人数が変われば
// 前の答えは意味を持たないので、聞き直す（2人分では足りなくても
// 1人分なら足りることがある）。
function setPendingCookServings(servings) {
  state.pendingCookServings = servings;
  state.cookAmountAnswers = {};
  updateCookConfirmation();
}

function openCookConfirmation(recipeId) {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe) return;

  state.pendingCookRecipeId = recipe.id;
  state.pendingCookServings = state.servings;
  state.pendingCookExtras = [];
  state.cookAmountAnswers = {};
  elements.cookConfirmRecipe.textContent = recipe.name;
  updateCookConfirmation();
  elements.cookConfirmDialog.showModal();
  requestAnimationFrame(() => {
    elements.cookServingOptions
      .querySelector(`[data-cook-servings="${state.pendingCookServings}"]`)
      ?.focus();
  });
}

function closeCookConfirmation() {
  state.pendingCookRecipeId = null;
  state.pendingCookServings = state.servings;
  state.pendingCookExtras = [];
  state.cookAmountAnswers = {};
  if (elements.cookConfirmDialog.open) elements.cookConfirmDialog.close();
}

// ignoreAmounts は「このまま作る」用。量が足りないと答えたものも、
// 引けるところまで引いて作る（0で止まるので在庫が負にはならない）。
function confirmCookRecipe(event, { ignoreAmounts = false } = {}) {
  event.preventDefault();
  const recipeId = state.pendingCookRecipeId;
  const servings = state.pendingCookServings;
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe) return;

  captureCookExtraQuantities();
  const { shortages, denied } = cookBlockers(recipe, servings, state.cookAmountAnswers);
  const extraIssues = cookExtraIssues(recipe, servings);
  // 「このまま作る」は足りないという答えを押し通す。数値で不足しているもの
  // （持っていない・明らかに足りない）は押し通せない
  if (shortages.length || extraIssues.length || (!ignoreAmounts && denied.length)) {
    updateCookConfirmation();
    return;
  }

  // 在庫へ書き戻すのは cookRecipe が履歴用の控えを取る前。こうしないと
  // 取り消したときに、確認前の不確かな量へ戻ってしまう。
  // 「足りない」と答えたものは上げないので、不明のまま次回また確認する
  confirmUnknownAmounts(recipe, servings, state.cookAmountAnswers);
  setServings(servings, { render: false });
  const extras = state.pendingCookExtras.map((extra) => ({ ...extra }));
  closeCookConfirmation();
  cookRecipe(recipeId, servings, extras);
}

function cookRecipe(recipeId, servings = state.servings, extras = []) {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe || shortageFor(recipe, servings).length) return;

  const usage = baseCookUsage(recipe, servings);
  extras.forEach((extra) => {
    const item = state.inventory.find((candidate) => candidate.id === extra.itemId);
    if (!item || item.active === false || item.unit !== extra.unit) return;
    const existing = usage.get(item.id);
    if (existing) existing.quantity = Number((existing.quantity + Number(extra.quantity)).toFixed(2));
    else usage.set(item.id, { item, quantity: Number(extra.quantity) });
  });
  const changes = [];
  usage.forEach(({ item, quantity }) => {
    const usedQuantity = Number(Math.min(Number(item.quantity) || 0, quantity).toFixed(2));
    if (usedQuantity <= 0) return;
    changes.push({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      quantity: usedQuantity,
      snapshot: { ...item }
    });
    item.quantity = Number(Math.max(0, item.quantity - usedQuantity).toFixed(2));
    // 引いたのはレシピ上の分量。実際に使った量とは違うので、残りは推定になる。
    // 翌日の確認でここを実物に合わせる（→ pendingDayAfterItems）
    item.quantityConfidence = QUANTITY_ESTIMATED;
    if (item.quantity === 0) {
      item.active = false;
      item.consumedAt = todayIso();
    }
  });

  const historyEntry = addHistoryEntry({
    id: makeCookingHistoryId(),
    type: "cooking",
    recipeId: recipe.id,
    recipeName: recipe.name,
    servings,
    cookedAt: new Date().toISOString(),
    undoneAt: null,
    changes
  });
  state.lastUndo = () => undoCookingHistoryEntry(historyEntry.id);
  persistInventory();
  persistCookingHistory();
  renderAll();
  showView("inventory");
  showToast(`${recipe.name}を作った分だけ在庫を更新しました`, true);
}

function editableHistoryEntry() {
  return state.cookingHistory.find((entry) => entry.id === state.editingHistoryId);
}

function historyEditMaximum(change) {
  const item = state.inventory.find((candidate) => candidate.id === change.itemId);
  const current = item && item.unit === change.unit ? Number(item.quantity) || 0 : 0;
  const original = Number(change.originalQuantity ?? change.quantity) || 0;
  return Number((original + current).toFixed(2));
}

function historyEditIssues() {
  return state.historyEditChanges.filter((change) => {
    const item = state.inventory.find((candidate) => candidate.id === change.itemId);
    const quantity = Number(change.quantity);
    return !Number.isFinite(quantity)
      || quantity < 0
      || quantity > historyEditMaximum(change)
      || (item && item.unit !== change.unit);
  });
}

function captureHistoryEditQuantities() {
  elements.historyEditIngredients.querySelectorAll("[data-history-edit-quantity]").forEach((input) => {
    const change = state.historyEditChanges.find((candidate) =>
      candidate.itemId === input.dataset.historyEditQuantity);
    if (change) change.quantity = Number(input.value);
  });
}

function syncHistoryEditAddPicker() {
  const selected = new Set(state.historyEditChanges.map((change) => change.itemId));
  const choices = activeInventory().filter((item) => !selected.has(item.id));
  const current = elements.historyEditAddItem.value;
  elements.historyEditAddItem.innerHTML = choices.length
    ? choices.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")
    : '<option value="">追加できる在庫はありません</option>';
  if (choices.some((item) => item.id === current)) elements.historyEditAddItem.value = current;
  const item = choices.find((candidate) => candidate.id === elements.historyEditAddItem.value) || choices[0];
  elements.historyEditAdd.disabled = !item;
  elements.historyEditAddQuantity.disabled = !item;
  if (!item) {
    elements.historyEditAddQuantity.value = "";
    elements.historyEditAddUnit.textContent = "";
    return;
  }
  const step = stepForUnit(item.unit);
  elements.historyEditAddQuantity.max = String(item.quantity);
  if (!Number(elements.historyEditAddQuantity.value) || current !== item.id) {
    elements.historyEditAddQuantity.value = String(Math.min(step, Number(item.quantity) || step));
  }
  elements.historyEditAddUnit.textContent = item.unit;
}

function renderHistoryEdit() {
  const entry = editableHistoryEntry();
  if (!entry) return;
  elements.historyEditRecipe.textContent = `${entry.recipeName}・${Number(entry.servings) || 1}人分`;
  elements.historyEditIngredients.innerHTML = state.historyEditChanges.map((change) => `
    <div class="history-edit-row">
      <span>${escapeHtml(change.name)}</span>
      <span class="quantity-with-unit">
        <input type="number" min="0" max="${historyEditMaximum(change)}" step="any" value="${Number(change.quantity)}" data-history-edit-quantity="${escapeHtml(change.itemId)}" aria-label="${escapeHtml(change.name)}を使った量">
        <span>${escapeHtml(change.unit)}</span>
      </span>
      <button class="history-edit-remove" type="button" data-history-edit-remove="${escapeHtml(change.itemId)}" aria-label="${escapeHtml(change.name)}を使用食材から外す">×</button>
    </div>
  `).join("");
  syncHistoryEditAddPicker();
  const issues = historyEditIssues();
  elements.saveHistoryEdit.disabled = Boolean(issues.length);
  elements.historyEditMessage.classList.toggle("is-missing", Boolean(issues.length));
  elements.historyEditMessage.textContent = issues.length
    ? `${issues.map((change) => change.name).join("、")}の量または単位を確認してください。`
    : "増やした分は在庫から減り、減らした分は在庫へ戻ります。";
}

function openHistoryEdit(historyId) {
  const entry = state.cookingHistory.find((candidate) =>
    candidate.id === historyId && historyEntryType(candidate) === "cooking" && !candidate.undoneAt);
  if (!entry) return;
  state.editingHistoryId = entry.id;
  state.historyEditChanges = entry.changes.map((change) => ({
    ...change,
    snapshot: { ...change.snapshot },
    originalQuantity: Number(change.quantity) || 0
  }));
  renderHistoryEdit();
  elements.historyEditDialog.showModal();
}

function closeHistoryEdit() {
  state.editingHistoryId = null;
  state.historyEditChanges = [];
  if (elements.historyEditDialog.open) elements.historyEditDialog.close();
}

function addHistoryEditIngredient() {
  captureHistoryEditQuantities();
  const item = state.inventory.find((candidate) =>
    candidate.id === elements.historyEditAddItem.value && candidate.active !== false);
  const quantity = Number(elements.historyEditAddQuantity.value);
  if (!item || !Number.isFinite(quantity) || quantity <= 0 || quantity > item.quantity) {
    elements.historyEditAddQuantity.reportValidity();
    return;
  }
  state.historyEditChanges.push({
    itemId: item.id,
    name: item.name,
    unit: item.unit,
    quantity,
    originalQuantity: 0,
    snapshot: { ...item }
  });
  elements.historyEditAddQuantity.value = "";
  renderHistoryEdit();
}

function saveHistoryEdit(event) {
  event.preventDefault();
  captureHistoryEditQuantities();
  const entry = editableHistoryEntry();
  if (!entry || entry.undoneAt || historyEditIssues().length) {
    renderHistoryEdit();
    return;
  }

  const originalById = new Map(entry.changes.map((change) => [change.itemId, change]));
  const editedById = new Map(state.historyEditChanges.map((change) => [change.itemId, change]));
  const ids = new Set([...originalById.keys(), ...editedById.keys()]);

  for (const itemId of ids) {
    const original = originalById.get(itemId);
    const edited = editedById.get(itemId);
    const oldQuantity = Number(original?.quantity) || 0;
    const newQuantity = Number(edited?.quantity) || 0;
    const unit = edited?.unit || original?.unit;
    let item = state.inventory.find((candidate) => candidate.id === itemId);
    if (item && item.unit !== unit) {
      elements.historyEditMessage.textContent = `${item.name}の在庫単位が変わっているため修正できません。`;
      elements.historyEditMessage.classList.add("is-missing");
      return;
    }
    if (!item && newQuantity < oldQuantity) {
      item = { ...original.snapshot, id: itemId, quantity: 0, active: false };
      state.inventory.push(item);
    }
    const delta = Number((newQuantity - oldQuantity).toFixed(2));
    if (!item || delta === 0) continue;
    item.quantity = Number(Math.max(0, (Number(item.quantity) || 0) - delta).toFixed(2));
    item.active = item.quantity > 0;
    item.confirmedAt = todayIso();
    item.quantityConfidence = QUANTITY_ESTIMATED;
    if (item.active) delete item.consumedAt;
    else item.consumedAt = todayIso();
  }

  entry.changes = state.historyEditChanges
    .filter((change) => Number(change.quantity) > 0)
    .map(({ originalQuantity, ...change }) => ({ ...change, quantity: Number(change.quantity) }));
  entry.editedAt = new Date().toISOString();
  state.lastUndo = null;
  persistInventory();
  persistCookingHistory();
  closeHistoryEdit();
  renderAll();
  showToast(`${entry.recipeName}で使った食材を修正しました`);
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
  renderExpiringList();
  renderRecipes();
  renderShopping();
  renderCookingHistory();
}

function changeShelfCount(location, delta) {
  const limits = STORAGE_SHELF_LIMITS[location];
  const current = state.shelfCounts[location];
  if (!limits || ![-1, 1].includes(delta)) return false;

  const next = current + delta;
  if (next < limits.min || next > limits.max) return false;

  // 最下段に食材があるまま減らすと、その食材が黙って別の段へ移る。
  // どこに何があるかを把握するためのアプリなので、先に本人に動かしてもらう
  if (delta < 0) {
    const lastShelf = current - 1;
    const hasItems = state.inventory.some((item) =>
      item.location === location
      && item.shelf === lastShelf
      && item.active !== false
      && item.quantity > 0
    );
    if (hasItems) {
      showToast(`${storageDisplayName(location)}の最下段の食材を移動してから棚を減らしてください`);
      return false;
    }
  }

  state.shelfCounts[location] = next;
  persistShelfCounts();
  renderInventory();
  showToast(`${storageDisplayName(location)}を${next}段にしました`);
  return true;
}

function moveInventoryItem(itemId, targetLocation, targetShelf, targetId = null, placeAfter = false) {
  const sourceIndex = state.inventory.findIndex((item) => item.id === itemId);
  const shelfCount = state.shelfCounts[targetLocation];
  if (
    sourceIndex < 0
    || !INVENTORY_LOCATIONS.includes(targetLocation)
    || !Number.isInteger(targetShelf)
    || targetShelf < 0
    || targetShelf >= shelfCount
  ) return false;

  const item = state.inventory[sourceIndex];
  const previousLocation = item.location;
  const previousShelf = item.shelf;
  const targetShelfSize = state.inventory.filter((candidate) =>
    candidate.id !== itemId
    && candidate.location === targetLocation
    && candidate.shelf === targetShelf
    && candidate.active !== false
    && candidate.quantity > 0
  ).length;
  if (
    targetShelfSize >= STORAGE_SHELF_CAPACITIES[targetLocation]
    && (previousLocation !== targetLocation || previousShelf !== targetShelf)
  ) {
    showToast("この段はいっぱいです");
    return false;
  }

  state.inventory.splice(sourceIndex, 1);
  item.location = targetLocation;
  item.shelf = targetShelf;

  const targetIndex = targetId
    ? state.inventory.findIndex((candidate) =>
      candidate.id === targetId
      && candidate.location === targetLocation
      && candidate.shelf === targetShelf
    )
    : -1;

  if (targetIndex >= 0) {
    state.inventory.splice(targetIndex + (placeAfter ? 1 : 0), 0, item);
  } else {
    let insertAt = state.inventory.length;
    for (let index = state.inventory.length - 1; index >= 0; index -= 1) {
      const candidate = state.inventory[index];
      if (
        candidate.location === targetLocation
        && candidate.shelf === targetShelf
        && candidate.active !== false
        && candidate.quantity > 0
      ) {
        insertAt = index + 1;
        break;
      }
    }
    state.inventory.splice(insertAt, 0, item);
  }

  persistInventory();
  renderAll();
  const message = previousLocation !== targetLocation
    ? `${item.name}を${targetLocation}へ移しました`
    : previousShelf !== targetShelf
      ? `${item.name}を${targetShelf + 1}段目へ移しました`
      : `${item.name}の並び順を変更しました`;
  showToast(message);
  return true;
}

function clearFridgeDropTarget(drag) {
  clearFridgeReorderPreview(drag);
  drag.dropTarget?.classList.remove("is-drop-target");
  drag.dropTarget = null;
  drag.targetId = null;
}

function clearFridgeConsumeTarget(drag) {
  drag.consumeTarget?.classList.remove("is-ready-to-eat");
  drag.consumeTarget = null;
}

function shelfFoodElements(dropTarget) {
  const row = dropTarget?.querySelector(".fridge-foods");
  if (!row) return { row: null, foods: [] };
  return {
    row,
    foods: [...row.children].filter((element) => element.matches("[data-drag-item]"))
  };
}

function dropPlacementForPointer(dropTarget, source, pointerX, foodCenters = null) {
  const { row, foods } = shelfFoodElements(dropTarget);
  const candidates = foods
    .filter((food) => food !== source)
    .map((food) => {
      const rect = food.getBoundingClientRect();
      return {
        id: food.dataset.dragItem,
        center: foodCenters?.get(food.dataset.dragItem) ?? rect.left + rect.width / 2
      };
    });
  const insertionIndex = candidates.findIndex((candidate) => pointerX < candidate.center);
  const resolvedIndex = insertionIndex < 0 ? candidates.length : insertionIndex;

  if (!candidates.length) {
    return { row, foods, insertionIndex: 0, targetId: null, placeAfter: false };
  }
  if (resolvedIndex < candidates.length) {
    return {
      row,
      foods,
      insertionIndex: resolvedIndex,
      targetId: candidates[resolvedIndex].id,
      placeAfter: false
    };
  }
  return {
    row,
    foods,
    insertionIndex: resolvedIndex,
    targetId: candidates[candidates.length - 1].id,
    placeAfter: true
  };
}

function clearFridgeReorderPreview(drag) {
  drag.previewRow?.classList.remove("is-reordering");
  drag.previewItems?.forEach((food) => {
    food.classList.remove("is-reorder-shifting");
    food.style.removeProperty("--reorder-shift");
  });
  drag.previewRow = null;
  drag.previewItems = [];
  drag.previewTarget = null;
  drag.previewIndex = null;
}

function updateFridgeReorderPreview(drag, dropTarget, placement) {
  if (
    drag.previewTarget === dropTarget
    && drag.previewIndex === placement.insertionIndex
  ) return;

  clearFridgeReorderPreview(drag);
  if (!placement.row) return;

  const sourceRow = drag.source.closest(".fridge-foods");
  const sourceIndex = placement.foods.indexOf(drag.source);
  const sampleRect = drag.source.getBoundingClientRect();
  const columnGap = Number.parseFloat(getComputedStyle(placement.row).columnGap) || 1;
  const step = sampleRect.width + columnGap;
  const shifted = [];

  placement.foods.forEach((food, index) => {
    if (food === drag.source) return;
    let direction = 0;

    if (placement.row === sourceRow) {
      if (placement.insertionIndex < sourceIndex && index >= placement.insertionIndex && index < sourceIndex) {
        direction = 1;
      } else if (placement.insertionIndex > sourceIndex && index > sourceIndex && index <= placement.insertionIndex) {
        direction = -1;
      }
    } else if (index >= placement.insertionIndex) {
      direction = 1;
    }

    if (!direction) return;
    food.style.setProperty("--reorder-shift", `${direction * step}px`);
    food.classList.add("is-reorder-shifting");
    shifted.push(food);
  });

  placement.row.classList.add("is-reordering");
  drag.previewRow = placement.row;
  drag.previewItems = shifted;
  drag.previewTarget = dropTarget;
  drag.previewIndex = placement.insertionIndex;
}

function cleanupFridgeDrag({ suppressClick = false } = {}) {
  const drag = state.fridgeDrag;
  if (!drag) return;

  clearTimeout(drag.timer);
  clearFridgeDropTarget(drag);
  clearFridgeConsumeTarget(drag);
  drag.ghost?.remove();
  drag.source?.classList.remove("is-dragging");
  drag.source?.removeAttribute("aria-grabbed");
  document.body.classList.remove("is-fridge-dragging");

  if (drag.source?.hasPointerCapture?.(drag.pointerId)) {
    drag.source.releasePointerCapture(drag.pointerId);
  }
  state.fridgeDrag = null;
  if (suppressClick) state.suppressFridgeClickUntil = Date.now() + 450;
}

function beginFridgeDrag() {
  const drag = state.fridgeDrag;
  if (!drag || drag.active || !drag.source.isConnected) return;

  const rect = drag.source.getBoundingClientRect();
  drag.active = true;
  drag.ghost = drag.source.cloneNode(true);
  drag.ghost.classList.add("fridge-drag-ghost");
  drag.ghost.removeAttribute("data-fridge-edit");
  drag.ghost.removeAttribute("data-drag-item");
  drag.ghost.setAttribute("aria-hidden", "true");
  drag.ghost.style.left = `${rect.left}px`;
  drag.ghost.style.top = `${rect.top}px`;
  drag.ghost.style.width = `${rect.width}px`;
  drag.ghost.style.height = `${rect.height}px`;
  document.body.append(drag.ghost);

  drag.source.classList.add("is-dragging");
  drag.source.setAttribute("aria-grabbed", "true");
  document.body.classList.add("is-fridge-dragging");
  drag.foodCenters = new Map(
    [...elements.fridgeScene.querySelectorAll("[data-drag-item]")].map((food) => {
      const foodRect = food.getBoundingClientRect();
      return [food.dataset.dragItem, foodRect.left + foodRect.width / 2];
    })
  );
  navigator.vibrate?.(18);
}

function updateFridgeDrag(event) {
  const drag = state.fridgeDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  drag.distance = Math.max(drag.distance, distance);

  if (!drag.active) {
    if (distance >= 8) beginFridgeDrag();
    if (!drag.active) return;
  }

  event.preventDefault();
  drag.ghost.style.transform = `translate3d(${event.clientX - drag.startX}px, ${event.clientY - drag.startY}px, 0) scale(1.08)`;

  const hovered = document.elementFromPoint(event.clientX, event.clientY);
  const consumeTarget = hovered?.closest("[data-consume-drop]") || null;
  if (consumeTarget) {
    if (consumeTarget !== drag.consumeTarget) {
      clearFridgeDropTarget(drag);
      clearFridgeConsumeTarget(drag);
      drag.consumeTarget = consumeTarget;
      drag.consumeTarget.classList.add("is-ready-to-eat");
    }
    return;
  }
  clearFridgeConsumeTarget(drag);

  const dropTarget = hovered?.closest("[data-drop-location]") || null;
  if (dropTarget !== drag.dropTarget) {
    clearFridgeDropTarget(drag);
    drag.dropTarget = dropTarget;
    drag.dropTarget?.classList.add("is-drop-target");
  }

  if (!dropTarget) return;
  const placement = dropPlacementForPointer(
    dropTarget,
    drag.source,
    event.clientX,
    drag.foodCenters
  );
  drag.targetId = placement.targetId;
  drag.placeAfter = placement.placeAfter;
  updateFridgeReorderPreview(drag, dropTarget, placement);
}

function finishFridgeDrag(event) {
  const drag = state.fridgeDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  clearTimeout(drag.timer);
  if (!drag.active) {
    cleanupFridgeDrag();
    return;
  }

  event.preventDefault();
  const shouldConsume = drag.distance >= 8 && Boolean(drag.consumeTarget);
  const consumeTarget = drag.consumeTarget;
  const location = drag.dropTarget?.dataset.dropLocation || null;
  const shelf = drag.dropTarget?.dataset.dropShelf;
  const targetShelf = shelf === undefined ? null : Number(shelf);
  const shouldMove = drag.distance >= 8 && location && Number.isInteger(targetShelf);
  const itemId = drag.itemId;
  const source = drag.source;
  const targetId = drag.targetId;
  const placeAfter = drag.placeAfter;
  cleanupFridgeDrag({ suppressClick: true });
  if (shouldConsume) {
    consumeTarget?.classList.add("did-eat");
    source?.classList.add("is-being-eaten");
    navigator.vibrate?.([20, 25, 20]);
    setTimeout(() => {
      const item = state.inventory.find((candidate) => candidate.id === itemId);
      if (item) consumeItem(item, `${item.name}を食べて使い切りました`);
    }, 240);
    return;
  }
  if (shouldMove) moveInventoryItem(itemId, location, targetShelf, targetId, placeAfter);
}

elements.ingredientCategoryGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ingredient-category]");
  if (!button) return;
  showIngredientItemLayer(button.dataset.ingredientCategory);
});

elements.ingredientItemGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ingredient-item]");
  if (!button) return;
  const item = illustratedIngredientItem(button.dataset.ingredientItem);
  if (item) showIngredientDetails({ catalogItem: item });
});

elements.ingredientManualMode.addEventListener("click", () => {
  state.ingredientPickerCategory = null;
  showIngredientDetails({ manual: true });
});

elements.ingredientPickerBack.addEventListener("click", () => {
  showIngredientCategoryLayer({ focus: true });
});

elements.ingredientPickerReselect.addEventListener("click", () => {
  if (state.ingredientPickerCategory) {
    showIngredientItemLayer(state.ingredientPickerCategory);
  } else {
    showIngredientCategoryLayer({ focus: true });
  }
});

function startReceiptScanFromDevice() {
  if (elements.dialog.open) closeIngredientDialog();
  elements.receiptInput.value = "";
  elements.receiptInput.click();
}

document.querySelector("#add-ingredient").addEventListener("click", () => openIngredientDialog());
elements.openSettings.addEventListener("click", () => {
  setNutritionHelpExpanded(false);
  elements.settingsDialog.showModal();
  requestAnimationFrame(() => elements.settingShowNutrition.focus());
});

elements.closeSettings.addEventListener("click", () => elements.settingsDialog.close());

elements.settingShowNutrition.addEventListener("change", () => {
  state.settings.showNutrition = elements.settingShowNutrition.checked;
  persistSettings();
  renderRecipes();
  if (state.pendingCookRecipeId) updateCookConfirmation();
});
elements.nutritionHelp.addEventListener("click", () => {
  const expanded = elements.nutritionHelp.getAttribute("aria-expanded") === "true";
  setNutritionHelpExpanded(!expanded);
});
elements.deviceName.addEventListener("input", () => {
  state.device.name = elements.deviceName.value.slice(0, 30);
  persistDevice();
});
elements.deviceName.addEventListener("change", () => {
  const name = elements.deviceName.value.trim().slice(0, 30) || defaultDeviceName(state.device.id);
  state.device.name = name;
  elements.deviceName.value = name;
  persistDevice();
});
document.querySelector("#scan-receipt").addEventListener("click", startReceiptScanFromDevice);
elements.ingredientReceiptShortcut.addEventListener("click", startReceiptScanFromDevice);
document.querySelector("#close-dialog").addEventListener("click", closeIngredientDialog);
document.querySelector("#cancel-dialog").addEventListener("click", closeIngredientDialog);
document.querySelector("#consume-ingredient").addEventListener("click", consumeCurrentIngredient);
document.querySelector("#discard-ingredient").addEventListener("click", discardCurrentIngredient);
document.querySelector("#delete-ingredient").addEventListener("click", deleteCurrentIngredient);
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
elements.ingredientName.addEventListener("input", () => {
  state.dismissedIngredientSuggestionFor = "";
  updateIngredientNameSuggestion();
});
elements.acceptIngredientName.addEventListener("click", () => {
  const suggestion = state.ingredientNameSuggestion;
  if (!suggestion) return;
  elements.ingredientName.value = suggestion.name;
  state.ingredientNameSuggestion = null;
  state.dismissedIngredientSuggestionFor = normalizeIngredientNameForMatch(suggestion.name);
  elements.nameSuggestion.hidden = true;
  elements.form.requestSubmit();
});
elements.keepIngredientName.addEventListener("click", () => {
  state.dismissedIngredientSuggestionFor = normalizeIngredientNameForMatch(elements.ingredientName.value);
  elements.nameSuggestion.hidden = true;
  elements.form.requestSubmit();
});
elements.ingredientUnit.addEventListener("change", () => {
  syncQuantityControl(
    elements.ingredientQuantity,
    elements.ingredientQuantityRange,
    elements.ingredientUnit.value
  );
});
elements.ingredientQuantity.addEventListener("input", () => {
  syncQuantityControl(
    elements.ingredientQuantity,
    elements.ingredientQuantityRange,
    elements.ingredientUnit.value,
    "input-live"
  );
});
elements.ingredientQuantityRange.addEventListener("input", () => {
  syncQuantityControl(
    elements.ingredientQuantity,
    elements.ingredientQuantityRange,
    elements.ingredientUnit.value,
    "range"
  );
});
elements.shoppingName.addEventListener("input", () => {
  const ingredientId = ALIASES.get(elements.shoppingName.value.trim());
  const known = RECEIPT_RULES.find((rule) => rule.id === ingredientId);
  if (known && INVENTORY_UNITS.includes(known.unit)) {
    elements.shoppingUnit.value = known.unit;
    syncQuantityControl(
      elements.shoppingQuantity,
      elements.shoppingQuantityRange,
      elements.shoppingUnit.value
    );
  }
});
elements.shoppingUnit.addEventListener("change", () => {
  syncQuantityControl(
    elements.shoppingQuantity,
    elements.shoppingQuantityRange,
    elements.shoppingUnit.value
  );
});
elements.shoppingQuantity.addEventListener("input", () => {
  syncQuantityControl(
    elements.shoppingQuantity,
    elements.shoppingQuantityRange,
    elements.shoppingUnit.value,
    "input-live"
  );
});
elements.shoppingQuantityRange.addEventListener("input", () => {
  syncQuantityControl(
    elements.shoppingQuantity,
    elements.shoppingQuantityRange,
    elements.shoppingUnit.value,
    "range"
  );
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quantity-adjust]");
  if (!button) return;
  const controls = button.dataset.quantityAdjust === "ingredient-quantity"
    ? {
      input: elements.ingredientQuantity,
      range: elements.ingredientQuantityRange,
      unit: elements.ingredientUnit.value
    }
    : button.dataset.quantityAdjust === "shopping-quantity"
      ? {
        input: elements.shoppingQuantity,
        range: elements.shoppingQuantityRange,
        unit: elements.shoppingUnit.value
      }
      : null;
  if (!controls) return;
  adjustQuantityControl(controls.input, controls.range, controls.unit, Number(button.dataset.delta));
});
elements.shoppingCategoryGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-shopping-category]");
  if (!button) return;
  state.shoppingPickerCategory = button.dataset.shoppingCategory;
  renderShoppingPicker();
  requestAnimationFrame(() => {
    elements.shoppingFoodGrid.querySelector("button:not(:disabled)")?.focus();
  });
});
elements.shoppingPickerBack.addEventListener("click", () => {
  state.shoppingPickerCategory = null;
  renderShoppingPicker();
  requestAnimationFrame(() => {
    elements.shoppingCategoryGrid.querySelector("button")?.focus();
  });
});
elements.shoppingFoodGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-shopping-food]");
  if (!button) return;
  const item = illustratedIngredientItem(button.dataset.shoppingFood);
  if (!item) return;
  const existing = state.shopping.find((shoppingItem) =>
    !shoppingItem.checked
    && shoppingItem.ingredientId === item.id
    && shoppingItem.unit === item.unit
  );
  if (existing) {
    state.shopping = state.shopping.filter((shoppingItem) => shoppingItem.id !== existing.id);
  } else {
    addShoppingItem({
      ingredientId: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      source: "illustration",
      location: item.location
    });
  }
  persistShoppingList();
  renderShopping();
});
elements.shoppingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.shoppingName.value.trim();
  const quantity = Number(elements.shoppingQuantity.value);
  const unit = elements.shoppingUnit.value;
  if (!name || !Number.isFinite(quantity) || quantity <= 0) return;

  const result = addShoppingItem({
    ingredientId: shoppingIngredientId(name),
    name,
    quantity,
    unit
  });
  persistShoppingList();
  renderShopping();
  elements.shoppingForm.reset();
  elements.shoppingQuantity.value = 1;
  elements.shoppingUnit.value = "個";
  syncQuantityControl(
    elements.shoppingQuantity,
    elements.shoppingQuantityRange,
    elements.shoppingUnit.value
  );
  elements.shoppingName.focus();
  showToast(result === "merged" ? `${name}の買う量に追加しました` : `${name}を買い物リストに追加しました`);
});
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

elements.cookConfirmDialog.addEventListener("click", (event) => {
  if (event.target === elements.cookConfirmDialog) closeCookConfirmation();
});
elements.cookConfirmDialog.addEventListener("close", () => {
  state.pendingCookRecipeId = null;
  state.pendingCookServings = state.servings;
  state.pendingCookExtras = [];
});
document.querySelector("#close-cook-confirm").addEventListener("click", closeCookConfirmation);
document.querySelector("#cancel-cook-confirm").addEventListener("click", closeCookConfirmation);
elements.cookServingOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cook-servings]");
  if (!button) return;
  setPendingCookServings(Number(button.dataset.cookServings));
});
elements.cookConfirmIngredients.addEventListener("change", (event) => {
  const optional = event.target.closest("[data-cook-optional]");
  if (optional) {
    state.selectedOptionals[optional.dataset.cookOptional] = optional.checked;
    updateCookConfirmation();
    return;
  }
  const amount = event.target.closest("[data-cook-amount]");
  if (!amount) return;
  state.cookAmountAnswers[amount.dataset.cookAmount] = amount.checked;
  updateCookConfirmation();
});
elements.cookExtraItem.addEventListener("change", () => {
  const recipe = RECIPES.find((candidate) => candidate.id === state.pendingCookRecipeId);
  const item = state.inventory.find((candidate) => candidate.id === elements.cookExtraItem.value);
  if (!recipe || !item) return;
  const available = cookExtraAvailable(item.id, recipe, state.pendingCookServings);
  const step = stepForUnit(item.unit);
  elements.cookExtraQuantity.max = String(available);
  elements.cookExtraQuantity.value = String(Math.min(step, available));
  elements.cookExtraUnit.textContent = item.unit;
});
elements.cookExtraAdd.addEventListener("click", () => {
  captureCookExtraQuantities();
  const recipe = RECIPES.find((candidate) => candidate.id === state.pendingCookRecipeId);
  const item = state.inventory.find((candidate) => candidate.id === elements.cookExtraItem.value);
  const quantity = Number(elements.cookExtraQuantity.value);
  if (!recipe || !item || !Number.isFinite(quantity) || quantity <= 0
    || quantity > cookExtraAvailable(item.id, recipe, state.pendingCookServings)) {
    elements.cookExtraQuantity.reportValidity();
    return;
  }
  state.pendingCookExtras.push({ itemId: item.id, name: item.name, unit: item.unit, quantity });
  elements.cookExtraQuantity.value = "";
  updateCookConfirmation();
});
elements.cookExtraList.addEventListener("change", (event) => {
  const input = event.target.closest("[data-cook-extra-quantity]");
  if (!input) return;
  const extra = state.pendingCookExtras.find((candidate) => candidate.itemId === input.dataset.cookExtraQuantity);
  if (!extra) return;
  extra.quantity = Number(input.value);
  updateCookConfirmation();
});
elements.cookExtraList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cook-extra-remove]");
  if (!button) return;
  captureCookExtraQuantities();
  state.pendingCookExtras = state.pendingCookExtras.filter((extra) =>
    extra.itemId !== button.dataset.cookExtraRemove);
  updateCookConfirmation();
});
elements.cookConfirmForm.addEventListener("submit", confirmCookRecipe);

document.querySelector("#close-history-edit").addEventListener("click", closeHistoryEdit);
document.querySelector("#cancel-history-edit").addEventListener("click", closeHistoryEdit);
elements.historyEditDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeHistoryEdit();
});
elements.historyEditDialog.addEventListener("click", (event) => {
  if (event.target === elements.historyEditDialog) closeHistoryEdit();
});
elements.historyEditAddItem.addEventListener("change", () => {
  const item = state.inventory.find((candidate) => candidate.id === elements.historyEditAddItem.value);
  if (!item) return;
  const step = stepForUnit(item.unit);
  elements.historyEditAddQuantity.max = String(item.quantity);
  elements.historyEditAddQuantity.value = String(Math.min(step, Number(item.quantity) || step));
  elements.historyEditAddUnit.textContent = item.unit;
});
elements.historyEditAdd.addEventListener("click", addHistoryEditIngredient);
elements.historyEditIngredients.addEventListener("change", (event) => {
  const input = event.target.closest("[data-history-edit-quantity]");
  if (!input) return;
  const change = state.historyEditChanges.find((candidate) =>
    candidate.itemId === input.dataset.historyEditQuantity);
  if (!change) return;
  change.quantity = Number(input.value);
  renderHistoryEdit();
});
elements.historyEditIngredients.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-edit-remove]");
  if (!button) return;
  captureHistoryEditQuantities();
  state.historyEditChanges = state.historyEditChanges.filter((change) =>
    change.itemId !== button.dataset.historyEditRemove);
  renderHistoryEdit();
});
elements.historyEditForm.addEventListener("submit", saveHistoryEdit);

// ---- 初回登録の操作 ------------------------------------------------------
elements.onboardingLeads.addEventListener("click", (event) => {
  const button = event.target.closest("[data-onboarding-pick]");
  if (!button) return;
  const id = button.dataset.onboardingPick;
  const { leads } = state.onboarding;
  const at = leads.indexOf(id);
  if (at >= 0) {
    leads.splice(at, 1);
  } else if (leads.length < ONBOARDING_MAX_LEADS) {
    leads.push(id);
  } else {
    // 2品でいっぱいのときは、古いほうを押し出す。
    // 「2つまでです」と断るより、選び直せるほうが速い
    leads.shift();
    leads.push(id);
  }
  renderOnboarding();
});

elements.onboardingExtraGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-onboarding-pick]");
  if (!button) return;
  const id = button.dataset.onboardingPick;
  const { extras } = state.onboarding;
  const at = extras.indexOf(id);
  if (at >= 0) extras.splice(at, 1);
  else extras.push(id);
  renderOnboarding();
});

elements.onboardingNext.addEventListener("click", () => {
  if (state.onboarding.step === 1) {
    state.onboarding.step = 2;
    state.onboarding.extras = [];
    renderOnboarding();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  finishOnboarding();
});

elements.onboardingSkip.addEventListener("click", () => {
  if (state.onboarding.step === 2) {
    state.onboarding.step = 1;
    renderOnboarding();
    return;
  }
  // 空の冷蔵庫で始める。サンプルを入れ直すより正直
  state.needsOnboarding = false;
  persistInventory();
  renderAll();
  showView("inventory");
});

// ---- 二人で共有する（画面） -----------------------------------------------
const shareLinkFor = (fridgeId) =>
  `${location.origin}${location.pathname}#join=${fridgeId}`;

function renderHeaderSync() {
  const shared = Boolean(state.share.fridgeId);
  elements.headerSync.hidden = !shared;
  if (!shared) return;

  const pending = pendingSyncChanges().length;
  elements.headerSync.disabled = state.syncing;
  elements.headerSync.classList.toggle("is-syncing", state.syncing);
  elements.headerSync.classList.toggle("is-pending", !state.syncing && pending > 0);
  elements.headerSyncLabel.textContent = state.syncing
    ? "同期中"
    : pending
      ? "未同期"
      : "同期";
  elements.headerSync.setAttribute(
    "aria-label",
    state.syncing
      ? "共有データを同期しています"
      : pending
        ? `未同期の変更が${pending}件あります。今すぐ同期する`
        : "共有データを今すぐ同期する"
  );
}

function renderShare() {
  const shared = Boolean(state.share.fridgeId);
  renderHeaderSync();

  // ★共有していると「この端末のブラウザ内だけ」は事実と違う。約束を書き換える
  const notes = {
    "privacy-note-inventory": ["在庫データは、この端末のブラウザ内だけに保存されます。",
      "在庫データは、この端末と、共有している相手の端末で見られます。"],
    "privacy-note-shopping": ["買い物リストも、この端末のブラウザ内だけに保存されます。",
      "買い物リストも、共有している相手と同じものを見ています。"],
    "privacy-note-history": [
      "履歴は月ごとにまとめ、最大1000件までこの端末に保存します。1000件を超えると古いものから整理されます。",
      "履歴は共有相手と同じものを月ごとにまとめ、最大1000件まで保存します。1000件を超えると古いものから整理されます。"
    ]
  };
  for (const note of elements.privacyNotes) {
    if (!note) continue;
    const pair = notes[note.id];
    if (pair) note.textContent = shared ? pair[1] : pair[0];
  }

  elements.shareOff.hidden = shared;
  elements.shareOn.hidden = !shared;
  elements.shareNote.textContent = shared
    ? "この冷蔵庫は共有しています。変更したあとと、画面に戻ったときに自動で合わせます。"
    : "同じ冷蔵庫を、相手のスマホからも見られるようにします。登録は要りません。";
  if (!shared) return;
  elements.shareLink.value = shareLinkFor(state.share.fridgeId);
  const when = state.share.syncedAt
    ? new Date(state.share.syncedAt).toLocaleString("ja-JP", { hour12: false })
    : "まだ";
  const pending = pendingSyncChanges().length;
  elements.shareStatus.textContent = pending
    ? `最後に合わせたのは ${when}。送れていない変更が${pending}件あります。`
    : `最後に合わせたのは ${when}。`;
}

function showShareMessage(text, tone = "error") {
  elements.shareMessage.textContent = text;
  elements.shareMessage.classList.toggle("is-error", tone === "error");
  elements.shareMessage.hidden = !text;
}

function shareErrorText(error) {
  if (!navigator.onLine) return "いまはつながっていません。電波のあるところで試してください。";
  if (error?.status === 404) return "その冷蔵庫は見つかりませんでした。リンクを確かめてください。";
  if (!error?.status) return "つながりませんでした。時間をおいて試してください。";
  return error.message || "うまくいきませんでした。";
}

// リンクをそのまま貼られても、IDだけ貼られても受け取る
function fridgeIdFrom(value) {
  const text = String(value || "").trim();
  const fromHash = text.match(/#join=([a-z2-9]{22})/);
  if (fromHash) return fromHash[1];
  return /^[a-z2-9]{22}$/.test(text) ? text : "";
}

async function withShareBusy(label, run) {
  const buttons = [elements.shareCreate, elements.shareJoinGo, elements.shareNow,
    elements.headerSync, elements.shareStop];
  buttons.forEach((button) => { button.disabled = true; });
  showShareMessage(label, "info");
  try {
    await run();
    return true;
  } catch (error) {
    showShareMessage(shareErrorText(error), "error");
    return false;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

elements.shareCreate.addEventListener("click", async () => {
  const done = await withShareBusy("用意しています…", createSharedFridge);
  renderShare();
  if (done) showShareMessage("できました。下のリンクを相手に渡してください。", "info");
});

elements.shareJoinGo.addEventListener("click", async () => {
  const fridgeId = fridgeIdFrom(elements.shareJoinId.value);
  if (!fridgeId) {
    showShareMessage("リンクかIDを貼ってください。", "error");
    return;
  }
  requestShareJoin(fridgeId, { returnToSettings: true });
});

function copyForShareJoin(value) {
  return JSON.parse(JSON.stringify(value));
}

const SHARE_JOIN_STORAGE_KEYS = [
  STORAGE_KEY,
  SHOPPING_STORAGE_KEY,
  COOKING_HISTORY_STORAGE_KEY,
  SHELF_COUNTS_STORAGE_KEY,
  SYNC_STORAGE_KEY,
  SHARE_STORAGE_KEY
];

function shareJoinStoredValues() {
  if (!state.storageEnabled) return null;
  try {
    return Object.fromEntries(SHARE_JOIN_STORAGE_KEYS.map((key) => [key, localStorage.getItem(key)]));
  } catch {
    return null;
  }
}

function shareJoinSnapshot() {
  return {
    inventory: copyForShareJoin(state.inventory),
    shopping: copyForShareJoin(state.shopping),
    cookingHistory: copyForShareJoin(state.cookingHistory),
    shelfCounts: copyForShareJoin(state.shelfCounts),
    syncMeta: copyForShareJoin(state.syncMeta),
    share: copyForShareJoin(state.share),
    needsOnboarding: Boolean(state.needsOnboarding),
    lastUndo: state.lastUndo ? copyForShareJoin(state.lastUndo) : null,
    // 初回利用者は保存キー自体がまだ無い。「空配列を保存した状態」と区別し、
    // 失敗後の次回起動でも初回案内が正しく出るよう、キーの有無まで覚える
    storedValues: shareJoinStoredValues()
  };
}

// 参加時の通信が途中で失敗したら、受信途中の内容も残さず参加前へ戻す。
// persistInventory() 等は同期印を付け直すため、ここは元のスナップショットを
// localStorageへ直接戻して完全に同じ状態へ復元する。
function restoreShareJoinSnapshot(snapshot) {
  state.inventory = snapshot.inventory;
  state.shopping = snapshot.shopping;
  state.cookingHistory = snapshot.cookingHistory;
  state.shelfCounts = snapshot.shelfCounts;
  state.syncMeta = snapshot.syncMeta;
  state.share = snapshot.share;
  state.needsOnboarding = snapshot.needsOnboarding;
  state.lastUndo = snapshot.lastUndo;

  if (state.storageEnabled && snapshot.storedValues) {
    try {
      for (const [key, value] of Object.entries(snapshot.storedValues)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    } catch {
      markStorageUnavailable();
    }
  }
  renderAll();
  renderShare();
  renderDayAfterCheck();
}

function shareJoinCounts() {
  return [
    { label: "在庫", count: state.inventory.length },
    { label: "買い物", count: state.shopping.length },
    { label: "履歴", count: state.cookingHistory.length }
  ];
}

function renderShareJoinConfirmation() {
  const counts = shareJoinCounts();
  const hasLocalData = counts.some(({ count }) => count > 0);
  elements.shareJoinIntro.textContent = hasLocalData
    ? "この端末には、まだ共有していない内容があります。相手へ送るか、この端末だけ入れ替えるかを選んでください。"
    : "この端末には、相手へ送る在庫・買い物・履歴はありません。共有されている冷蔵庫の内容を受け取ります。";

  elements.shareJoinCounts.replaceChildren(...counts.map(({ label, count }) => {
    const item = document.createElement("li");
    item.textContent = `${label} ${count}件`;
    return item;
  }));

  const replaceStrong = elements.shareJoinReplace.querySelector("strong");
  const replaceSmall = elements.shareJoinReplace.querySelector("small");
  replaceStrong.textContent = hasLocalData ? "共有の内容に入れ替える" : "この冷蔵庫に入る";
  replaceSmall.textContent = hasLocalData
    ? "この端末の在庫・買い物・履歴は共有先へ送りません"
    : "共有されている内容をこの端末へ受け取ります";
  elements.shareJoinMerge.hidden = !hasLocalData;
  elements.shareJoinWarning.textContent = hasLocalData
    ? "入れ替えると、この端末の現在の内容はアプリから外れます。残したい場合は、いったんやめて設定の「書き出す」で保存してください。"
    : "リンクを知っている人は、この冷蔵庫の内容を見たり変更したりできます。";
  elements.shareJoinStatus.hidden = true;
  elements.shareJoinStatus.classList.remove("is-error");
}

function requestShareJoin(fridgeId, { returnToSettings = false } = {}) {
  if (!fridgeId || state.syncing) return;
  state.pendingShareJoinId = fridgeId;
  state.shareJoinReturnToSettings = returnToSettings;
  elements.shareJoinId.value = "";
  if (elements.settingsDialog.open) elements.settingsDialog.close();
  renderShareJoinConfirmation();
  elements.shareJoinDialog.showModal();
  requestAnimationFrame(() => elements.shareJoinReplace.focus());
}

function cancelShareJoin() {
  const returnToSettings = state.shareJoinReturnToSettings;
  state.pendingShareJoinId = "";
  state.shareJoinReturnToSettings = false;
  if (elements.shareJoinDialog.open) elements.shareJoinDialog.close();
  if (returnToSettings && !elements.settingsDialog.open) {
    elements.settingsDialog.showModal();
  }
}

function setShareJoinBusy(busy, text = null) {
  [elements.shareJoinReplace, elements.shareJoinMerge, elements.shareJoinCancel,
    elements.shareJoinCancelIcon].forEach((button) => { button.disabled = busy; });
  if (text !== null) {
    elements.shareJoinStatus.textContent = text;
    elements.shareJoinStatus.hidden = !text;
    elements.shareJoinStatus.classList.remove("is-error");
  }
}

// mode=replace は相手の内容だけを採り、mode=merge はこの端末の内容も送る。
// どちらも、GET/POSTの途中で失敗した場合は参加前の状態へ戻す。
async function joinSharedFridge(fridgeId, mode) {
  const snapshot = shareJoinSnapshot();
  try {
    if (mode === "replace") {
      state.inventory = [];
      state.shopping = [];
      state.cookingHistory = [];
      state.shelfCounts = { ...DEFAULT_STORAGE_SHELF_COUNTS };
      state.syncMeta = {};
      state.lastUndo = null;
      state.needsOnboarding = false;
    } else {
      markSyncChanges();
      for (const meta of Object.values(state.syncMeta)) {
        meta.version = 0;
        meta.dirty = true;
      }
    }

    state.share = { fridgeId, seq: 0, syncedAt: "" };
    persistShare();
    persistSyncMeta();
    await syncOnce();
    return { wasOnboarding: snapshot.needsOnboarding };
  } catch (error) {
    restoreShareJoinSnapshot(snapshot);
    throw error;
  }
}

async function completeShareJoin(mode) {
  const fridgeId = state.pendingShareJoinId;
  if (!fridgeId) return;
  setShareJoinBusy(true, mode === "merge" ? "今の内容も合わせています…" : "共有の内容を受け取っています…");
  try {
    const { wasOnboarding } = await joinSharedFridge(fridgeId, mode);
    state.pendingShareJoinId = "";
    state.shareJoinReturnToSettings = false;
    elements.shareJoinDialog.close();
    if (wasOnboarding) showView("inventory");
    renderShare();
    if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
    showShareMessage(
      mode === "merge"
        ? "つながりました。この端末にあった内容も相手へ送りました。"
        : "つながりました。共有されている内容へ入れ替えました。",
      "info"
    );
  } catch (error) {
    elements.shareJoinStatus.textContent = `${shareErrorText(error)} この端末の内容は元に戻しました。`;
    elements.shareJoinStatus.hidden = false;
    elements.shareJoinStatus.classList.add("is-error");
  } finally {
    setShareJoinBusy(false);
  }
}

elements.shareJoinReplace.addEventListener("click", () => completeShareJoin("replace"));
elements.shareJoinMerge.addEventListener("click", () => completeShareJoin("merge"));
elements.shareJoinCancel.addEventListener("click", cancelShareJoin);
elements.shareJoinCancelIcon.addEventListener("click", cancelShareJoin);
elements.shareJoinDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelShareJoin();
});
elements.shareJoinDialog.addEventListener("click", (event) => {
  if (event.target === elements.shareJoinDialog) cancelShareJoin();
});

elements.shareCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.shareLink.value);
    showShareMessage("リンクをコピーしました。", "info");
  } catch {
    // 権限が無い端末もある。その場合は選択状態にして手で写してもらう
    elements.shareLink.select();
    showShareMessage("コピーできませんでした。選択されているので手で写してください。", "error");
  }
});

elements.shareNow.addEventListener("click", async () => {
  cancelScheduledAutoSync();
  const done = await withShareBusy("合わせています…", syncOnce);
  renderShare();
  if (done) showShareMessage("合わせました。", "info");
});

elements.headerSync.addEventListener("click", async () => {
  cancelScheduledAutoSync();
  const done = await withShareBusy("合わせています…", syncOnce);
  renderShare();
  showToast(done ? "同期しました" : elements.shareMessage.textContent);
});

elements.shareStop.addEventListener("click", () => {
  cancelScheduledAutoSync();
  state.share = { fridgeId: "", seq: 0, syncedAt: "" };
  persistShare();
  renderShare();
  showShareMessage("この端末の共有をやめました。冷蔵庫の中身は残っています。", "info");
});

function cancelScheduledAutoSync() {
  if (autoSyncTimer === null) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = null;
}

// 保存操作が連続したときは最後の操作から少し待ち、1回の通信へまとめる。
// 同期で受け取った内容を保存している間は state.syncing が true なので再送しない。
function scheduleAutoSync() {
  if (!state.share.fridgeId || state.syncing) return;
  cancelScheduledAutoSync();
  renderHeaderSync();
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    syncInBackground();
  }, AUTO_SYNC_DELAY_MS);
}

// 開いたとき・画面に戻ったとき・保存操作のあとに合わせる。
function syncInBackground() {
  if (!state.share.fridgeId || !navigator.onLine) return;
  syncOnce().then(() => renderShare()).catch(() => renderHeaderSync());
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // 日をまたいで開きっぱなしだった場合も、期限の残り日数を現在日に更新する。
  renderInventory();
  syncInBackground();
});
window.addEventListener("online", syncInBackground);

elements.exportData.addEventListener("click", downloadBackup);

elements.importData.addEventListener("click", () => {
  elements.importFile.value = "";
  elements.importFile.click();
});

elements.importFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  elements.importError.hidden = true;
  try {
    const backup = readBackup(await file.text());
    state.pendingBackup = backup;
    elements.importPreviewSummary.textContent = describeBackup(backup);
    elements.importPreview.hidden = false;
  } catch (error) {
    state.pendingBackup = null;
    elements.importPreview.hidden = true;
    elements.importError.textContent = error.message;
    elements.importError.hidden = false;
  }
});

elements.importCancel.addEventListener("click", () => {
  state.pendingBackup = null;
  elements.importPreview.hidden = true;
});

elements.importApply.addEventListener("click", () => {
  if (!state.pendingBackup) return;
  const applied = applyBackup(state.pendingBackup);
  state.pendingBackup = null;
  elements.importPreview.hidden = true;
  if (applied) {
    elements.settingsDialog.close();
    showView("inventory");
    showToast("読み込んだデータに置き換えました");
  }
});

elements.openRefine.addEventListener("click", () => {
  if (elements.dialog.open) closeIngredientDialog();
  startRefine();
});

elements.refineGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-refine-pick]");
  if (!button || button.disabled) return;
  toggleRefineItem(button.dataset.refinePick);
});

elements.refineNext.addEventListener("click", () => {
  markCategoryReviewed();
  state.refine.index += 1;
  state.refine.added = [];
  if (state.refine.index >= refineCategories().length) {
    finishRefine();
    showToast("冷蔵庫を見直しました");
    return;
  }
  renderRefine();
  window.scrollTo({ top: 0, behavior: "auto" });
});

elements.refineQuit.addEventListener("click", finishRefine);

elements.dayAfterList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-day-after]");
  if (!button) return;
  answerDayAfter(button.dataset.dayAfterId, button.dataset.dayAfter);
});

elements.dayAfterSkip.addEventListener("click", () => {
  // 今日はもう聞かない。明日また出す
  state.settings.dayAfterSkippedOn = todayIso();
  persistSettings();
  renderDayAfterCheck();
});

elements.sampleNoticeClear.addEventListener("click", clearSampleItems);
elements.sampleNoticeKeep.addEventListener("click", () => {
  state.settings.sampleNoticeDone = true;
  persistSettings();
  renderSampleNotice();
});

elements.expiryAlertList.addEventListener("click", (event) => {
  // 使いきれなかったと分かった瞬間に片付けられるよう、編集ダイアログを
  // 開かずにここで捨てる。廃棄として履歴に残り、トーストの「戻す」で取り消せる
  const discard = event.target.closest("[data-expiry-discard]");
  if (discard) {
    const target = state.inventory.find((candidate) => candidate.id === discard.dataset.expiryDiscard);
    if (target) discardItem(target);
    return;
  }
  const button = event.target.closest("[data-expiry-edit]");
  if (!button) return;
  const item = state.inventory.find((candidate) => candidate.id === button.dataset.expiryEdit);
  if (!item) return;
  openIngredientDialog(item);
  requestAnimationFrame(() => elements.ingredientExpiry.focus());
});

// 量が足りないと分かったときの逃げ道
elements.cookFallbackSingle.addEventListener("click", () => {
  setPendingCookServings(1);
});
elements.cookFallbackAnyway.addEventListener("click", (event) => {
  confirmCookRecipe(event, { ignoreAmounts: true });
});

elements.fridgeScene.addEventListener("pointerdown", (event) => {
  const source = event.target.closest("[data-drag-item]");
  if (
    state.fridgeDrag
    || !source
    || (event.pointerType === "mouse" && event.button !== 0)
  ) return;

  state.fridgeDrag = {
    pointerId: event.pointerId,
    itemId: source.dataset.dragItem,
    source,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    distance: 0,
    active: false,
    ghost: null,
    dropTarget: null,
    consumeTarget: null,
    targetId: null,
    placeAfter: false,
    previewRow: null,
    previewItems: [],
    previewTarget: null,
    previewIndex: null,
    foodCenters: null,
    timer: setTimeout(beginFridgeDrag, 280)
  };
  source.setPointerCapture?.(event.pointerId);
});

elements.fridgeScene.addEventListener("pointermove", updateFridgeDrag);
elements.fridgeScene.addEventListener("pointerup", finishFridgeDrag);
elements.fridgeScene.addEventListener("pointercancel", () => {
  cleanupFridgeDrag({ suppressClick: Boolean(state.fridgeDrag?.active) });
});

elements.fridgeScene.addEventListener("click", (event) => {
  if (Date.now() < state.suppressFridgeClickUntil) {
    event.preventDefault();
    return;
  }
  const unitTab = event.target.closest("[data-fridge-tab]");
  if (unitTab) {
    if (state.fridgeTab !== unitTab.dataset.fridgeTab) {
      state.fridgeTab = unitTab.dataset.fridgeTab;
      renderInventory();
    }
    return;
  }
  const shelfAdd = event.target.closest("[data-shelf-add]");
  if (shelfAdd) {
    openIngredientDialog(
      null,
      shelfAdd.dataset.shelfAdd,
      Number(shelfAdd.dataset.shelfAddIndex)
    );
    return;
  }
  const shelfControl = event.target.closest("[data-shelf-change]");
  if (shelfControl) {
    changeShelfCount(
      shelfControl.dataset.shelfLocation,
      Number(shelfControl.dataset.shelfChange)
    );
    return;
  }
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

// 冷蔵庫タブの中で「絵」と「一覧」を行き来する
elements.goInventoryList.addEventListener("click", () => showView("management"));
elements.goFridgeScene.addEventListener("click", () => showView("inventory"));

elements.todayIngredientTrigger.addEventListener("click", openTodayIngredientDialog);
elements.closeTodayIngredientDialog.addEventListener("click", closeTodayIngredientDialog);
elements.todayIngredientDialog.addEventListener("click", (event) => {
  if (event.target === elements.todayIngredientDialog) closeTodayIngredientDialog();
});
elements.todayIngredientOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-today-ingredient]");
  if (!button) return;
  setTodayIngredientPriority(button.dataset.todayIngredient);
  closeTodayIngredientDialog();
});
elements.clearTodayIngredient.addEventListener("click", () => {
  setTodayIngredientPriority("");
  closeTodayIngredientDialog();
});

elements.prioritySelect.addEventListener("change", () => {
  state.priority = elements.prioritySelect.value;
  state.visibleRecipeCount = RECIPE_PAGE_SIZE;
  renderRecipes();
});

elements.showMoreRecipes.addEventListener("click", () => {
  state.visibleRecipeCount = Math.min(
    state.visibleRecipeCount + RECIPE_PAGE_SIZE,
    RECIPES.length
  );
  renderRecipes();
});

elements.inventoryList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const item = state.inventory.find((candidate) => candidate.id === button.dataset.id);
  if (!item) return;

  if (button.dataset.action === "edit") openIngredientDialog(item);
  // 残量を手で動かしたときは、本人が実物を見ているので量は確認済みになる。
  // 「まだある」（confirm）は在庫の有無の合図なので、量の確信度は上げない。
  if (button.dataset.action === "increase") {
    updateItem(item.id, (current) => {
      current.quantity = Number((current.quantity + current.step).toFixed(2));
      current.maxQuantity = Math.max(Number(current.maxQuantity) || 0, current.quantity);
      current.confirmedAt = todayIso();
      current.quantityConfidence = QUANTITY_CONFIRMED;
    }, { recordHistory: true });
  }
  if (button.dataset.action === "decrease") {
    const nextQuantity = Number((item.quantity - item.step).toFixed(2));
    if (nextQuantity <= 0) {
      consumeItem(item);
    } else {
      updateItem(item.id, (current) => {
        current.quantity = nextQuantity;
        current.confirmedAt = todayIso();
        current.quantityConfidence = QUANTITY_CONFIRMED;
      }, { recordHistory: true });
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

elements.managementExpiringList.addEventListener("click", (event) => {
  const discard = event.target.closest("[data-expiry-discard]");
  if (discard) {
    const target = state.inventory.find((candidate) => candidate.id === discard.dataset.expiryDiscard);
    if (target) discardItem(target);
    return;
  }
  const button = event.target.closest("[data-fridge-edit]");
  if (!button) return;
  const item = state.inventory.find((candidate) => candidate.id === button.dataset.fridgeEdit);
  if (item) openIngredientDialog(item);
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
  if (button) openCookConfirmation(button.dataset.cook);
});

elements.shoppingRecommendations.addEventListener("click", (event) => {
  const button = event.target.closest("[data-recommend-id]");
  if (!button) return;
  const recommendation = shoppingRecommendations().find((item) =>
    item.ingredientId === button.dataset.recommendId
    && item.unit === button.dataset.recommendUnit
  );
  if (!recommendation || recommendation.added) return;

  addShoppingItem({
    ingredientId: recommendation.ingredientId,
    name: recommendation.name,
    quantity: recommendation.quantity,
    unit: recommendation.unit,
    location: recommendation.location,
    source: "recommendation",
    reason: recommendation.reason
  });
  persistShoppingList();
  renderShopping();
  showToast(`${recommendation.name}を買い物リストに追加しました`);
});

elements.shoppingList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-shopping-check]");
  if (!checkbox) return;
  const item = state.shopping.find((candidate) => candidate.id === checkbox.dataset.shoppingCheck);
  if (!item) return;
  item.checked = checkbox.checked;
  persistShoppingList();
  renderShopping();
});

elements.shoppingList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-shopping-delete]");
  if (deleteButton) {
    state.shopping = state.shopping.filter((item) => item.id !== deleteButton.dataset.shoppingDelete);
    persistShoppingList();
    renderShopping();
    showToast("買い物リストから削除しました");
    return;
  }

  const stockButton = event.target.closest("[data-shopping-stock]");
  if (!stockButton) return;
  const item = state.shopping.find((candidate) => candidate.id === stockButton.dataset.shoppingStock);
  if (!item) return;
  const existing = state.inventory.find((candidate) =>
    candidate.active !== false
    && (candidate.id === item.ingredientId || candidate.name === item.name)
  );
  if (existing && existing.unit !== item.unit) {
    showToast(`在庫では${existing.unit}で管理中です。単位を合わせてください`);
    return;
  }

  addOrMergeInventoryItem({
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    location: item.location
  });
  state.shopping = state.shopping.filter((candidate) => candidate.id !== item.id);
  persistInventory();
  persistShoppingList();
  renderAll();
  showToast(`${item.name}を在庫へ移しました`);
});

elements.clearBought.addEventListener("click", () => {
  state.shopping = state.shopping.filter((item) => !item.checked);
  persistShoppingList();
  renderShopping();
  showToast("購入済みの項目を消しました");
});

elements.cookingHistoryList.addEventListener("click", (event) => {
  const moreButton = event.target.closest("[data-history-more]");
  if (moreButton) {
    state.historyVisibleCount = Math.min(
      state.historyVisibleCount + HISTORY_PAGE_SIZE,
      state.cookingHistory.length
    );
    renderCookingHistory();
    return;
  }
  const editButton = event.target.closest("[data-history-edit]");
  if (editButton) {
    openHistoryEdit(editButton.dataset.historyEdit);
    return;
  }
  const button = event.target.closest("[data-history-undo]");
  if (!button) return;
  undoCookingHistoryEntry(button.dataset.historyUndo);
});

elements.toastAction.addEventListener("click", () => {
  const undo = state.lastUndo;
  state.lastUndo = null;
  elements.toast.hidden = true;
  if (undo) undo();
});

elements.appVersion.textContent = `v${APP_VERSION}`;
loadDevice();
elements.deviceName.value = state.device.name;
loadSyncMeta();
loadShare();
loadSettings();
elements.settingShowNutrition.checked = state.settings.showNutrition;
setNutritionHelpExpanded(false);
loadShelfCounts();
loadRecentIngredients();
loadInventory();
loadShoppingList();
loadCookingHistory();
syncQuantityControl(
  elements.ingredientQuantity,
  elements.ingredientQuantityRange,
  elements.ingredientUnit.value
);
syncQuantityControl(
  elements.shoppingQuantity,
  elements.shoppingQuantityRange,
  elements.shoppingUnit.value
);
renderAll();
renderShare();
renderRefineEntry();
renderDayAfterCheck();
renderSampleNotice();

if (state.needsOnboarding) startOnboarding();
syncInBackground();

// ホーム画面のアイコンを長押しして選ぶショートカット（manifest.json）から
// 開いたとき、その画面を最初に出す。履歴は触らない（戻るで画面が増えると
// 「冷蔵庫へ戻れない」感じになるため）。
const VIEW_BY_HASH = {
  "#recipes": "suggestions",
  "#shopping": "shopping",
  "#stock": "management"
};

function showViewFromHash() {
  // 共有リンク（#join=...）で開かれたら、その冷蔵庫へ入る。
  // リンクを渡すだけで済むのが、この方式にした理由そのもの
  const invited = fridgeIdFrom(window.location.hash);
  if (invited && invited !== state.share.fridgeId) {
    // 履歴からIDを消す。あとで戻るボタンでもう一度確認を出さない。
    // リンクを開いただけでは同期せず、確認画面で本人が選んでから参加する。
    history.replaceState(null, "", window.location.pathname);
    requestShareJoin(invited);
    return;
  }
  // 初回登録の途中は割り込ませない
  if (!elements.onboardingView.hidden) return;
  const viewName = VIEW_BY_HASH[window.location.hash];
  if (viewName) showView(viewName);
}

showViewFromHash();
window.addEventListener("hashchange", showViewFromHash);
window.addEventListener("resize", scheduleInventoryScrollLock);
window.visualViewport?.addEventListener("resize", scheduleInventoryScrollLock);
if ("ResizeObserver" in window) {
  const inventoryFitObserver = new ResizeObserver(scheduleInventoryScrollLock);
  inventoryFitObserver.observe(elements.inventoryView);
}
scheduleInventoryScrollLock();

// ここまでで最初の画面が組み上がっているので、起動の読み込み画面を消す。
// index.html 側にも時間切れで消す安全弁があるので、ここが例外で
// 実行されなくても読み込み画面が残り続けることはない。
document.getElementById("boot-loading")?.setAttribute("hidden", "");
if (RECIPE_EXPANSION_UNAVAILABLE) {
  showToast("追加レシピを読み込めませんでした。基本のレシピだけで表示しています。");
}

// 通信が無くても起動できるようにする。index.html を file:// で直接開いた
// ときは Service Worker を登録できないので、その場合は何もしない。
if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
