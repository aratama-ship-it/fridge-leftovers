#!/usr/bin/env node
// ホーム画面のアイコンを書き出す。
//
// 絵は「アプリの中の冷蔵庫」をそのまま小さくしたもの。地は葉色、本体は
// クリームの紙色、上は冷凍室の淡い青、下の庫内に棚2本と中身3つ。色は
// styles.css の :root と .fridge-* から取っている。ホーム画面に並んだとき、
// つるつるしたアイコンの列の中で「台所のノート」に見えることを狙っている。
//
//   node scripts/build-icons.mjs           assets/icons/ へ5枚書き出す
//   node scripts/build-icons.mjs --check    今のファイルと一致するか確かめる
//
// 見え方の確認は assets/icon-preview.html（書き出したファイルを並べて、
// iOSの角丸とAndroidの丸マスクをかけて見せる）。

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets/icons");

// PNG の書き出しは build-atlas.mjs のものを借りる。二重に実装したくない。
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
const { encodePng } = new Function(
  "fs", "zlib", "Buffer", "PNG_SIGNATURE",
  crcTableSource + "\n" + ["crc32", "pngChunk", "encodePng"].map(grab).join("\n")
  + "; return { encodePng };"
)(fs, zlib, Buffer, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

// ---- 塗り ----------------------------------------------------------------
// 形は符号付き距離で持つ。距離から被覆率を出せば、追加の標本化なしで
// 縁がなめらかになる（32pxでも輪郭が階段にならない）。

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

const PAPER = rgb("#f3f0e6");
const LEAF = rgb("#2f644b");
const LEAF_DARK = rgb("#1d4331");
const FREEZER = rgb("#c7e2ed");
const CHAMBER = rgb("#e7eee8");
const SHELF = rgb("#96a99c");
const HANDLE = rgb("#dfe6dc");
const WARM = rgb("#a8492d");
const SPROUT = rgb("#4c7a52");
const BUTTER = rgb("#e8c25f");
const EDGE = rgb("#788a7c");

function canvas(size) {
  return { width: size, height: size, pixels: Buffer.alloc(size * size * 4, 0) };
}

function blend(image, x, y, color, alpha) {
  if (alpha <= 0) return;
  const offset = (y * image.width + x) * 4;
  const source = Math.min(1, alpha);
  const target = image.pixels[offset + 3] / 255;
  const out = source + target * (1 - source);
  for (let channel = 0; channel < 3; channel += 1) {
    const under = image.pixels[offset + channel];
    image.pixels[offset + channel] = Math.round(
      (color[channel] * source + under * target * (1 - source)) / out
    );
  }
  image.pixels[offset + 3] = Math.round(out * 255);
}

// 角丸長方形までの符号付き距離（内側が負）
function roundRectDistance(px, py, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - radius);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - radius);
  const dx = Math.max(cx, 0);
  const dy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.hypot(dx, dy) - radius;
}

function fillShape(image, distance, color, box) {
  const left = Math.max(0, Math.floor(box[0]) - 2);
  const top = Math.max(0, Math.floor(box[1]) - 2);
  const right = Math.min(image.width, Math.ceil(box[2]) + 2);
  const bottom = Math.min(image.height, Math.ceil(box[3]) + 2);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const d = distance(x + 0.5, y + 0.5);
      const coverage = Math.min(1, Math.max(0, 0.5 - d));
      if (coverage > 0) blend(image, x, y, color, coverage);
    }
  }
}

function roundRect(image, x, y, w, h, r, color) {
  fillShape(image, (px, py) => roundRectDistance(px, py, x, y, w, h, r), color,
    [x, y, x + w, y + h]);
}

function roundRectOutline(image, x, y, w, h, r, width, color) {
  fillShape(
    image,
    (px, py) => Math.abs(roundRectDistance(px, py, x, y, w, h, r)) - width / 2,
    color,
    [x - width, y - width, x + w + width, y + h + width]
  );
}

function circle(image, cx, cy, r, color) {
  fillShape(image, (px, py) => Math.hypot(px - cx, py - cy) - r, color,
    [cx - r, cy - r, cx + r, cy + r]);
}

// ---- 絵 ------------------------------------------------------------------
// 座標はすべて S（辺の長さ）に対する比。scale は maskable 用で、Androidが
// 安全域として扱う中央80%の円へ収めるために中心のまま縮める。
//
// 64px以下では棚2本＋中身3つが潰れて灰色の帯になるので、棚1本・中身2つに
// 減らして粒を大きくする（光学サイズの作り分け）。

