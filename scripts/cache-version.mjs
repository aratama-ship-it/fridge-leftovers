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

// Service Worker も同じ仕組みで揃える。中身が1バイトでも変わればブラウザは
// 新しいものとして入れ替えるので、版と先読みリストを内容から作っておけば、
// 更新が確実に行き渡る。
//
// 先読みリストには ?v= 付きの実物のパスが必要になる。index.html が参照する
// ファイル（vendor/ 以外）をそのまま並べる。イラストは styles.css から
// 参照されていてここには出てこないので、使われたときに溜まる。
const workerPath = resolve(root, "sw.js");
const workerVersion = /(const VERSION = ")([0-9a-f]{8})(")/;
const workerList = /(\/\/ ここから自動更新\nconst REFERENCED = \[\n)([\s\S]*?)(\];\n\/\/ ここまで自動更新)/;

function referencedPaths(indexContent) {
  const paths = [];
  for (const [, , path, version] of indexContent.matchAll(reference)) {
    if (path.startsWith("vendor/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
    paths.push(`  "./${path}?v=${version}"`);
  }
  return paths.join(",\n") + "\n";
}

// sw.js 自身の中身も版に混ぜる。混ぜないと、取り出し方だけ直したときに
// 版が据え置きになり、古い内容のキャッシュが使われ続ける。
// VERSION の行は自分自身なので伏せてから数える（でないと決まらない）。
function nextWorkerVersion(indexContent, workerContent) {
  return createHash("sha256")
    .update(indexContent)
    .update(readFileSync(resolve(root, "app.js")))
    .update(readFileSync(resolve(root, "styles.css")))
    .update(workerContent.replace(workerVersion, "$1@@@@@@@@$3"))
    .digest("hex")
    .slice(0, 8);
}

const worker = readFileSync(workerPath, "utf8");
const currentWorkerVersion = worker.match(workerVersion)?.[2];
if (!currentWorkerVersion) {
  console.error("sw.js の VERSION を見つけられませんでした");
  process.exit(1);
}
if (!workerList.test(worker)) {
  console.error("sw.js の REFERENCED（自動更新の目印つき）を見つけられませんでした");
  process.exit(1);
}

const wantedList = referencedPaths(updated);
const withList = worker.replace(workerList, `$1${wantedList}$3`);
// 版は先読みリストを入れたあとの中身から作る（リストだけ変わって版が
// 据え置きになると、古いリストのまま配られてしまう）
const wantedWorkerVersion = nextWorkerVersion(updated, withList);
const wantedWorker = withList.replace(workerVersion, `$1${wantedWorkerVersion}$3`);
const workerStale = wantedWorker !== worker;

if (checkOnly) {
  if (stale.length) {
    console.error("キャッシュ回避クエリが内容と合っていません:");
    for (const item of stale) console.error(describe(item));
  }
  if (workerStale) {
    console.error("sw.js が内容と合っていません（版または先読みリスト）:");
    if (currentWorkerVersion !== wantedWorkerVersion) {
      console.error(`  版 ${currentWorkerVersion} → ${wantedWorkerVersion}`);
    }
    if (worker.match(workerList)?.[2] !== wantedList) {
      console.error("  先読みリストが index.html の参照とずれています");
    }
  }
  if (stale.length || workerStale) {
    console.error("\n`node scripts/cache-version.mjs` を実行してから、index.html と sw.js を一緒にコミットしてください。");
    process.exit(1);
  }
  console.log("キャッシュ回避クエリ: OK（index.html・sw.js とも内容ハッシュと一致）");
  process.exit(0);
}

if (stale.length) {
  writeFileSync(indexPath, updated);
  console.log("キャッシュ回避クエリを更新しました:");
  for (const item of stale) console.log(describe(item));
} else {
  console.log("キャッシュ回避クエリ: 変更なし（すでに一致）");
}

if (workerStale) {
  writeFileSync(workerPath, wantedWorker);
  console.log(`sw.js を更新しました（版 ${currentWorkerVersion} → ${wantedWorkerVersion}・先読み${wantedList.trim().split("\n").length}件）`);
} else {
  console.log("sw.js: 変更なし");
}
