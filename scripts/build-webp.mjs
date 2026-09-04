#!/usr/bin/env node
// 食材・料理アトラスの配信用WebPを、手元のPNGから作る。
//
//   node scripts/build-webp.mjs           PNGからWebPを作り直す（cwebp が要る）
//   node scripts/build-webp.mjs --check   PNGとWebPがずれていないか見る（cwebp は不要）
//
// なぜWebPか: 初回にレシピ画面まで開くと 8.1MB を取りに行き、そのうち 7.4MB が
// アトラスのPNGだった。q90 のWebPで1枚 806KB → 134KB（16%）になる。
// アプリが出す大きさは食材72px・料理76〜108pxで、1254×940のシートから
// 大きく縮小して表示するため、q90 の劣化は実寸でも300pxでも見分けられない
// （2026-09-04 に PNG / q90 / q82 を並べて確認した）。
//
// ★PNGは消さない。アトラスの正本はPNGで、背景抜けの検査（check-atlas-alpha）も
//   PNGを見る。WebPはPNGから作る配信用の派生物として扱う。
//
// ★CIでは cwebp が無い前提なので、--check は「WebPがあるか」と
//   「作ったときのPNGから中身が変わっていないか」だけを見る。
//   PNGを差し替えてWebPを作り直し忘れると、ここで落ちる。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = resolve(ROOT, "assets");
const MANIFEST = resolve(ASSETS, "webp-manifest.json");
const QUALITY = 90;
const ALPHA_QUALITY = 100;

// 配信で使う画像だけを対象にする。アイコンとfaviconはPNGのまま
// （manifest.json とホーム画面が PNG を前提にしている）。
const TARGET = /^(ingredient-atlas|recipe-atlas|food-child-drop-target).*\.png$/;

const sources = readdirSync(ASSETS).filter((name) => TARGET.test(name)).sort();
if (!sources.length) {
  console.error("WebPの対象になるPNGが assets/ に見つかりません");
  process.exit(1);
}

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  if (!existsSync(MANIFEST)) {
    console.error("WebPチェック: assets/webp-manifest.json がありません（node scripts/build-webp.mjs を実行してください）");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const problems = [];

  for (const name of sources) {
    const webpName = name.replace(/\.png$/, ".webp");
    if (!existsSync(resolve(ASSETS, webpName))) {
      problems.push(`${webpName} がありません`);
      continue;
    }
    const recorded = manifest.sources?.[name];
    if (!recorded) {
      problems.push(`${name} が webp-manifest.json に記録されていません`);
      continue;
    }
    const current = sha(readFileSync(resolve(ASSETS, name)));
    if (current !== recorded) {
      problems.push(`${name} が変わっているのに ${webpName} を作り直していません`);
    }
  }
  for (const name of Object.keys(manifest.sources || {})) {
    if (!sources.includes(name)) problems.push(`webp-manifest.json に無いPNGの記録が残っています: ${name}`);
  }
  if (manifest.quality !== QUALITY) {
    problems.push(`記録された品質が ${manifest.quality}（このスクリプトは ${QUALITY}）`);
  }

  if (problems.length) {
    console.error(`WebPチェック: ${problems.length}件の不整合があります`);
    for (const p of problems) console.error(`- ${p}`);
    console.error("\n直し方: node scripts/build-webp.mjs を実行して、生成物を一緒にコミットする。");
    process.exit(1);
  }
  console.log(`WebPチェック: OK（${sources.length}枚がPNGと一致）`);
  process.exit(0);
}

try {
  execFileSync("cwebp", ["-version"], { stdio: "ignore" });
} catch {
  console.error("cwebp が見つかりません。macOSなら `brew install webp` で入ります。");
  process.exit(1);
}

const manifest = { quality: QUALITY, alphaQuality: ALPHA_QUALITY, sources: {} };
let pngTotal = 0;
let webpTotal = 0;

for (const name of sources) {
  const from = resolve(ASSETS, name);
  const to = resolve(ASSETS, name.replace(/\.png$/, ".webp"));
  execFileSync("cwebp", ["-quiet", "-q", String(QUALITY), "-alpha_q", String(ALPHA_QUALITY), from, "-o", to]);
  const png = readFileSync(from);
  const webp = readFileSync(to);
  manifest.sources[name] = sha(png);
  pngTotal += png.length;
  webpTotal += webp.length;
  console.log(`${name.padEnd(34)} ${String(Math.round(png.length / 1024)).padStart(5)}KB → ${String(Math.round(webp.length / 1024)).padStart(4)}KB`);
}

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n${sources.length}枚 ${Math.round(pngTotal / 1024)}KB → ${Math.round(webpTotal / 1024)}KB（${Math.round((webpTotal / pngTotal) * 100)}%）`);
console.log("styles.css・app.js の参照を .webp にしたあと、node scripts/cache-version.mjs を実行してください。");