function drawIcon(size, scale = 1) {
  const image = canvas(size);
  const S = size;
  const small = S <= 64;

  // 地：葉色。上から下へわずかに沈ませて、紙の白が浮くようにする
  for (let y = 0; y < S; y += 1) {
    const ratio = y / (S - 1);
    const color = [0, 1, 2].map((channel) =>
      Math.round(LEAF[channel] + (LEAF_DARK[channel] - LEAF[channel]) * ratio)
    );
    for (let x = 0; x < S; x += 1) blend(image, x, y, color, 1);
  }

  // scale を効かせるため、比を中心から縮める座標変換を用意する
  const px = (value) => S / 2 + (value * S - S / 2) * scale;
  const len = (value) => value * S * scale;

  const bodyX = px(0.205);
  const bodyY = px(0.145);
  const bodyW = len(0.59);
  const bodyH = len(0.71);

  // 取っ手は本体の右外側。アプリ内の冷蔵庫と同じ位置
  roundRect(image, bodyX + bodyW - len(0.004), bodyY + len(0.145),
    len(0.042), len(0.17), len(0.018), HANDLE);

  roundRect(image, bodyX, bodyY, bodyW, bodyH, len(0.055), PAPER);

  const inset = len(0.045);
  const innerX = bodyX + inset;
  const innerW = bodyW - inset * 2;

  // 冷凍室（上）。淡い青はこの絵が「冷蔵庫」だと一目で分かる手がかり
  const freezerY = bodyY + inset;
  const freezerH = len(small ? 0.16 : 0.145);
  roundRect(image, innerX, freezerY, innerW, freezerH, len(0.026), FREEZER);

  // 冷蔵室（下）
  const chamberY = freezerY + freezerH + len(0.032);
  const chamberH = bodyY + bodyH - inset - chamberY;
  roundRect(image, innerX, chamberY, innerW, chamberH, len(0.026), CHAMBER);

  // 仕切りの縁。塗りだけだと平たいので、庫内に細い線を回す
  if (!small) {
    const width = Math.max(1, len(0.006));
    const edge = EDGE.map((channel, index) =>
      Math.round(channel * 0.34 + CHAMBER[index] * 0.66)
    );
    roundRectOutline(image, innerX, freezerY, innerW, freezerH, len(0.026), width, edge);
    roundRectOutline(image, innerX, chamberY, innerW, chamberH, len(0.026), width, edge);
  }

  // 棚。中身を乗せる線として、はっきり引く
  const shelfH = len(small ? 0.028 : 0.019);
  const shelves = small
    ? [chamberY + chamberH * 0.62]
    : [chamberY + chamberH * 0.44, chamberY + chamberH * 0.83];
  for (const y of shelves) {
    roundRect(image, innerX + len(0.012), y, innerW - len(0.024), shelfH, shelfH / 2, SHELF);
  }

  // 中身。棚の上に置く
  if (small) {
    const top = shelves[0];
    circle(image, innerX + innerW * 0.33, top - len(0.062), len(0.058), WARM);
    circle(image, innerX + innerW * 0.68, top - len(0.056), len(0.05), SPROUT);
  } else {
    const [upper, lower] = shelves;
    circle(image, innerX + innerW * 0.31, upper - len(0.043), len(0.04), WARM);
    circle(image, innerX + innerW * 0.66, upper - len(0.037), len(0.034), SPROUT);
    circle(image, innerX + innerW * 0.47, lower - len(0.036), len(0.033), BUTTER);
  }

  return image;
}

// Androidは中央80%の円だけを安全域として扱う。本体の角が円の外へ出るので、
// maskable 用は少し縮める。
const MASKABLE_SCALE = 0.84;

const FILES = [
  { name: "icon-192.png", size: 192, scale: 1 },
  { name: "icon-512.png", size: 512, scale: 1 },
  { name: "icon-maskable-512.png", size: 512, scale: MASKABLE_SCALE },
  { name: "apple-touch-icon.png", size: 180, scale: 1 },
  { name: "favicon-32.png", size: 32, scale: 1 }
];

const checkOnly = process.argv.includes("--check");
fs.mkdirSync(OUT, { recursive: true });

let stale = 0;
for (const file of FILES) {
  const target = path.join(OUT, file.name);
  const png = encodePng(drawIcon(file.size, file.scale));
  const same = fs.existsSync(target) && Buffer.compare(fs.readFileSync(target), png) === 0;
  if (same) {
    console.log(`assets/icons/${file.name}: 変化なし（${file.size}px）`);
    continue;
  }
  stale += 1;
  if (checkOnly) {
    console.log(`★assets/icons/${file.name}: 古い（${file.size}px）`);
  } else {
    fs.writeFileSync(target, png);
    console.log(`assets/icons/${file.name}: 書き出しました（${file.size}px・${png.length}バイト）`);
  }
}

if (checkOnly && stale) {
  console.log("\n★アイコンが古いままです。node scripts/build-icons.mjs を実行してください");
  process.exit(1);
}
console.log(checkOnly ? "\nアイコン: OK" : `\n${stale ? `${stale}枚を更新しました` : "更新はありません"}`);
