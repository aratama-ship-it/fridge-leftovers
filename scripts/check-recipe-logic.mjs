#!/usr/bin/env node
// 在庫とレシピの突き合わせを、ブラウザを開かずに確かめる。
//
//   node scripts/check-recipe-logic.mjs
//
// これまで自動検証は「初期単位」「キャッシュ整合」「アイコン」「アトラス」だけで、
// アプリの中心にある判定（不足かどうか・代用が効くか・単位換算・数量の確信度・
// 調理後の減算）には何も無かった。ここが壊れると「作れるのに候補に出ない」
// 「作れないのに材料ありと出る」という、いちばん困る壊れ方をする。
//
// app.js はブラウザ前提（document を触る）なので読み込めない。必要な純粋関数と
// 定数だけを切り出して評価する。切り出しに失敗したら黙って通さず、落とす。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "app.js"), "utf8");

// app.js から定数・関数を名前で切り出す
function takeConst(name) {
  const start = app.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`定数 ${name} が見つかりません`);
  const nextConst = app.indexOf("\nconst ", start + 1);
  const nextFunction = app.indexOf("\nfunction ", start + 1);
  const ends = [nextConst, nextFunction].filter((at) => at > 0);
  const end = ends.length ? Math.min(...ends) : app.length;
  const segment = app.slice(start, end);
  // 定数の直後にコメントが続くことがあるので、最後の ; までで切る
  return segment.slice(0, segment.lastIndexOf(";") + 1);
}

function takeFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`関数 ${name} が見つかりません`);
  const end = app.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`関数 ${name} の終わりが見つかりません`);
  return app.slice(start, end + 3);
}

const CONSTANTS = [
  "QUANTITY_CONFIRMED", "QUANTITY_ESTIMATED", "QUANTITY_UNKNOWN",
  "DAY_AFTER_LEVELS", "DAY_AFTER_LIMIT", "SYNC_KINDS", "STORAGE_SHELF_CAPACITIES",
  "CONFIDENCE_ORDER", "quantityConfidence", "quantityUnknown", "lessCertain",
  "RECIPES", "RECEIPT_RULES", "INGREDIENT_SUBSTITUTES", "UNIT_CONVERSIONS",
  "SUBSTITUTE_GENERICS", "RECIPE_LIST_SERVINGS", "RECIPE_ILLUSTRATIONS"
];
const FUNCTIONS = [
  "normalizedExpiryDate", "localDateIso", "expiryDayDifference", "expiryAlertState",
  "normalizedSubstitute", "conversionRatio", "stockForRequirement",
  "availableForRequirement", "requiredAmount", "shortageFor", "unconfirmedFor",
  "cookBlockers", "confirmUnknownAmounts", "optionalReady",
  "inventoryLevel", "pendingDayAfterItems", "dayAfterCorrection",
  "historyEntryType", "historyEntryTime",
  "currentChangeAttribution", "markSyncChanges", "pendingSyncChanges", "applySyncResult", "mergeEntity"
];

// stockForRequirement は inventoryMap() と state を使う。テスト側で差し替える。
const harness = `
"use strict";
const todayIso = () => "2026-01-01";
const state = { inventory: [], servings: 1, cookingHistory: [], shopping: [], shelfCounts: {}, syncMeta: {}, device: { id: "test-device", name: "テスト端末" }, settings: { dayAfterSkippedOn: "" } };
const inventoryMap = () => new Map(state.inventory.filter((item) => item.active !== false).map((item) => [item.id, item]));
${CONSTANTS.map(takeConst).join("\n")}
${FUNCTIONS.map(takeFunction).join("\n")}
return {
  state, RECIPES, RECEIPT_RULES, RECIPE_ILLUSTRATIONS, INGREDIENT_SUBSTITUTES, UNIT_CONVERSIONS,
  QUANTITY_CONFIRMED, QUANTITY_ESTIMATED, QUANTITY_UNKNOWN,
  quantityConfidence, lessCertain, conversionRatio, stockForRequirement,
  availableForRequirement, shortageFor, unconfirmedFor, cookBlockers,
  confirmUnknownAmounts, optionalReady, requiredAmount,
  pendingDayAfterItems, dayAfterCorrection, DAY_AFTER_LEVELS,
  normalizedExpiryDate, expiryDayDifference, expiryAlertState,
  markSyncChanges, pendingSyncChanges, applySyncResult, mergeEntity
};
`;

