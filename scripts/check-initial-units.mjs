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

// 代替関係の検証。単位が違うものを代用に入れると、照合されず黙って無視される。
const substitutes = readConstant("INGREDIENT_SUBSTITUTES", "SUBSTITUTE_GENERICS");
const pendingSubstitutes = [];

Object.entries(substitutes).forEach(([genericId, list]) => {
  const generic = rulesById.get(genericId);
  if (!generic) {
    errors.push(`代替関係の総称「${genericId}」が食材として登録されていません`);
    return;
  }
  list.forEach((substituteId) => {
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
    if (rule.unit !== generic.unit) {
      errors.push(
        `代替関係: ${rule.name}「${rule.unit}」は ${generic.name}「${generic.unit}」と単位が違うため代用になりません`
      );
    }
  });
});

if (errors.length) {
  console.error(`初期単位チェック: ${errors.length}件の修正が必要です`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  const activeSubstitutes = Object.values(substitutes).flat().filter((id) => rulesById.has(id)).length;
  console.log(`初期単位チェック: OK（${receiptRules.length}食材・${recipes.length}レシピ）`);
  console.log("なすの初期単位: 1本");
  console.log(`代替関係: ${Object.keys(substitutes).length}総称・${activeSubstitutes}件が有効`);
  if (pendingSubstitutes.length) {
    console.log(`代替関係: ${pendingSubstitutes.length}件は食材の追加待ち（${pendingSubstitutes.join("、")}）`);
  }
}
