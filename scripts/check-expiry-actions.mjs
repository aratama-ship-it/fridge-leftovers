#!/usr/bin/env node
// 「そろそろ使いたい」の2つの一覧で、廃棄ボタンと処理がつながっているか確かめる。
// 行全体を button に戻してボタンが入れ子になる事故や、片方だけ配線が外れる事故も検出する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const problems = [];

function section(source, start, end, label) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  if (startAt === -1 || endAt === -1) {
    problems.push(`${label} の本文を取り出せませんでした`);
    return "";
  }
  return source.slice(startAt, endAt);
}

function requireText(source, text, problem) {
  if (!source.includes(text)) problems.push(problem);
}

const expiryRender = section(
  app,
  "function renderExpiryAlerts() {",
  "function inventoryLevel(item) {",
  "renderExpiryAlerts()"
);
const managementRender = section(
  app,
  "function renderExpiringList() {",
  "function inventoryMap() {",
  "renderExpiringList()"
);
const expiryListener = section(
  app,
  'elements.expiryAlertList.addEventListener("click", (event) => {',
  "// 量が足りないと分かったときの逃げ道",
  "elements.expiryAlertList の click リスナー"
);
const managementListener = section(
  app,
  'elements.managementExpiringList.addEventListener("click", (event) => {',
  'elements.finishedList.addEventListener("click", (event) => {',
  "elements.managementExpiringList の click リスナー"
);

requireText(
  expiryRender,
  "data-expiry-discard",
  "renderExpiryAlerts() に data-expiry-discard がありません"
);
requireText(
  managementRender,
  "data-expiry-discard",
  "renderExpiringList() に data-expiry-discard がありません"
);

for (const [label, listener] of [
  ["elements.expiryAlertList", expiryListener],
  ["elements.managementExpiringList", managementListener]
]) {
  requireText(listener, "data-expiry-discard", `${label} の click リスナーに data-expiry-discard がありません`);
  requireText(listener, "discardItem(", `${label} の click リスナーに discardItem( がありません`);
}

// 行のクラスには is-soon などの状態クラスが続くので、閉じ引用符まで含めて
// 探すと当たらない（実際に、閉じ引用符付きで書いたら button へ戻しても
// 素通りした）。クラス名の直後は引用符とは限らないため、そこまでで見る。
if (app.includes('<button class="expiry-alert-item')) {
  problems.push("expiry-alert-item が button のままです（ボタンが入れ子になります）");
}
if (app.includes('<button class="management-expiring-item')) {
  problems.push("management-expiring-item が button のままです（ボタンが入れ子になります）");
}

for (const className of [
  "expiry-alert-main",
  "expiry-alert-discard",
  "management-expiring-main",
  "management-expiring-discard"
]) {
  const definition = new RegExp(`\\.${className}\\s*\\{`);
  if (!definition.test(styles)) problems.push(`styles.css に .${className} の定義がありません`);
}

requireText(
  expiryRender,
  'data-expiry-discard="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を捨てる"',
  "renderExpiryAlerts() の「捨てる」ボタンに aria-label がありません"
);
requireText(
  managementRender,
  'data-expiry-discard="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を捨てる"',
  "renderExpiringList() の「捨てる」ボタンに aria-label がありません"
);

if (problems.length) {
  console.error(`使いきりの操作チェック: ${problems.length}件の不整合があります`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("使いきりの操作チェック: OK");