const app_ = new Function(harness)();
const {
  state, RECIPES, RECEIPT_RULES, RECIPE_ILLUSTRATIONS,
  QUANTITY_CONFIRMED, QUANTITY_ESTIMATED, QUANTITY_UNKNOWN,
  quantityConfidence, lessCertain, stockForRequirement,
  shortageFor, unconfirmedFor, cookBlockers, confirmUnknownAmounts,
  pendingDayAfterItems, dayAfterCorrection, DAY_AFTER_LEVELS,
  normalizedExpiryDate, expiryDayDifference, expiryAlertState,
  markSyncChanges, pendingSyncChanges, applySyncResult, mergeEntity
} = app_;

const ruleFor = (id) => RECEIPT_RULES.find((rule) => rule.id === id);
const recipeFor = (id) => RECIPES.find((recipe) => recipe.id === id);

// カタログの標準単位で在庫を1つ作る
function stock(id, quantity, extra = {}) {
  const rule = ruleFor(id);
  if (!rule && !extra.unit) throw new Error(`${id} のカタログ定義が見つかりません`);
  return {
    id,
    name: rule?.name || id,
    quantity,
    unit: extra.unit || rule.unit,
    location: rule?.location || "冷蔵",
    active: true,
    ...extra
  };
}

let failures = 0;
function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures += 1;
    console.log(`✗ ${label}\n    実際: ${JSON.stringify(actual)}\n    期待: ${JSON.stringify(expected)}`);
  }
}

// ---- 賞味期限 ------------------------------------------------------------
check("正しい賞味期限の日付を保存できる", normalizedExpiryDate("2026-08-10"), "2026-08-10");
check("存在しない日付は保存しない", normalizedExpiryDate("2026-02-30"), "");
check("賞味期限の前日差を時刻なしで計算する", expiryDayDifference("2026-08-10", "2026-08-07"), 3);
check("期限切れは超過日数を返す", expiryAlertState("2026-08-06", "2026-08-07"), { days: -1, kind: "expired", label: "1日超過" });
check("当日は今日までと知らせる", expiryAlertState("2026-08-07", "2026-08-07"), { days: 0, kind: "today", label: "今日まで" });
check("3日以内は残り日数を知らせる", expiryAlertState("2026-08-10", "2026-08-07"), { days: 3, kind: "soon", label: "あと3日" });
check("4日以上先はアラートに出さない", expiryAlertState("2026-08-11", "2026-08-07"), null);
check("未設定はアラートに出さない", expiryAlertState("", "2026-08-07"), null);

// ---- 確信度そのもの ------------------------------------------------------
check("項目が無い在庫は確認済みとして扱う", quantityConfidence({ quantity: 1 }), QUANTITY_CONFIRMED);
check("知らない値は確認済みへ落とす", quantityConfidence({ quantityConfidence: "でたらめ" }), QUANTITY_CONFIRMED);
check("確認済み＋推定は推定", lessCertain(QUANTITY_CONFIRMED, QUANTITY_ESTIMATED), QUANTITY_ESTIMATED);
check("推定＋不明は不明", lessCertain(QUANTITY_ESTIMATED, QUANTITY_UNKNOWN), QUANTITY_UNKNOWN);
check("不明＋確認済みは不明", lessCertain(QUANTITY_UNKNOWN, QUANTITY_CONFIRMED), QUANTITY_UNKNOWN);

// ---- 不足判定 ------------------------------------------------------------
// 卵を使うレシピを1つ選び、卵の必要量だけを動かして確かめる
const eggRecipe = RECIPES.find((recipe) => recipe.required.some((item) => item.id === "eggs"));
if (!eggRecipe) throw new Error("卵を使うレシピが見つかりません");
const eggNeed = eggRecipe.required.find((item) => item.id === "eggs").quantity;
const others = eggRecipe.required.filter((item) => item.id !== "eggs");

const withEggs = (quantity, extra) => {
  state.inventory = [stock("eggs", quantity, extra), ...others.map((item) => stock(item.id, item.quantity * 10, { unit: item.unit }))];
  return shortageFor(eggRecipe, 1).map((item) => item.id);
};

