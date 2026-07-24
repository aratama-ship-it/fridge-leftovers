import fs from "node:fs";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function readConstant(name, nextName) {
  const declaration = source.indexOf(`const ${name} =`);
  const nextDeclaration = source.indexOf(`\n\nconst ${nextName}`, declaration);
  if (declaration < 0 || nextDeclaration < 0) {
    throw new Error(`${name} の定義を読み取れませんでした`);
  }
  const expressionStart = source.indexOf("=", declaration) + 1;
  const expression = source.slice(expressionStart, nextDeclaration).trim().replace(/;$/, "");
  return Function(`"use strict"; return (${expression});`)();
}

const recipes = readConstant("RECIPES", "RECIPE_STEPS");
const receiptRules = readConstant("RECEIPT_RULES", "ILLUSTRATED_INGREDIENT_CATEGORIES");
const allowedUnits = new Set(["個", "g", "ml", "本", "株", "袋", "パック", "膳", "切れ", "缶", "枚"]);
const expectedInitialUnits = new Map([
  ["cabbage", "g"],
  ["carrot", "本"],
  ["cucumber", "本"],
  ["radish", "本"],
  ["green-onion", "本"],
  ["eggplant", "本"],
  ["spinach", "袋"],
  ["bell-pepper", "袋"],
  ["milk", "本"],
  ["banana", "袋"]
]);

const errors = [];
const rulesById = new Map();

receiptRules.forEach((rule) => {
  if (rulesById.has(rule.id)) errors.push(`初期食材IDが重複しています: ${rule.id}`);
  rulesById.set(rule.id, rule);
  if (!allowedUnits.has(rule.unit)) errors.push(`${rule.name} の単位「${rule.unit}」は選択肢にありません`);
  if (!Number.isFinite(rule.quantity) || rule.quantity <= 0) {
    errors.push(`${rule.name} の初期数量が不正です: ${rule.quantity}`);
  }
});

expectedInitialUnits.forEach((expectedUnit, id) => {
  const rule = rulesById.get(id);
  if (!rule) {
    errors.push(`確認対象の初期食材がありません: ${id}`);
  } else if (rule.unit !== expectedUnit) {
    errors.push(`${rule.name} の初期単位は「${expectedUnit}」にしてください（現在: ${rule.unit}）`);
  }
});

recipes.forEach((recipe) => {
  [...recipe.required, ...recipe.optional].forEach((ingredient) => {
    const rule = rulesById.get(ingredient.id);
    if (rule && ingredient.unit !== rule.unit) {
      errors.push(
        `${recipe.name}: ${ingredient.name} のレシピ単位「${ingredient.unit}」が初期単位「${rule.unit}」と一致しません`
      );
    }
  });
});

if (errors.length) {
  console.error(`初期単位チェック: ${errors.length}件の修正が必要です`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`初期単位チェック: OK（${receiptRules.length}食材・${recipes.length}レシピ）`);
  console.log("なすの初期単位: 1本");
}
