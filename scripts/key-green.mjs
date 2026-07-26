#!/usr/bin/env node
// 緑背景（グリーンバック）で生成された素材の背景を抜く。
//
// シート14以降の素材は緑背景で生成し、抜いたものを <番号>-keyed/ に置いている。
// その工程が一部の画像で失敗し、緑の四角がそのままアトラスへ入ってしまった
// （鶏レバー・生ハム・ラム肉・ししゃも）。ここで抜き直す。
//
// 緑らしさ = g - max(r, b) で判定する。しきい値より上は完全に透明、
// 境界の帯は半透明にしたうえで緑かぶり（スピル）を抜く。
//
// バジル・絹さや・小ねぎのように被写体そのものが緑の素材へ当てると
// 中身まで消えるため、対象ファイルは必ず明示的に渡す。ディレクトリを
// まとめて処理する機能は意図的に付けていない。
//
//   node scripts/key-green.mjs assets/atlas-src/16-keyed/chicken-liver.png ...
//   node scripts/key-green.mjs --check <file...>   判定だけして書き換えない

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// PNG の読み書きは build-atlas.mjs のものを使う。二重に実装したくない。
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

// これより緑が強ければ背景、これより弱ければ被写体。間は半透明にする。
const FULL_KEY = 60;
const EDGE_KEY = 12;

function keyOut(image) {
  const { width, height, pixels } = image;
  let removed = 0;
  let softened = 0;
  for (let at = 0; at < width * height; at += 1) {
    const offset = at * 4;
    const alpha = pixels[offset + 3];
    if (alpha === 0) continue;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    const greenness = g - Math.max(r, b);
    if (greenness <= EDGE_KEY) continue;
    if (greenness >= FULL_KEY) {
      pixels[offset + 3] = 0;
      removed += 1;
      continue;
    }
    // 境界の帯。緑を落としつつ、輪郭が硬くならないよう alpha を削る
    const ratio = (FULL_KEY - greenness) / (FULL_KEY - EDGE_KEY);
    pixels[offset + 1] = Math.max(r, b);
    pixels[offset + 3] = Math.round(alpha * ratio);
    softened += 1;
  }
  return { removed, softened };
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const files = args.filter((value) => value !== "--check");
if (!files.length) {
  console.error("対象ファイルを渡してください（緑の被写体へ当てないよう明示が必要）");
  process.exit(1);
}

for (const file of files) {
  const target = path.resolve(ROOT, file);
  const image = decodePng(target);
  const { removed, softened } = keyOut(image);
  const total = image.width * image.height;
  const share = ((removed / total) * 100).toFixed(1);
  console.log(
    `${file}: ${image.width}x${image.height}  背景 ${removed}px(${share}%)  境界 ${softened}px`
  );
  if (!checkOnly && removed + softened > 0) fs.writeFileSync(target, encodePng(image));
}

console.log(checkOnly ? "\n--check のため書き換えていません" : "\n抜き直しました。アトラスを作り直してください");