check("足りていれば不足なし", withEggs(eggNeed), []);
check("足りなければ不足に出る", withEggs(eggNeed - 0.5), ["eggs"]);
check("持っていなければ不足に出る", (() => {
  state.inventory = others.map((item) => stock(item.id, item.quantity * 10, { unit: item.unit }));
  return shortageFor(eggRecipe, 1).map((item) => item.id);
})(), ["eggs"]);

// ★核心。量が未確認なら、数値が足りなくても候補から落とさない
check("量が未確認なら不足に数えない",
  withEggs(eggNeed - 0.5, { quantityConfidence: QUANTITY_UNKNOWN }), []);
check("量が未確認なら作る前に確認する材料に出る", (() => {
  withEggs(eggNeed - 0.5, { quantityConfidence: QUANTITY_UNKNOWN });
  return unconfirmedFor(eggRecipe).map((item) => item.id);
})(), ["eggs"]);
check("推定は確認済みと同じに扱う（不足になる）",
  withEggs(eggNeed - 0.5, { quantityConfidence: QUANTITY_ESTIMATED }), ["eggs"]);
check("確認済みなら確認する材料には出ない", (() => {
  withEggs(eggNeed);
  return unconfirmedFor(eggRecipe).map((item) => item.id);
})(), []);

// 人数を増やせば不足に転じる
check("4人分にすると足りなくなる", (() => {
  withEggs(eggNeed);
  return shortageFor(eggRecipe, 4).map((item) => item.id);
})(), ["eggs"]);

// ---- 作る前の量確認 ------------------------------------------------------
// 未回答は「ある」として扱い、外したものだけ止める
const unknownEggs = (quantity) => withEggs(quantity, { quantityConfidence: QUANTITY_UNKNOWN });

check("未回答なら作れる", (() => {
  unknownEggs(eggNeed - 0.5);
  return cookBlockers(eggRecipe, 1, {}).canCook;
})(), true);

check("足りないと答えたら止まる", (() => {
  unknownEggs(eggNeed - 0.5);
  return cookBlockers(eggRecipe, 1, { eggs: false }).canCook;
})(), false);

check("足りないと答えた材料が denied に出る", (() => {
  unknownEggs(eggNeed - 0.5);
  return cookBlockers(eggRecipe, 1, { eggs: false }).denied.map((item) => item.id);
})(), ["eggs"]);

check("あると答えたら作れる", (() => {
  unknownEggs(eggNeed - 0.5);
  return cookBlockers(eggRecipe, 1, { eggs: true }).canCook;
})(), true);

check("数値で不足していれば、回答に関係なく止まる", (() => {
  withEggs(eggNeed - 0.5);
  return cookBlockers(eggRecipe, 1, { eggs: true }).canCook;
})(), false);

// あると答えた分は、必要量まで上げて確認済みにする
check("あると答えた材料は必要量まで上がって確認済みになる", (() => {
  unknownEggs(0.5);
  confirmUnknownAmounts(eggRecipe, 2, { eggs: true });
  const eggs = state.inventory.find((item) => item.id === "eggs");
  return [eggs.quantity, eggs.quantityConfidence];
})(), [eggNeed * 2, QUANTITY_CONFIRMED]);

check("もともと足りていれば量は下げない", (() => {
  unknownEggs(99);
  confirmUnknownAmounts(eggRecipe, 1, { eggs: true });
  return state.inventory.find((item) => item.id === "eggs").quantity;
})(), 99);

check("足りないと答えた材料は不明のまま残す", (() => {
  unknownEggs(0.5);
  confirmUnknownAmounts(eggRecipe, 1, { eggs: false });
  const eggs = state.inventory.find((item) => item.id === "eggs");
  return [eggs.quantity, eggs.quantityConfidence];
})(), [0.5, QUANTITY_UNKNOWN]);

check("確認済みの材料には触らない", (() => {
  withEggs(0.5);
  confirmUnknownAmounts(eggRecipe, 1, { eggs: true });
  return state.inventory.find((item) => item.id === "eggs").quantity;
})(), 0.5);

