#!/usr/bin/env node
// app.js のイラスト定義が参照するシート名と、styles.css のアトラス用クラスを照合する。
// 片方だけを追加・削除すると、イラストが出なかったり不要な画像を読み込んだりするため、
// 参照先の不足と、どの id からも使われていない CSS クラスの両方を検出する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

function illustrationEntries(source, constantName) {
  const blockPattern = new RegExp(
    `\\bconst\\s+${constantName}\\s*=\\s*\\{([\\s\\S]*?)^\\s*\\};`,
    "m"
  );
  const block = source.match(blockPattern)?.[1];
  if (block === undefined) {
    throw new Error(`app.js から ${constantName} の定義を取り出せませんでした`);
  }

  const entryPattern = /^\s*(?:"([^"\r\n]+)"|([A-Za-z_$][\w$]*))\s*:\s*\[\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*"([^"\r\n]+)")?\s*\]\s*,?\s*(?:\/\/.*)?$/gm;
  const entries = [...block.matchAll(entryPattern)].map((match) => ({
    id: match[1] || match[2],
    sheet: match[5] || "base"
  }));

  const propertyPattern = /^\s*(?:"[^"\r\n]+"|[A-Za-z_$][\w$]*)\s*:\s*\[/gm;
  const propertyCount = [...block.matchAll(propertyPattern)].length;
  if (!entries.length || entries.length !== propertyCount) {
    throw new Error(`${constantName} のエントリを正しく読み取れませんでした`);
  }
  return entries;
}

function atlasClasses(source, prefix) {
  const names = new Set();
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const classPattern = new RegExp(
    `\\.${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}-([A-Za-z0-9_-]+)(?![A-Za-z0-9_-])`,
    "g"
  );

  for (const rule of source.matchAll(rulePattern)) {
    const [, selectors, body] = rule;
    if (!/\bbackground-image\s*:\s*url\(\s*["']assets\//i.test(body)) continue;
    for (const match of selectors.matchAll(classPattern)) names.add(match[1]);
  }
  return names;
}

function referencesBySheet(entries) {
  const references = new Map();
  for (const { id, sheet } of entries) {
    if (!references.has(sheet)) references.set(sheet, []);
    references.get(sheet).push(id);
  }
  return references;
}

let ingredientReferences;
let recipeReferences;
try {
  ingredientReferences = referencesBySheet(illustrationEntries(app, "INGREDIENT_ILLUSTRATIONS"));
  recipeReferences = referencesBySheet(illustrationEntries(app, "RECIPE_ILLUSTRATIONS"));
} catch (error) {
  console.error(`アトラス参照の整合チェック: ${error.message}`);
  process.exit(1);
}

const ingredientClasses = atlasClasses(styles, "ingredient-illustration");
const recipeClasses = atlasClasses(styles, "recipe-illustration");
const problems = [];

for (const [sheet, ids] of [...ingredientReferences].sort()) {
  if (sheet === "base" || ingredientClasses.has(sheet)) continue;
  problems.push(
    `app.js が参照する食材シート ${sheet} の CSS クラス `
    + `.ingredient-illustration-${sheet} が styles.css に見つかりません（例: id "${ids[0]}"）`
  );
}

for (const [sheet, ids] of [...recipeReferences].sort()) {
  if (sheet === "base" || recipeClasses.has(sheet)) continue;
  problems.push(
    `app.js が参照する料理シート ${sheet} の CSS クラス `
    + `.recipe-illustration-${sheet} が styles.css に見つかりません（例: id "${ids[0]}"）`
  );
}

for (const sheet of [...ingredientClasses].filter((name) => /^(?:s\d{2}|everyday|expanded|recipe)$/.test(name)).sort()) {
  if (ingredientReferences.has(sheet)) continue;
  problems.push(
    `使われていないCSSクラス: .ingredient-illustration-${sheet}`
    + "（INGREDIENT_ILLUSTRATIONS のどの id からも参照されていません）"
  );
}

for (const sheet of [...recipeClasses].filter((name) => /^r\d{2}$/.test(name)).sort()) {
  if (recipeReferences.has(sheet)) continue;
  problems.push(
    `使われていないCSSクラス: .recipe-illustration-${sheet}`
    + "（RECIPE_ILLUSTRATIONS のどの id からも参照されていません）"
  );
}

if (problems.length) {
  console.error(`アトラス参照の整合チェック: ${problems.length}件の不整合があります`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("アトラス参照の整合チェック: OK");
