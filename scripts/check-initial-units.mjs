import fs from "node:fs";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function readConstant(name, nextName) {
  const declaration = source.indexOf(`const ${name} =`);
  // 次の定数の直前までを取り出す。定数の手前に説明コメントがあると
  // 空行2つでは当たらないので、行頭の const を目印にする。
  const nextDeclaration = source.indexOf(`\nconst ${nextName}`, declaration);
  if (declaration < 0 || nextDeclaration < 0) {
    throw new Error(`${name} の定義を読み取れませんでした`);
  }
  const expressionStart = source.indexOf("=", declaration) + 1;
  const segment = source.slice(expressionStart, nextDeclaration);
  // 定義を閉じる最後の「;」で切る。次の定数へ付いた説明コメントを一緒に
  // 拾わないようにするため。括弧の閉じ方（];・};・]);）に依存しない。
  const end = segment.lastIndexOf(";");
  if (end < 0) throw new Error(`${name} の終わりを見つけられませんでした`);
  return Function(`"use strict"; return (${segment.slice(0, end)});`)();
}

const recipes = readConstant("RECIPES", "RECIPE_STEPS");
const recipeSteps = readConstant("RECIPE_STEPS", "NUTRITION_REFERENCES");
const seasonalIngredients = readConstant("SEASONAL_INGREDIENTS", "SEASONAL_RECIPE_MONTHS");
const seasonalRecipeMonths = readConstant("SEASONAL_RECIPE_MONTHS", "RECIPES");
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

// ごはんはレシート認識の対象外だが、レシピが使う食材として存在する
// （app.js の illustratedIngredientItem も同じ特別扱いをしている）
if (!rulesById.has("rice")) {
  rulesById.set("rice", { id: "rice", name: "ごはん", quantity: 1, unit: "膳", location: "冷凍" });
}

expectedInitialUnits.forEach((expectedUnit, id) => {
  const rule = rulesById.get(id);
  if (!rule) {
    errors.push(`確認対象の初期食材がありません: ${id}`);
  } else if (rule.unit !== expectedUnit) {
    errors.push(`${rule.name} の初期単位は「${expectedUnit}」にしてください（現在: ${rule.unit}）`);
  }
});

const recipeIds = new Set();
recipes.forEach((recipe) => {
  if (recipeIds.has(recipe.id)) errors.push(`レシピIDが重複しています: ${recipe.id}`);
  recipeIds.add(recipe.id);
  if (!Array.isArray(recipeSteps[recipe.id]) || recipeSteps[recipe.id].length !== 3) {
    errors.push(`${recipe.name}: 3手順が登録されていません`);
  }
  [...recipe.required, ...recipe.optional].forEach((ingredient) => {
    const rule = rulesById.get(ingredient.id);
    if (rule && ingredient.unit !== rule.unit) {
      errors.push(
        `${recipe.name}: ${ingredient.name} のレシピ単位「${ingredient.unit}」が初期単位「${rule.unit}」と一致しません`
      );
    }
  });
});

Object.entries(seasonalRecipeMonths).forEach(([id, months]) => {
  if (!recipeIds.has(id)) errors.push(`季節料理のレシピ「${id}」が登録されていません`);
  if (!Array.isArray(months) || months.some((month) => !Number.isInteger(month) || month < 1 || month > 12)) {
    errors.push(`季節料理「${id}」の月指定が不正です`);
  }
});

Object.entries(seasonalIngredients).forEach(([month, ids]) => {
  if (!Number.isInteger(Number(month)) || Number(month) < 1 || Number(month) > 12) {
    errors.push(`旬の食材の月「${month}」が不正です`);
  }
  ids.forEach((id) => {
    if (!rulesById.has(id)) errors.push(`${month}月の旬食材「${id}」が食材カタログにありません`);
  });
});

// 代替関係の検証。単位が違うものを代用に入れると、照合されず黙って無視される。
const substitutes = readConstant("INGREDIENT_SUBSTITUTES", "UNIT_CONVERSIONS");
const conversions = readConstant("UNIT_CONVERSIONS", "SUBSTITUTE_GENERICS");
const pendingSubstitutes = [];

// 単位換算の検証。標準と同じ単位を書いても意味がなく、
// 選べない単位や不正な倍率は黙って無視されるだけになる。
Object.entries(conversions).forEach(([id, table]) => {
  const rule = rulesById.get(id);
  if (!rule) {
    errors.push(`単位換算の食材「${id}」が登録されていません`);
    return;
  }
  Object.entries(table).forEach(([unit, ratio]) => {
    if (unit === rule.unit) {
      errors.push(`単位換算: ${rule.name} の「${unit}」は標準の単位と同じです`);
    }
    if (!allowedUnits.has(unit)) {
      errors.push(`単位換算: ${rule.name} の「${unit}」は在庫の単位の選択肢にありません`);
    }
    if (!Number.isFinite(ratio) || ratio <= 0) {
      errors.push(`単位換算: ${rule.name} の「${unit}」の倍率が不正です（${ratio}）`);
    }
  });
});

Object.entries(substitutes).forEach(([genericId, list]) => {
  const generic = rulesById.get(genericId);
  if (!generic) {
    errors.push(`代替関係の総称「${genericId}」が食材として登録されていません`);
    return;
  }
  list.forEach((entry) => {
    const substituteId = typeof entry === "string" ? entry : entry.id;
    const ratio = typeof entry === "string" ? null : entry.ratio;
    if (ratio !== null && (!Number.isFinite(ratio) || ratio <= 0)) {
      errors.push(`代替関係: ${generic.name} ← ${substituteId} の倍率が不正です（${ratio}）`);
    }
    if (substituteId === genericId) {
      errors.push(`代替関係: ${generic.name} が自分自身を代用に含んでいます`);
      return;
    }
    if (substitutes[substituteId]) {
      errors.push(`代替関係: ${substituteId} は総称でもあります（連鎖は扱えません）`);
      return;
    }
    const rule = rulesById.get(substituteId);
    if (!rule) {
      pendingSubstitutes.push(`${generic.name} ← ${substituteId}`);
      return;
    }
    if (rule.unit !== generic.unit && ratio === null) {
      errors.push(
        `代替関係: ${rule.name}「${rule.unit}」は ${generic.name}「${generic.unit}」と単位が違います。ratio を書いてください`
      );
    }
    if (rule.unit === generic.unit && ratio !== null && ratio !== 1) {
      errors.push(
        `代替関係: ${rule.name} は ${generic.name} と単位が同じなのに倍率 ${ratio} が指定されています`
      );
    }
  });
});

if (errors.length) {
  console.error(`初期単位チェック: ${errors.length}件の修正が必要です`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  const activeSubstitutes = Object.values(substitutes)
    .flat()
    .map((entry) => (typeof entry === "string" ? entry : entry.id))
    .filter((id) => rulesById.has(id)).length;
  console.log(`初期単位チェック: OK（${receiptRules.length}食材・${recipes.length}レシピ）`);
  console.log("なすの初期単位: 1本");
  console.log(`代替関係: ${Object.keys(substitutes).length}総称・${activeSubstitutes}件が有効`);
  const conversionCount = Object.values(conversions).reduce((n, t) => n + Object.keys(t).length, 0);
  console.log(`単位換算: ${Object.keys(conversions).length}食材・${conversionCount}通り`);
  if (pendingSubstitutes.length) {
    console.log(`代替関係: ${pendingSubstitutes.length}件は食材の追加待ち（${pendingSubstitutes.join("、")}）`);
  }
}