// ---- 代用 ----------------------------------------------------------------
const porkRecipe = RECIPES.find((recipe) => recipe.required.some((item) => item.id === "pork"));
if (porkRecipe) {
  const porkNeed = porkRecipe.required.find((item) => item.id === "pork").quantity;
  const rest = porkRecipe.required.filter((item) => item.id !== "pork");
  const withCut = (id, quantity) => {
    state.inventory = [stock(id, quantity), ...rest.map((item) => stock(item.id, item.quantity * 10, { unit: item.unit }))];
    return shortageFor(porkRecipe, 1).map((item) => item.id);
  };
  check("豚こまの代わりに豚バラで足りる", withCut("pork-belly", porkNeed), []);
  check("代用でも量が足りなければ不足", withCut("pork-belly", porkNeed / 2), ["pork"]);
}

// ---- 単位換算 ------------------------------------------------------------
const cabbageRecipe = RECIPES.find((recipe) => recipe.required.some((item) => item.id === "cabbage"));
if (cabbageRecipe) {
  const need = cabbageRecipe.required.find((item) => item.id === "cabbage");
  const rest = cabbageRecipe.required.filter((item) => item.id !== "cabbage");
  const withCabbage = (quantity, unit) => {
    state.inventory = [stock("cabbage", quantity, { unit }), ...rest.map((item) => stock(item.id, item.quantity * 10, { unit: item.unit }))];
    return shortageFor(cabbageRecipe, 1).map((item) => item.id);
  };
  check(`キャベツ1個は${need.quantity}${need.unit}の要求を満たす`, withCabbage(1, "個"), []);
  check("キャベツを個で持っていても、要求が大きければ不足", (() => {
    state.inventory = [stock("cabbage", 0.05, { unit: "個" }), ...rest.map((item) => stock(item.id, item.quantity * 10, { unit: item.unit }))];
    return shortageFor(cabbageRecipe, 1).map((item) => item.id);
  })(), ["cabbage"]);
  // 二重換算の防止。登録されていない代用へ、単位の違う在庫を当てない
  check("ミニトマトgでトマト個の要求は満たさない", (() => {
    const tomatoRecipe = RECIPES.find((recipe) => recipe.required.some((item) => item.id === "tomato"));
    if (!tomatoRecipe) return "対象レシピなし";
    const need2 = tomatoRecipe.required.find((item) => item.id === "tomato");
    const stockItem = stock("cherry-tomato", 300, { unit: "g" });
    return app_.conversionRatio(stockItem, need2);
  })(), null);
}

// ---- 使い切ったものは在庫に数えない --------------------------------------
check("使い切った在庫は不足を埋めない", (() => {
  state.inventory = [stock("eggs", 99, { active: false }), ...others.map((item) => stock(item.id, item.quantity * 10, { unit: item.unit }))];
  return shortageFor(eggRecipe, 1).map((item) => item.id);
})(), ["eggs"]);

check("同じ調理履歴を両端末で直した場合は新しい修正を採る",
  mergeEntity("cooking",
    { id: "h1", recipeName: "料理", editedAt: "2026-01-01T12:00:00.000Z", changes: [{ quantity: 2 }] },
    { id: "h1", recipeName: "料理", editedAt: "2026-01-01T11:00:00.000Z", changes: [{ quantity: 1 }] }
  ).changes[0].quantity,
  2);
check("修正後に取り消した履歴は取り消し時刻を最新操作として採る",
  mergeEntity("cooking",
    {
      id: "h2",
      recipeName: "料理",
      editedAt: "2026-01-01T11:00:00.000Z",
      undoneAt: "2026-01-01T13:00:00.000Z",
      changes: [{ quantity: 2 }]
    },
    { id: "h2", recipeName: "料理", editedAt: "2026-01-01T12:00:00.000Z", changes: [{ quantity: 1 }] }
  ).undoneAt,
  "2026-01-01T13:00:00.000Z");

// ---- 使い切り優先の在庫を先に使う ----------------------------------------
check("使い切り優先の代用を先に選ぶ", (() => {
  const need = { id: "pork", name: "豚こま", quantity: 100, unit: "g" };
  state.inventory = [
    stock("pork-loin", 500),
    stock("pork-belly", 500, { priority: true })
  ];
  return stockForRequirement(need)?.item.id;
})(), "pork-belly");

