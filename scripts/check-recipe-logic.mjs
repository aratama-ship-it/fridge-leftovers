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
  "CONFIDENCE_ORDER", "quantityConfidence", "quantityUnknown", "lessCertain",
  "RECIPES", "RECEIPT_RULES", "INGREDIENT_SUBSTITUTES", "UNIT_CONVERSIONS",
  "SUBSTITUTE_GENERICS", "RECIPE_LIST_SERVINGS"
];
const FUNCTIONS = [
  "normalizedSubstitute", "conversionRatio", "stockForRequirement",
  "availableForRequirement", "requiredAmount", "shortageFor", "unconfirmedFor",
  "cookBlockers", "confirmUnknownAmounts", "optionalReady"
];

// stockForRequirement は inventoryMap() と state を使う。テスト側で差し替える。
const harness = `
"use strict";
const todayIso = () => "2026-01-01";
const state = { inventory: [], servings: 1 };
const inventoryMap = () => new Map(state.inventory.filter((item) => item.active !== false).map((item) => [item.id, item]));
${CONSTANTS.map(takeConst).join("\n")}
${FUNCTIONS.map(takeFunction).join("\n")}
return {
  state, RECIPES, RECEIPT_RULES, INGREDIENT_SUBSTITUTES, UNIT_CONVERSIONS,
  QUANTITY_CONFIRMED, QUANTITY_ESTIMATED, QUANTITY_UNKNOWN,
  quantityConfidence, lessCertain, conversionRatio, stockForRequirement,
  availableForRequirement, shortageFor, unconfirmedFor, cookBlockers,
  confirmUnknownAmounts, optionalReady, requiredAmount
};
`;

const app_ = new Function(harness)();
const {
  state, RECIPES, RECEIPT_RULES,
  QUANTITY_CONFIRMED, QUANTITY_ESTIMATED, QUANTITY_UNKNOWN,
  quantityConfidence, lessCertain, stockForRequirement,
  shortageFor, unconfirmedFor, cookBlockers, confirmUnknownAmounts
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

// ---- 使い切り優先の在庫を先に使う ----------------------------------------
check("使い切り優先の代用を先に選ぶ", (() => {
  const need = { id: "pork", name: "豚こま", quantity: 100, unit: "g" };
  state.inventory = [
    stock("pork-loin", 500),
    stock("pork-belly", 500, { priority: true })
  ];
  return stockForRequirement(need)?.item.id;
})(), "pork-belly");

console.log(failures
  ? `\n★${failures}件が期待と違います`
  : "レシピ判定チェック: OK");
process.exit(failures ? 1 : 0);
