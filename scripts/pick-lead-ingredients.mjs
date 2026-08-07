#!/usr/bin/env node
// 初回オンボーディングで「今夜使えそうな主役」として見せる食材を、
// レシピの実データから選ぶ。
//
//   node scripts/pick-lead-ingredients.mjs           候補を数えて一覧にする
//   node scripts/pick-lead-ingredients.mjs --check    app.js の LEAD_INGREDIENTS を検査する
//
// 方針書では主役を1〜2品選ばせ、そこから候補を3件出す。**選んだのに候補が
// 3件出ない食材を並べると、そこが行き止まりになる。** どれが何件の
// レシピにつながるかを数えて、行き止まりを避けられる並びを作る。
//
// 数えるのは「最低限必要」に入っている場合だけ。「あるとより良い」は
// 無くても作れるので、主役として選ぶ理由にならない。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "app.js"), "utf8");

function takeConst(name) {
  const start = app.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`定数 ${name} が見つかりません`);
  const ends = [app.indexOf("\nconst ", start + 1), app.indexOf("\nfunction ", start + 1)]
    .filter((at) => at > 0);
  const segment = app.slice(start, ends.length ? Math.min(...ends) : app.length);
  return segment.slice(0, segment.lastIndexOf(";") + 1);
}

const { RECIPES, RECEIPT_RULES, INGREDIENT_SUBSTITUTES, LEAD_INGREDIENTS, INGREDIENT_ILLUSTRATIONS } =
  new Function(
    `"use strict";
    ${takeConst("RECIPES")}
    ${takeConst("RECEIPT_RULES")}
    ${takeConst("INGREDIENT_SUBSTITUTES")}
    ${takeConst("LEAD_INGREDIENTS")}
    ${takeConst("INGREDIENT_ILLUSTRATIONS")}
    return { RECIPES, RECEIPT_RULES, INGREDIENT_SUBSTITUTES, LEAD_INGREDIENTS, INGREDIENT_ILLUSTRATIONS };`
  )();

const nameFor = (id) => RECEIPT_RULES.find((rule) => rule.id === id)?.name || id;

// 主役になりうるのは、その一食の中心になる食材。方針書の
// 「肉・魚・卵・豆腐・麺・ごはんなど」に沿って候補を絞る。
// 野菜だけを主役に選ばせると、何を作るのかが決まらない。
const LEAD_POOL = {
  肉: ["pork", "pork-belly", "pork-loin", "pork-shoulder", "ground-meat", "pork-mince",
    "chicken", "chicken-thigh", "chicken-tender", "chicken-wing", "chicken-mince",
    "beef", "beef-steak", "bacon", "ham", "sausage"],
  魚介: ["salmon", "mackerel", "yellowtail", "cod", "saury", "horse-mackerel", "sardine",
    "tuna-sashimi", "bonito-fresh", "shrimp", "squid", "octopus", "clam", "scallop",
    "tuna", "canned-mackerel", "chikuwa", "kamaboko", "hanpen", "satsumaage"],
  "卵・豆腐": ["eggs", "tofu", "grilled-tofu", "atsuage", "natto", "abura-age"],
  "主食・麺": ["rice", "rice-raw", "bread", "udon", "yakisoba-noodles", "pasta", "somen",
    "chinese-noodles", "soba", "mochi", "french-bread", "butter-roll"]
};

// 代用が効く食材は、総称のレシピにもつながる（豚バラを持っていれば
// 豚こまのレシピも作れる）。主役の広がりを数えるときはこれも足す。
const genericOf = new Map();
for (const [generic, list] of Object.entries(INGREDIENT_SUBSTITUTES)) {
  for (const entry of list) {
    genericOf.set(typeof entry === "string" ? entry : entry.id, generic);
  }
}

function recipesFor(id) {
  const generic = genericOf.get(id);
  return RECIPES.filter((recipe) =>
    recipe.required.some((item) => item.id === id || (generic && item.id === generic))
  );
}