// ---- 翌日の在庫確認 ------------------------------------------------------
// 昨日以前に作った分だけを聞く。今日の分は聞かない
const dayAfterSetup = (cookedAt, items) => {
  state.settings.dayAfterSkippedOn = "";
  state.inventory = items;
  state.cookingHistory = [{
    id: "h1", recipeId: "r", recipeName: "きのう作った料理", servings: 1,
    cookedAt, undoneAt: null,
    changes: items.map((item) => ({ itemId: item.id, name: item.name, unit: item.unit, quantity: 1 }))
  }];
  return pendingDayAfterItems();
};
const estimated = (id, quantity, extra = {}) =>
  stock(id, quantity, { quantityConfidence: QUANTITY_ESTIMATED, maxQuantity: quantity * 3, ...extra });

check("昨日作った推定の在庫を聞く",
  dayAfterSetup("2025-12-31T19:00:00.000Z", [estimated("eggs", 1)]).items.map((item) => item.id),
  ["eggs"]);
check("今日作った分は聞かない",
  dayAfterSetup("2026-01-01T19:00:00.000Z", [estimated("eggs", 1)]).items.length, 0);
check("確認済みの在庫は聞かない",
  dayAfterSetup("2025-12-31T19:00:00.000Z", [stock("eggs", 1)]).items.length, 0);
check("取り消した調理は聞かない", (() => {
  const result = dayAfterSetup("2025-12-31T19:00:00.000Z", [estimated("eggs", 1)]);
  void result;
  state.cookingHistory[0].undoneAt = "2026-01-01T00:00:00.000Z";
  return pendingDayAfterItems().items.length;
})(), 0);
check("在庫修正の履歴は翌日の調理確認に混ぜない", (() => {
  state.settings.dayAfterSkippedOn = "";
  state.inventory = [estimated("eggs", 1)];
  state.cookingHistory = [{
    id: "adjustment-1", type: "adjustment", occurredAt: "2025-12-31T19:00:00.000Z",
    title: "卵を修正", undoneAt: null,
    changes: [{ itemId: "eggs", name: "卵", before: { quantity: 2 }, after: { quantity: 1 } }]
  }];
  return pendingDayAfterItems().items.length;
})(), 0);
check("「あとで」を押した日は聞かない", (() => {
  dayAfterSetup("2025-12-31T19:00:00.000Z", [estimated("eggs", 1)]);
  state.settings.dayAfterSkippedOn = "2026-01-01";
  return pendingDayAfterItems().items.length;
})(), 0);
check("使い切ったことになっているものを先に聞く", (() => {
  const done = estimated("mushroom", 0, { active: false, maxQuantity: 1 });
  return dayAfterSetup("2025-12-31T19:00:00.000Z", [estimated("eggs", 2), done]).items.map((item) => item.id);
})(), ["mushroom", "eggs"]);
check("一度に聞くのは4品まで", (() => {
  const many = ["eggs", "pork", "tofu", "cabbage", "carrot", "onion"].map((id) => estimated(id, 1));
  return dayAfterSetup("2025-12-31T19:00:00.000Z", many).items.length;
})(), 4);

// 3つの答えを数量へ落とす
check("「ある」は残量の帯が「ある」に入るところまで上げる", (() => {
  const item = estimated("eggs", 1, { maxQuantity: 10 });
  dayAfterCorrection(item, "plenty");
  return [item.quantity, item.quantityConfidence, item.active];
})(), [10 * DAY_AFTER_LEVELS.plenty, QUANTITY_CONFIRMED, true]);
check("「少ない」は少なめの帯に入れる", (() => {
  const item = estimated("eggs", 1, { maxQuantity: 10 });
  dayAfterCorrection(item, "little");
  return item.quantity;
})(), 10 * DAY_AFTER_LEVELS.little);
check("「ある」でも今の量より下げない", (() => {
  const item = estimated("eggs", 9, { maxQuantity: 10 });
  dayAfterCorrection(item, "plenty");
  return item.quantity;
})(), 9);
check("「ない」は使い切りにする", (() => {
  const item = estimated("eggs", 3, { maxQuantity: 10 });
  dayAfterCorrection(item, "none");
  return [item.quantity, item.active, item.quantityConfidence];
})(), [0, false, QUANTITY_CONFIRMED]);
check("使い切ったものを「ある」で戻せる", (() => {
  const item = estimated("mushroom", 0, { active: false, consumedAt: "2025-12-31", maxQuantity: 1 });
  dayAfterCorrection(item, "plenty");
  return [item.quantity, item.active, item.consumedAt ?? null];
})(), [DAY_AFTER_LEVELS.plenty, true, null]);

