#!/usr/bin/env node
// 既存アトラス4枚（base / everyday / recipe / expanded）の縦横比を直す。
//
// 表示側は background-size: 440% 330% で、画像を横4列・縦3行の「正方形のマス」
// として扱う。正しいシート寸法は 幅×0.75。既存4枚は 1254×1254 で作られていた
// ため、マスが 313.5×418 の縦長になり、被写体が横へ約1.33倍伸びて表示される。
//
// 各マスから被写体（アルファ範囲）を切り出し、1254×940 のシートへ
// 置き直すことで直す。配置は build-atlas.mjs と同じ関数を使うので、
// 新しいシートと同じ 68% 占有・中心そろえになる。
//
//   node scripts/refit-legacy-atlas.mjs          書き換える
//   node scripts/refit-legacy-atlas.mjs --check   ずれを報告するだけ

import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD_WIDTH = 1254;
const OLD_HEIGHT = 1254;
const NEW_WIDTH = 1254;
const NEW_HEIGHT = 940;
const COLUMNS = 4;
const ROWS = 3;
const OCCUPANCY = 0.68;

const SHEETS = [
  { atlas: "base", file: "ingredient-atlas.png" },
  { atlas: "everyday", file: "ingredient-atlas-everyday.png" },
  { atlas: "recipe", file: "ingredient-atlas-recipe.png" },
  { atlas: "expanded", file: "ingredient-atlas-expanded.png" }
];

// build-atlas.mjs から画像処理をそのまま借りる。二重に実装したくない。
const source = fs.readFileSync(`${ROOT}scripts/build-atlas.mjs`, "utf8");
const grab = (name) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`${name} を取り出せませんでした`);
  return source.slice(start, end + 3);
};
// crc32 が使う crcTable は関数ではなく定数なので、定義ごと持ってくる
const crcTableSource = source.slice(
  source.indexOf("const crcTable ="),
  source.indexOf(";", source.indexOf("});", source.indexOf("const crcTable ="))) + 1
);
const shared = new Function(
  "fs", "zlib", "Buffer", "PNG_SIGNATURE", "ALPHA_BOUNDARY", "GRID_COLUMNS", "GRID_ROWS",
  "ATLAS_WIDTH", "ATLAS_HEIGHT",
  crcTableSource + "\n"
  + ["paethPredictor", "decodePng", "crc32", "pngChunk", "encodePng", "alphaBounds",
   "samplePremultiplied", "compositePixel", "placeImage", "gridCell"].map(grab).join("\n")
  + "; return { decodePng, encodePng, alphaBounds, placeImage, gridCell };"
)(fs, zlib, Buffer, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 32,
  COLUMNS, ROWS, NEW_WIDTH, NEW_HEIGHT);

const { decodePng, encodePng, alphaBounds, placeImage, gridCell } = shared;

// app.js のイラスト定義から、どのマスに何が入っているかを読む
function illustrationMap() {
  const app = fs.readFileSync(`${ROOT}app.js`, "utf8");
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

// 縦長のマスから被写体だけを切り出す
function cutCell(image, index) {
  const cellWidth = OLD_WIDTH / COLUMNS;
  const cellHeight = OLD_HEIGHT / ROWS;
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const width = Math.round(cellWidth);
  const height = Math.round(cellHeight);
  const cell = { width, height, pixels: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.round(column * cellWidth) + x;
      const sourceY = Math.round(row * cellHeight) + y;
      if (sourceX >= image.width || sourceY >= image.height) continue;
      const from = (sourceY * image.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        cell.pixels[to + channel] = image.pixels[from + channel];
      }
    }
  }
  return cell;
}


// 元シートでは被写体が隣のマスへはみ出しているものがあり、マス単位で切ると
// 隣の破片が混入する。アルファのつながり（連結成分）を調べ、いちばん大きい
// かたまりに対して小さすぎる破片を落とす。
// 卵2個・ねぎの束のように本来複数に分かれる被写体を消さないよう、
// 面積が最大成分の15%以上あるものは残す。
function dropStrayFragments(cell, threshold = 32, keepRatio = 0.15) {
  const { width, height, pixels } = cell;
  const label = new Int32Array(width * height).fill(-1);
  const areas = [];
  const stack = [];
  for (let start = 0; start < width * height; start += 1) {
    if (label[start] !== -1 || pixels[start * 4 + 3] < threshold) continue;
    const id = areas.length;
    let area = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const at = stack.pop();
      area += 1;
      const x = at % width;
      const y = (at - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (label[next] !== -1 || pixels[next * 4 + 3] < threshold) continue;
        label[next] = id;
        stack.push(next);
      }
    }
    areas.push(area);
  }
  if (areas.length <= 1) return { dropped: 0, parts: areas.length };
  const largest = Math.max(...areas);
  let dropped = 0;
  for (let at = 0; at < width * height; at += 1) {
    const id = label[at];
    if (id < 0) continue;
    if (areas[id] >= largest * keepRatio) continue;
    pixels[at * 4 + 3] = 0;
    dropped += 1;
  }
  return { dropped, parts: areas.filter((a) => a >= largest * keepRatio).length };
}

const checkOnly = process.argv.includes("--check");
const names = illustrationMap();
let changed = 0;

for (const sheet of SHEETS) {
  const path = `${ROOT}assets/${sheet.file}`;
  const image = decodePng(path);
  const ids = names.get(sheet.atlas) || new Map();

  if (image.width === NEW_WIDTH && image.height === NEW_HEIGHT) {
    console.log(`${sheet.file}: すでに ${NEW_WIDTH}x${NEW_HEIGHT}（対象外）`);
    continue;
  }
  if (image.width !== OLD_WIDTH || image.height !== OLD_HEIGHT) {
    console.log(`★${sheet.file}: 想定外の寸法 ${image.width}x${image.height}（触りません）`);
    continue;
  }

  // encodePng が Buffer を前提にしているため Buffer.alloc を使う
  const atlas = { width: NEW_WIDTH, height: NEW_HEIGHT, pixels: Buffer.alloc(NEW_WIDTH * NEW_HEIGHT * 4) };
  const report = [];
  for (let index = 0; index < COLUMNS * ROWS; index += 1) {
    const cell = cutCell(image, index);
    const id = ids.get(index) || `(空 ${index})`;
    const cleaned = dropStrayFragments(cell);
    const bounds = alphaBounds(cell);
    if (!bounds) { report.push(`${id}=空`); continue; }
    const placed = placeImage(atlas, cell, bounds, gridCell(index), OCCUPANCY);
    const note = cleaned.dropped ? `  破片${cleaned.dropped}px除去` : "";
    report.push(`${id} ${bounds.width}x${bounds.height}→${placed.width}x${placed.height}${note}`);
  }

  console.log(`\n${sheet.file}: ${image.width}x${image.height} → ${NEW_WIDTH}x${NEW_HEIGHT}`);
  report.forEach((line) => console.log(`  ${line}`));

  if (!checkOnly) {
    fs.writeFileSync(path, encodePng(atlas));
    changed += 1;
  }
}

console.log(checkOnly
  ? "\n--check のため書き換えていません"
  : `\n${changed}枚を書き換えました。styles.css の画像 ?v= を更新してください`);
