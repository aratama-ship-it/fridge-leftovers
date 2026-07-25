#!/usr/bin/env node
// index.html のキャッシュ回避クエリ（?v=）を、参照先ファイルの内容ハッシュへ揃える。
//
//   node scripts/cache-version.mjs          index.html を書き換える
//   node scripts/cache-version.mjs --check   ずれていれば終了コード1で知らせる
//
// 手で番号を上げる運用は、上げ忘れると更新が既存ユーザーへ届かないため廃止した。
// 内容が変わったファイルだけクエリが変わるので、変えていないファイルの
// キャッシュは無駄に捨てられない。
//
// vendor/ 配下は同梱ライブラリ自体のバージョン表記なので対象外にする。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(root, "index.html");
const reference = /(href|src)="([^"?#]+)\?v=([^"]*)"/g;

const checkOnly = process.argv.includes("--check");
const original = readFileSync(indexPath, "utf8");

const contentHash = (relativePath) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, relativePath)))
    .digest("hex")
    .slice(0, 8);

const stale = [];
const missing = [];

const updated = original.replace(reference, (match, attribute, path, version) => {
  if (path.startsWith("vendor/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return match;

  let hash;
  try {
    hash = contentHash(path);
  } catch {
    missing.push(path);
    return match;
  }

  if (hash !== version) stale.push({ path, version, hash });
  return `${attribute}="${path}?v=${hash}"`;
});

if (missing.length) {
  console.error("index.html が参照するファイルが見つかりません:");
  for (const path of missing) console.error(`  ${path}`);
  process.exit(1);
}

const describe = (item) => `  ${item.path}  ?v=${item.version} → ?v=${item.hash}`;

if (checkOnly) {
  if (stale.length) {
    console.error("キャッシュ回避クエリが内容と合っていません:");
    for (const item of stale) console.error(describe(item));
    console.error("\n`node scripts/cache-version.mjs` を実行してから、index.html を一緒にコミットしてください。");
    process.exit(1);
  }
  console.log("キャッシュ回避クエリ: OK（すべて内容ハッシュと一致）");
  process.exit(0);
}

if (!stale.length) {
  console.log("キャッシュ回避クエリ: 変更なし（すでに一致）");
  process.exit(0);
}

writeFileSync(indexPath, updated);
console.log("キャッシュ回避クエリを更新しました:");
for (const item of stale) console.log(describe(item));
