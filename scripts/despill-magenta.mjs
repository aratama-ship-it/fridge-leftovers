#!/usr/bin/env node
// 抜いたあとに残る「マゼンタの縁」を消す。
//
//   node scripts/despill-magenta.mjs assets/recipe-atlas-03.png
//   node scripts/despill-magenta.mjs assets/recipe-atlas-*.png
//   node scripts/despill-magenta.mjs --check assets/recipe-atlas-03.png
//
// ★なぜ要るか。料理の完成イラストは、マゼンタ地の上で描いてから抜いている。
// 抜きは「マゼンタらしさ」で不透明度を決めるが、**色はそのまま残る。** 被写体と
// 地の境目は両方が混ざった色になっているので、抜いたあとも幅1〜2pxのピンクの
// 縁が残る。実測で r01〜r03 は不透明画素の0.4%がこれだった（緑地で作った
// 食材シートは0.000%）。72〜108pxまで縮めても、白い器の縁がうっすら桃色に見える。
//
// 直し方は「不透明度はそのままに、色だけ内側の色で塗り直す」。輪郭の形は
// 変えたくない（アルファを触ると被写体が痩せる）ので、色だけを差し替える。
//
// ★マゼンタ地を使う限りこれは毎回起きる。シートを作ったら必ず通すこと。
// check-atlas-alpha.mjs でも見ているので、忘れれば止まる。

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// PNG の読み書きは build-atlas.mjs のものを借りる
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

// マゼンタらしさ＝赤と青がそろって高く、緑だけ落ちている。
//
// ★紫の食材（なす・紫キャベツ・赤紫蘇・みょうが・しょうがの新芽）と分けるのが
// この判定のすべて。最初 170/45 で書いたら、なすの明るいハイライト
// rgb(190,127,182) まで拾った。抜き残しの縁は実測で rgb(250,110〜165,215〜240)
// と、赤も青もほぼ振り切っている。両者の間を取って 200/60 にしてある。
// ★ここを緩めると紫の食材が灰色に濁る。触るときは r02 のなす、r03 のなす味噌炒め、
// 食材シート14のみょうが・24のしょうがで必ず確かめること。
export const MAGENTA_MIN = 200;
export const MAGENTA_GAP = 60;
export const isMagenta = (r, g, b) =>
  r > MAGENTA_MIN && b > MAGENTA_MIN && Math.min(r, b) - g > MAGENTA_GAP;

const OPAQUE_FLOOR = 32;

// 縁の色を、隣の「汚れていない」画素の色で埋める。1回では埋まりきらない
// （縁が2px幅なら外側は内側が埋まってから決まる）ので、無くなるまで繰り返す。
function repaint(image) {
  const { width, height, pixels } = image;
  const dirty = new Uint8Array(width * height);
  let remaining = 0;
  for (let at = 0; at < width * height; at += 1) {
    const offset = at * 4;
    if (pixels[offset + 3] < OPAQUE_FLOOR) continue;
    if (isMagenta(pixels[offset], pixels[offset + 1], pixels[offset + 2])) {
      dirty[at] = 1;
      remaining += 1;
    }
  }
  const total = remaining;
  if (!remaining) return { total: 0, passes: 0, left: 0 };

  let passes = 0;
  // 幅1〜2pxの縁なので数回で終わる。念のため上限を置く
  while (remaining && passes < 12) {
    passes += 1;
    const fixed = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = y * width + x;
        if (!dirty[at]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
            const near = ny * width + nx;
            if (dirty[near]) continue;
            const offset = near * 4;
            // 透けている側は色を持たないので、内側の色だけを見る
            if (pixels[offset + 3] < OPAQUE_FLOOR) continue;
            r += pixels[offset];
            g += pixels[offset + 1];
            b += pixels[offset + 2];
            count += 1;
          }
        }
        if (!count) continue;
        fixed.push([at, Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
      }
    }
    // 1周ぶんまとめて書く。途中で書くと、直した色が同じ周の隣へ伝わって
    // 縁の色が内側へ流れ込む
    if (!fixed.length) {
      // 周りが全部汚れている孤立した点（実測でr02に3px）。借りる色が無いので、
      // 赤と青を緑のところまで落として色味だけ消す
      for (let at = 0; at < width * height; at += 1) {
        if (!dirty[at]) continue;
        const offset = at * 4;
        const ceiling = pixels[offset + 1] + MAGENTA_GAP;
        pixels[offset] = Math.min(pixels[offset], ceiling);
        pixels[offset + 2] = Math.min(pixels[offset + 2], ceiling);
        dirty[at] = 0;
        remaining -= 1;
      }
      break;
    }
    for (const [at, r, g, b] of fixed) {
      const offset = at * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      dirty[at] = 0;
      remaining -= 1;
    }
  }
  return { total, passes, left: remaining };
}

// isMagenta を他から読めるようにしてあるので、直に実行されたときだけ道具として動く
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const files = args.filter((value) => !value.startsWith("--"));
  if (!files.length) {
    console.error("使い方: node scripts/despill-magenta.mjs [--check] <PNG...>");
    process.exit(1);
  }

  let dirtyFiles = 0;
  for (const file of files) {
    const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
    if (!fs.existsSync(full)) {
      console.log(`${file}: ありません`);
      dirtyFiles += 1;
      continue;
    }
    const image = decodePng(full);
    const { total, passes, left } = repaint(image);
    const shown = path.relative(ROOT, full);
    if (!total) {
      console.log(`${shown}: マゼンタの縁なし`);
      continue;
    }
    dirtyFiles += 1;
    if (checkOnly) {
      console.log(`★${shown}: マゼンタの縁が ${total}px 残っています`);
      continue;
    }
    fs.writeFileSync(full, encodePng(image));
    console.log(
      `${shown}: ${total}px を塗り直しました（${passes}周${left ? `・${left}px 残り` : ""}）`
    );
  }

  if (checkOnly && dirtyFiles) {
    console.log("\n★scripts/despill-magenta.mjs を通してから作り直してください");
  }
  process.exit(checkOnly && dirtyFiles ? 1 : 0);
}