// ---- 同期の下ごしらえ（1品1行） ------------------------------------------
// 在庫を消す場所がアプリ内に7箇所あるので、印は変更のたびに付けず、
// 保存のたびに前回の内容と比べて出す。その差分の出し方を確かめる。
const syncSetup = (items) => {
  state.syncMeta = {};
  state.shopping = [];
  state.cookingHistory = [];
  state.shelfCounts = {};
  state.inventory = items;
  markSyncChanges();
};
const pendingKeys = () => pendingSyncChanges().map((change) => change.key).sort();
// 見つからないときに落ちると原因が読みにくいので、空のまま比較させる
const changeFor = (key) => pendingSyncChanges().find((change) => change.key === key) || {};

check("新しい在庫は送る印が付く", (() => {
  syncSetup([stock("eggs", 3)]);
  return pendingKeys();
})(), ["item:eggs", "shelves:shelves"]);

check("変更時刻と端末情報を一緒に送る", (() => {
  syncSetup([stock("eggs", 3)]);
  const change = changeFor("item:eggs");
  return [Number.isNaN(Date.parse(change.changedAt)), change.changedBy];
})(), [false, { id: "test-device", name: "テスト端末" }]);

check("変えていなければ送らない", (() => {
  syncSetup([stock("eggs", 3)]);
  pendingSyncChanges().forEach((change) => applySyncResult(change.key, 1));
  markSyncChanges();
  return pendingKeys();
})(), []);

check("数量を変えたら送る印が付く", (() => {
  syncSetup([stock("eggs", 3)]);
  pendingSyncChanges().forEach((change) => applySyncResult(change.key, 1));
  state.inventory[0].quantity = 2;
  markSyncChanges();
  return pendingKeys();
})(), ["item:eggs"]);

check("送るときは自分が見ていた版を申告する", (() => {
  syncSetup([stock("eggs", 3)]);
  pendingSyncChanges().forEach((change) => applySyncResult(change.key, 7));
  state.inventory[0].quantity = 2;
  markSyncChanges();
  return changeFor("item:eggs").baseVersion;
})(), 7);

// ★消えたものを伝えるのが、この仕組みのいちばんの目的
check("消したものは墓石として送る", (() => {
  syncSetup([stock("eggs", 3), stock("tofu", 1)]);
  pendingSyncChanges().forEach((change) => applySyncResult(change.key, 1));
  state.inventory = state.inventory.filter((item) => item.id !== "tofu");
  markSyncChanges();
  const change = changeFor("item:tofu");
  return [change.deleted, change.body, change.baseVersion];
})(), [true, null, 1]);

check("サーバーが知らないまま消えたものは、表から外すだけ", (() => {
  syncSetup([stock("eggs", 3), stock("tofu", 1)]);
  state.inventory = state.inventory.filter((item) => item.id !== "tofu");
  markSyncChanges();
  return Object.keys(state.syncMeta).includes("item:tofu");
})(), false);

check("墓石が通ったら表から外す", (() => {
  syncSetup([stock("eggs", 3)]);
  pendingSyncChanges().forEach((change) => applySyncResult(change.key, 1));
  state.inventory = [];
  markSyncChanges();
  applySyncResult("item:eggs", 2);
  return Object.keys(state.syncMeta).includes("item:eggs");
})(), false);

check("同じidで戻ってきたら墓石を取り消す", (() => {
  syncSetup([stock("eggs", 3)]);
  pendingSyncChanges().forEach((change) => applySyncResult(change.key, 1));
  state.inventory = [];
  markSyncChanges();
  state.inventory = [stock("eggs", 6)];
  markSyncChanges();
  const change = changeFor("item:eggs");
  return [change.deleted, change.body?.quantity, change.baseVersion];
})(), [false, 6, 1]);