// --check：app.js に置いた主役リストが今のレシピと食い違っていないか調べる。
// レシピを入れ替えたときに、選んでも候補が出ない主役が残るのを防ぐ。
if (process.argv.includes("--check")) {
  const ids = LEAD_INGREDIENTS.flatMap((group) => group.ids);
  const duplicates = ids.filter((id, at) => ids.indexOf(id) !== at);
  const problems = [];
  if (duplicates.length) problems.push(`重複した主役: ${duplicates.join("、")}`);

  const thin = [];
  for (const id of ids) {
    // ごはんは購入品ではないためレシート規則を持たない（app.js 側で個別対応）
    const known = id === "rice" || RECEIPT_RULES.some((rule) => rule.id === id);
    if (!known) problems.push(`カタログに無い主役: ${id}`);
    if (!INGREDIENT_ILLUSTRATIONS[id]) problems.push(`イラストが無い主役: ${id}`);
    const count = recipesFor(id).length;
    if (count === 0) problems.push(`レシピにつながらない主役: ${nameFor(id)}（${id}）`);
    else if (count < 3) thin.push(`${nameFor(id)}${count}件`);
  }

  if (problems.length) {
    console.error("主役リストに問題があります:");
    for (const problem of problems) console.error(`  ★${problem}`);
    console.error("\nscripts/pick-lead-ingredients.mjs を実行して選び直してください。");
    process.exit(1);
  }
  console.log(`主役リスト: OK（${ids.length}品）`);
  console.log(thin.length
    ? `  候補が3件に届かない主役: ${thin.length}件 — ${thin.join("、")}`
    : "  すべての主役から3件以上のレシピへ直接つながります");
  process.exit(0);
}

const rows = [];
for (const [group, ids] of Object.entries(LEAD_POOL)) {
  for (const id of ids) {
    const hits = recipesFor(id);
    rows.push({ group, id, name: nameFor(id), count: hits.length });
  }
}

rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

console.log("＝＝ 主役候補（最低限必要に入るレシピ数。代用の広がりを含む）＝＝\n");
let group = "";
for (const row of [...rows].sort((a, b) => a.group.localeCompare(b.group) || b.count - a.count)) {
  if (row.group !== group) {
    group = row.group;
    console.log(`【${group}】`);
  }
  const mark = row.count >= 3 ? "  " : (row.count ? "△ " : "× ");
  console.log(`  ${mark}${row.name.padEnd(10, "　")} ${String(row.count).padStart(2)}件  ${row.id}`);
}

const ready = rows.filter((row) => row.count >= 3);
const thin = rows.filter((row) => row.count > 0 && row.count < 3);
const none = rows.filter((row) => row.count === 0);

console.log(`\n候補が3件以上そろう食材：${ready.length}件`);
console.log(`3件に届かない（フォールバックが必要）：${thin.length}件 — ${thin.map((row) => `${row.name}${row.count}`).join("、")}`);
console.log(`レシピにつながらない（主役に出さない）：${none.length}件 — ${none.map((row) => row.name).join("、")}`);

// 2品目を選んだときに両方必須にすると行き止まりが生まれる。
// 方針書の判断（ANDではなく加点）の根拠を、いまのデータで数え直す。
console.log("\n＝＝ 2品を両方必須にした場合の候補数（上位同士の組み合わせ）＝＝\n");
const top = ready.slice(0, 8);
for (let a = 0; a < top.length; a += 1) {
  for (let b = a + 1; b < top.length; b += 1) {
    const both = RECIPES.filter((recipe) => {
      const has = (id) => {
        const generic = genericOf.get(id);
        return recipe.required.some((item) => item.id === id || (generic && item.id === generic));
      };
      return has(top[a].id) && has(top[b].id);
    });
    const mark = both.length === 0 ? "★行き止まり" : (both.length < 3 ? "△" : "");
    console.log(`  ${top[a].name} ＋ ${top[b].name}：${both.length}件 ${mark}`);
  }
}

console.log(`\n参考：レシピ全${RECIPES.length}件`);
