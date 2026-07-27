#!/usr/bin/env node
// ホーム画面のアイコンを書き出す。
//
// 素材は2つ（Codexが描いたもの）。
//   assets/icon-src/foreground-1024.png … 冷蔵庫の絵だけ。背景は透過
//   assets/icon-src/background.txt      … 地の色。1行なら単色、2行なら縦グラデ
//
// ★この2つに分けているのは、Androidのアイコンが「背景」と「前景」を重ねて
// 端末側が円や角丸に切り抜く決まりだから。前景を分けておけば、切り抜きに
// 合わせて縮め方を変えられる。1枚の完成画像だと、切り抜かれる分を見越した
// 余白を絵の中に持たせることになり、iOSでは余白が大きすぎ、Androidでは
// ぎりぎり、という板挟みになる。
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
const SRC = path.join(ROOT, "assets/icon-src");

// PNG の読み書きは build-atlas.mjs のものを借りる。二重に実装したくない。
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
const { decodePng, encodePng } = new Function(
  "fs", "zlib", "Buffer", "PNG_SIGNATURE",
  crcTableSource + "\n"
  + ["paethPredictor", "decodePng", "crc32", "pngChunk", "encodePng"].map(grab).join("\n")
  + "; return { decodePng, encodePng };"
)(fs, zlib, Buffer, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

function readBackground() {
  const lines = fs.readFileSync(path.join(SRC, "background.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#[0-9a-fA-F]{6}$/.test(line));
  if (!lines.length) throw new Error("background.txt に色（#RRGGBB）がありません");
  return lines.length === 1 ? [rgb(lines[0]), rgb(lines[0])] : [rgb(lines[0]), rgb(lines[1])];
}

// ---- 画像の組み立て ------------------------------------------------------

function canvas(size) {
  return { width: size, height: size, pixels: Buffer.alloc(size * size * 4, 0) };
}

// 面で平均する縮小。1024→60 のような大きな縮小でも、点を拾うだけの方式と
// 違って線が消えたり跳ねたりしない。
function resize(image, size) {
  const out = canvas(size);
  const scale = image.width / size;
  for (let y = 0; y < size; y += 1) {
    const top = Math.floor(y * scale);
    const bottom = Math.min(image.height, Math.max(top + 1, Math.ceil((y + 1) * scale)));
    for (let x = 0; x < size; x += 1) {
      const left = Math.floor(x * scale);
      const right = Math.min(image.width, Math.max(left + 1, Math.ceil((x + 1) * scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const at = (sy * image.width + sx) * 4;
          const alpha = image.pixels[at + 3] / 255;
          // 色は不透明度で重み付けして混ぜる。しないと透明部分の色が
          // にじみ出て、縁がくすむ
          r += image.pixels[at] * alpha;
          g += image.pixels[at + 1] * alpha;
          b += image.pixels[at + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }
      const at = (y * size + x) * 4;
      if (a > 0) {
        out.pixels[at] = Math.round(r / a);
        out.pixels[at + 1] = Math.round(g / a);
        out.pixels[at + 2] = Math.round(b / a);
      }
      out.pixels[at + 3] = Math.round((a / count) * 255);
    }
  }
  return out;
}

// 前景を中心のまま拡げる／縮める。1倍を超えると枠から出た分は捨てる
// （素材は中央に寄っているので、絵そのものは欠けない）。
function rescale(image, ratio) {
  if (ratio === 1) return image;
  const inner = resize(image, Math.round(image.width * ratio));
  const out = canvas(image.width);
  const offset = Math.round((image.width - inner.width) / 2);
  for (let y = 0; y < inner.height; y += 1) {
    const ty = y + offset;
    if (ty < 0 || ty >= out.height) continue;
    for (let x = 0; x < inner.width; x += 1) {
      const tx = x + offset;
      if (tx < 0 || tx >= out.width) continue;
      const from = (y * inner.width + x) * 4;
      const to = (ty * out.width + tx) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        out.pixels[to + channel] = inner.pixels[from + channel];
      }
    }
  }
  return out;
}

function compose(foreground, size, [top, bottom]) {
  const art = resize(foreground, size);
  const out = canvas(size);
  for (let y = 0; y < size; y += 1) {
    const ratio = size === 1 ? 0 : y / (size - 1);
    const ground = [0, 1, 2].map((channel) =>
      top[channel] + (bottom[channel] - top[channel]) * ratio);
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const alpha = art.pixels[at + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        out.pixels[at + channel] = Math.round(
          art.pixels[at + channel] * alpha + ground[channel] * (1 - alpha)
        );
      }
      out.pixels[at + 3] = 255;
    }
  }
  return out;
}

// ★切り抜きの有無で置く大きさを変える。前景を別に受け取っている利点はここ。
//
// maskable（Android）は中央80%の円しか安全域が無いので、素材のまま置く。
// 素材は中心から399pxに収まっていて、安全域409.6pxの内側なので触らない。
//
// それ以外（iOSのホーム画面・favicon）は角が丸められるだけなので、同じ
// 大きさで置くと余白が広すぎて絵が小さく見える。実寸48〜60pxで並べて
// 確かめ、1.3倍に上げた。
const MASKABLE_SCALE = 1;
const ANY_SCALE = 1.3;

const FILES = [
  { name: "icon-192.png", size: 192, scale: ANY_SCALE },
  { name: "icon-512.png", size: 512, scale: ANY_SCALE },
  { name: "icon-maskable-512.png", size: 512, scale: MASKABLE_SCALE },
  { name: "apple-touch-icon.png", size: 180, scale: ANY_SCALE },
  { name: "favicon-32.png", size: 32, scale: ANY_SCALE }
];

const checkOnly = process.argv.includes("--check");
const foregroundPath = path.join(SRC, "foreground-1024.png");
if (!fs.existsSync(foregroundPath)) {
  console.error("assets/icon-src/foreground-1024.png がありません");
  process.exit(1);
}
const foreground = decodePng(foregroundPath);
const background = readBackground();
fs.mkdirSync(OUT, { recursive: true });

// 安全域からはみ出していないか。ここで気づかないと、Androidで角が切れる
const centre = foreground.width / 2;
let worst = 0;
for (let y = 0; y < foreground.height; y += 1) {
  for (let x = 0; x < foreground.width; x += 1) {
    if (foreground.pixels[(y * foreground.width + x) * 4 + 3] < 32) continue;
    worst = Math.max(worst, Math.hypot(x - centre + 0.5, y - centre + 0.5));
  }
}
const safe = foreground.width * 0.4;
console.log(`前景: ${foreground.width}px・中心からの最遠 ${worst.toFixed(0)}px（安全域 ${safe}px）`);
if (worst > safe) {
  console.log(`★安全域からはみ出しています。maskable では ${(safe / worst).toFixed(2)}倍まで縮みます`);
}

let stale = 0;
for (const file of FILES) {
  const target = path.join(OUT, file.name);
  const art = rescale(foreground, file.scale);
  const png = encodePng(compose(art, file.size, background));
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
