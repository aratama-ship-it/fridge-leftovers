#!/usr/bin/env node
// 文字の大きさが design/TOKEN_SHEET.md のスケールから外れていないか確かめる。
//
//   node scripts/check-type-scale.mjs
//
// レビュー前は font-size が51種類・211箇所に散っていて、在庫画面で見えている
// 文字要素の半分が12px未満だった。スケールへ寄せたあと、次に誰かが
// 「ここだけ 0.62rem」と足すと元へ戻る。それを機械で止める。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const sheet = fs.readFileSync(path.join(ROOT, "design", "TOKEN_SHEET.md"), "utf8");
const problems = [];

// シートに書いてあるトークンと値（§2・§3の表から読む）
const EXPECTED = {
  "--fs-micro": "0.6875rem", "--fs-caption": "0.75rem", "--fs-sub": "0.875rem",
  "--fs-body": "1rem", "--fs-lead": "1.125rem", "--fs-title": "1.375rem", "--fs-display": "1.625rem",
  "--icon-sm": "18px", "--icon-md": "22px", "--icon-lg": "26px", "--icon-xl": "32px"
};

// 1. :root の定義がシートと一致するか
for (const [name, value] of Object.entries(EXPECTED)) {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) problems.push(`:root に ${name} がありません`);
  else if (m[1].trim() !== value) problems.push(`${name} が ${m[1].trim()}（シートは ${value}）`);
  if (!sheet.includes(`\`${name}\``)) problems.push(`design/TOKEN_SHEET.md に ${name} の記載がありません`);
}

// 2. 生の数値が残っていないか（これが本体）
const lines = css.split("\n");
let sel = [], depth = 0;
const microUsers = [];
const formOffenders = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t.endsWith("{")) { depth++; sel.push(t.slice(0, -1).trim()); continue; }
  if (t === "}") { depth = Math.max(0, depth - 1); sel.pop(); continue; }
  if (!/^font-size:/.test(t)) continue;
  const leaf = sel[sel.length - 1] || "(不明)";
  const m = t.match(/^font-size:\s*var\((--(?:fs|icon)-[a-z]+)\)/);
  if (!m) { problems.push(`L${i + 1} ${leaf} — 生の値です: ${t}`); continue; }
  if (m[1] === "--fs-micro") microUsers.push(leaf);
  // フォーム部品は16px未満にしない（iOSがフォーカスでページを拡大する）
  if (/\b(input|select|textarea)\b/.test(leaf) && m[1] !== "--fs-body") {
    formOffenders.push(`${leaf} → ${m[1]}`);
  }
}
for (const o of formOffenders) {
  problems.push(`フォーム部品が --fs-body 未満です（iOSが拡大します）: ${o}`);
}

// 3. --fs-micro はシート §2「下限の例外」に挙げた場所だけ
const ALLOWED_MICRO = [
  ".app-version", ".nav-icon-with-count small", ".food-expiry-badge", ".food-child-bubble",
  ".shopping-food-button.is-added::after", ".priority-food-option.is-selected::after",
  ".shopping-food-button strong", ".shopping-food-button small"
];
for (const leaf of new Set(microUsers)) {
  if (!ALLOWED_MICRO.includes(leaf)) {
    problems.push(`--fs-micro（11px）を例外表に無い場所で使っています: ${leaf}`);
  }
}
for (const allowed of ALLOWED_MICRO) {
  if (!sheet.includes(allowed)) problems.push(`シートの例外表に ${allowed} の記載がありません`);
}

if (problems.length) {
  console.error(`文字スケールチェック: ${problems.length}件の不整合があります`);
  for (const p of problems) console.error(`- ${p}`);
  console.error("\n直し方: design/TOKEN_SHEET.md を先に直してから styles.css を合わせる。");
  process.exit(1);
}

const used = [...css.matchAll(/var\((--(?:fs|icon)-[a-z]+)\)/g)].map((m) => m[1]);
const counts = {};
for (const u of used) counts[u] = (counts[u] || 0) + 1;
console.log(`文字スケールチェック: OK（${used.length}箇所が ${Object.keys(counts).length} 種類のトークンを使用）`);
