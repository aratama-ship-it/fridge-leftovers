#!/usr/bin/env node
// 出来上がったアトラスのマスごとに、背景がちゃんと抜けているかを数える。
//
// シート16・17で、緑背景のまま保存された素材が4つ混ざっていた
// （鶏レバー・生ハム・ラム肉・ししゃも）。build-atlas.mjs は渡された画像を
// そのまま置くだけなので、緑の四角がアトラスへ入り、表示すると被写体の
// 周りが緑色の板になる。目で見れば分かるが、12マス×27枚を毎回見るのは
// もたないので数えて出す。
//
//   node scripts/check-atlas-alpha.mjs 18 19 20
//   node scripts/check-atlas-alpha.mjs all
//
// 判定：
//   ・不透明率が高すぎる（マスの大半が埋まっている）＝抜けていない
//   ・緑らしさ g - max(r,b) > 60 のピクセルが多い＝緑背景が残っている
//   ・外接矩形が隙間なく埋まっている＝背景の矩形がそのまま入っている
//     （★シート23の野沢菜がマゼンタ背景のまま入っていたのを、緑しか見て
//       いなかったせいで取り逃がした。色に依らない判定として足した）
//
// バジル・絹さや・小ねぎ・ライム・ピーマンのように被写体そのものが緑の
// ものは緑ピクセルが多く出る。緑が多いマスは「要確認」として出すだけで、
// 失敗と断定はしない。不透明率と併せて見る。

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLUMNS = 4;
const ROWS = 3;

// PNG の読み込みは build-atlas.mjs のものを借りる
const source = fs.readFileSync(path.join(ROOT, "scripts/build-atlas.mjs"), "utf8");
const grab = (name) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`${name} を取り出せませんでした`);
  return source.slice(start, end + 3);
};
const crcTableSource = source.slice(
  source.indexOf("const crcTable ="),
  source.indexOf(";", source.indexOf("});", source.indexOf("const crcTable ="))) + 1
);
const { decodePng } = new Function(
  "fs", "zlib", "Buffer", "PNG_SIGNATURE",
  crcTableSource + "\n"
  + ["paethPredictor", "decodePng", "crc32", "pngChunk", "encodePng"].map(grab).join("\n")
  + "; return { decodePng };"
)(fs, zlib, Buffer, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

// app.js のイラスト定義から、どのシートのどのマスに何が入っているかを読む
function illustrationMap() {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const start = app.indexOf("const INGREDIENT_ILLUSTRATIONS =");
  const end = app.indexOf("\nconst RECEIPT_RULES", start);
  const segment = app.slice(app.indexOf("=", start) + 1, end);
  const table = Function(`"use strict"; return (${segment.slice(0, segment.lastIndexOf(";"))});`)();
  const byAtlas = new Map();
  for (const [id, value] of Object.entries(table)) {
    const [column, row, atlas = "base"] = value;
    if (!byAtlas.has(atlas)) byAtlas.set(atlas, new Map());
    byAtlas.get(atlas).set(row * COLUMNS + column, id);
  }
  return byAtlas;
}

// 被写体が占める幅の目安は68%。面積では半分に届かないので、
// 不透明率が6割を超えたら背景が残っていると見る。
const OPAQUE_LIMIT = 0.6;
const GREEN_LIMIT = 0.05;
// 外接矩形の充填率。ここまで埋まるのは矩形そのものだけ（実測の最大は器の97.7%）
const FILL_LIMIT = 0.995;

function inspectCell(image, index) {
  const cellWidth = image.width / COLUMNS;
  const cellHeight = image.height / ROWS;
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const left = Math.round(column * cellWidth);
  const top = Math.round(row * cellHeight);
  const right = Math.min(image.width, Math.round((column + 1) * cellWidth));
  const bottom = Math.min(image.height, Math.round((row + 1) * cellHeight));
  let opaque = 0;
  let green = 0;
  let total = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      total += 1;
      if (image.pixels[offset + 3] < 32) continue;
      opaque += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const g = image.pixels[offset + 1];
      const rest = Math.max(image.pixels[offset], image.pixels[offset + 2]);
      if (g - rest > 60) green += 1;
    }
  }
  // 被写体の外接矩形が隙間なく埋まっていたら、それは絵ではなく背景の矩形。
  // 実測では、正面から見た四角い器でも97.7%までしか埋まらない（縁がぼけるため）。
  // 抜き忘れた背景はちょうど100%になる。
  const boxArea = maxX < 0 ? 0 : (maxX - minX + 1) * (maxY - minY + 1);
  const fill = boxArea ? opaque / boxArea : 0;
  return { opaque: opaque / total, green: green / total, fill };
}

const requested = process.argv.slice(2);
if (!requested.length) {
  console.error("使い方: node scripts/check-atlas-alpha.mjs <シート番号...> | all");
  process.exit(1);
}

const names = illustrationMap();
const sheets = requested.includes("all")
  ? fs.readdirSync(path.join(ROOT, "assets"))
    .filter((file) => /^ingredient-atlas-\d\d\.png$/.test(file))
    .map((file) => file.slice(-6, -4))
    .sort()
  : requested.map((value) => String(value).padStart(2, "0"));

let failures = 0;
let warnings = 0;

for (const sheet of sheets) {
  const file = `assets/ingredient-atlas-${sheet}.png`;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.log(`${file}: ありません`);
    failures += 1;
    continue;
  }
  const image = decodePng(full);
  const ids = names.get(`s${sheet}`) || new Map();
  const lines = [];
  let sheetFailures = 0;
  for (let index = 0; index < COLUMNS * ROWS; index += 1) {
    const { opaque, green, fill } = inspectCell(image, index);
    const id = ids.get(index) || `(未登録 ${index})`;
    const opaqueText = `不透明${(opaque * 100).toFixed(0)}%`;
    const greenText = `緑${(green * 100).toFixed(1)}%`;
    if (opaque > OPAQUE_LIMIT) {
      sheetFailures += 1;
      lines.push(`  ★${id}: ${opaqueText} ${greenText} ← 背景が抜けていない`);
    } else if (fill >= FILL_LIMIT) {
      sheetFailures += 1;
      lines.push(`  ★${id}: ${opaqueText} 充填${(fill * 100).toFixed(1)}% ← 背景の矩形が残っている（緑以外の色でも起きる）`);
    } else if (green > GREEN_LIMIT) {
      warnings += 1;
      lines.push(`  ?${id}: ${opaqueText} ${greenText} ← 緑が多い（被写体が緑なら問題なし）`);
    } else {
      lines.push(`  ${id}: ${opaqueText} ${greenText}`);
    }
  }
  const size = `${image.width}x${image.height}`;
  const sizeNote = image.width === 1254 && image.height === 940 ? "" : " ★寸法が違う";
  console.log(`\n${file}: ${size}${sizeNote}`);
  lines.forEach((line) => console.log(line));
  failures += sheetFailures;
}

console.log(
  failures
    ? `\n★${failures}マスで背景が抜けていません。scripts/key-green.mjs で抜き直してからシートを作り直してください`
    : `\n背景抜け OK（${sheets.length}枚${warnings ? `・要確認 ${warnings}マス` : ""}）`
);
process.exit(failures ? 1 : 0);