check("棚の数も1行として扱う", (() => {
  syncSetup([]);
  state.shelfCounts = { 冷蔵: 3, 冷凍: 1, 常温: 2 };
  markSyncChanges();
  return (pendingSyncChanges().find((change) => change.kind === "shelves") || {}).body;
})(), { id: "shelves", 冷蔵: 3, 冷凍: 1, 常温: 2 });

// ---- 競合の決着 ----------------------------------------------------------
// 迷ったら少ないほう・確かでないほう・無いほうを採る。多く見積もると
// 「材料あり」と出て買い物に行かず、帰ってから足りないと分かるため。
const item = (extra) => ({ id: "eggs", name: "卵", unit: "個", active: true, ...extra });

check("在庫は少ないほうの数量を採る",
  mergeEntity("item", item({ quantity: 6 }), item({ quantity: 2 })).quantity, 2);
check("向きを変えても同じ",
  mergeEntity("item", item({ quantity: 2 }), item({ quantity: 6 })).quantity, 2);
check("片方が使い切っていれば無いものとして扱う", (() => {
  const merged = mergeEntity("item", item({ quantity: 6 }), item({ quantity: 0, active: false }));
  return [merged.active, Boolean(merged.consumedAt)];
})(), [false, true]);
check("確信度は低いほうを採る",
  mergeEntity("item",
    item({ quantity: 3, quantityConfidence: QUANTITY_CONFIRMED }),
    item({ quantity: 3, quantityConfidence: QUANTITY_UNKNOWN })).quantityConfidence,
  QUANTITY_UNKNOWN);
check("満量は大きいほうを残す（残量の目盛りが縮まないように）",
  mergeEntity("item", item({ quantity: 1, maxQuantity: 6 }), item({ quantity: 1, maxQuantity: 2 })).maxQuantity, 6);

check("買い物は消したほうが勝つ", (() => {
  const mine = { id: "s1", name: "牛乳", checked: false };
  const theirs = { id: "s1", name: "牛乳", checked: true };
  return [mergeEntity("shopping", mine, theirs).checked,
          mergeEntity("shopping", theirs, mine).checked];
})(), [true, true]);

check("棚は多いほうを採る（食材の行き場が無くならないように）",
  mergeEntity("shelves", { id: "shelves", 冷蔵: 2, 冷凍: 1, 常温: 3 },
                         { id: "shelves", 冷蔵: 4, 冷凍: 1, 常温: 1 }),
  { id: "shelves", 冷蔵: 4, 冷凍: 1, 常温: 3 });

check("片方しか無ければそれを採る", [
  mergeEntity("item", null, item({ quantity: 1 })).quantity,
  mergeEntity("item", item({ quantity: 5 }), null).quantity
], [1, 5]);

// ---- 料理の完成イラストの割り当て --------------------------------------
//
// ★2026-08-01に77品すべてへ絵が付いた。ここが崩れる壊れ方は静かで、
// レシピを足したり id を打ち間違えたりしても、カードは絵が無いだけで
// 普通に出てしまう（RECIPE_ILLUSTRATIONS に無いレシピは従来表示、という
// 作りにしてあるため）。目で気づけないので数えて止める。
const illustrated = Object.keys(RECIPE_ILLUSTRATIONS);
const recipeIds = RECIPES.map((recipe) => recipe.id);

check("全てのレシピに完成イラストがある",
  recipeIds.filter((id) => !RECIPE_ILLUSTRATIONS[id]), []);
check("レシピに無いidが混ざっていない",
  illustrated.filter((id) => !recipeIds.includes(id)), []);
check("同じマスを2品が使っていない", (() => {
  const seen = new Map();
  const clashes = [];
  for (const [id, [column, row, sheet]] of Object.entries(RECIPE_ILLUSTRATIONS)) {
    const cell = `${sheet}:${row}:${column}`;
    if (seen.has(cell)) clashes.push(`${cell}=${seen.get(cell)}/${id}`);
    seen.set(cell, id);
  }
  return clashes;
})(), []);
check("マスの位置が4列3行に収まっている",
  Object.entries(RECIPE_ILLUSTRATIONS)
    .filter(([, [column, row]]) => !(column >= 0 && column < 4 && row >= 0 && row < 3))
    .map(([id]) => id), []);

console.log(failures
  ? `\n★${failures}件が期待と違います`
  : "レシピ判定チェック: OK");
process.exit(failures ? 1 : 0);
