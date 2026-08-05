#!/usr/bin/env node
// 共有サーバー（worker/src/index.js）を、Cloudflareへ上げる前に手元で確かめる。
//
//   node worker/check-worker.mjs
//
// ★wrangler は使わない。この環境では wrangler が固まって進まなかったのと、
// wrangler dev を立てなくても中身は確かめられるため。D1 の代わりに Node 22 の
// node:sqlite で本物の SQLite を使い、D1 と同じ形（prepare/bind/first/all/run）
// をかぶせて Worker へ渡す。SQL も分岐も本物が動く。
//
// 確かめるのは、二人で使ったときに困る順:
//   ・冷蔵庫を作れるか
//   ・書いたものが相手に届くか（前回の続きから引けるか）
//   ・同時に触ったとき、黙って上書きされないか
//   ・消したことが相手に伝わるか
//   ・他人の冷蔵庫を覗けないか

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(path.join(HERE, "src/index.js"))).default;

// ---- D1 のふりをする ------------------------------------------------------
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path.join(HERE, "schema.sql"), "utf8"));
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let args = [];
      const api = {
        bind(...values) { args = values; return api; },
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return statement.run(...args); }
      };
      return api;
    }
  };
}

const env = { DB: makeDb() };
const call = async (method, url, body) => {
  const response = await worker.fetch(
    new Request(`https://example.test${url}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }),
    env
  );
  return { status: response.status, body: await response.json() };
};

let failures = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`✗ ${label}\n    実際: ${JSON.stringify(actual)}\n    期待: ${JSON.stringify(expected)}`);
  }
}

// ---- 既存D1へ列を足せる --------------------------------------------------
const migrationDb = new DatabaseSync(":memory:");
migrationDb.exec(`
  create table entities (
    fridge_id text not null,
    kind text not null,
    id text not null,
    body text,
    version integer not null default 1,
    change_seq integer not null,
    deleted_at integer,
    updated_at integer not null,
    primary key (fridge_id, kind, id)
  );
`);
migrationDb.exec(readFileSync(
  path.join(HERE, "migrations/0002_change_attribution.sql"),
  "utf8"
));
check("既存DBへ変更時刻と端末の列を追加できる",
  migrationDb.prepare("pragma table_info(entities)").all()
    .map((column) => column.name)
    .filter((name) => ["changed_at", "device_id", "device_name"].includes(name)),
  ["changed_at", "device_id", "device_name"]);

// ---- 冷蔵庫を作る --------------------------------------------------------
const created = await call("POST", "/v1/fridges");
const fridge = created.body.id;
check("冷蔵庫を作れる", [created.status, typeof fridge, fridge?.length], [200, "string", 22]);
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
check("IDは決めた文字だけでできている",
  [...(fridge || "x")].every((letter) => ALPHABET.includes(letter)), true);
check("紛らわしい文字（l・1・o・0）を含まない", /[l1o0]/.test(fridge || "x"), false);

// ---- 書いたものが相手に届く ----------------------------------------------
const push = (changes) => call("POST", `/v1/fridges/${fridge}/changes`, { changes });
const pull = (since = 0) => call("GET", `/v1/fridges/${fridge}/changes?since=${since}`);

const first = await push([
  {
    kind: "item",
    id: "eggs",
    body: { id: "eggs", name: "卵", quantity: 6 },
    baseVersion: 0,
    changedAt: "2026-08-05T09:15:00.000Z",
    changedBy: { id: "device-a", name: "台所のiPad" }
  },
  { kind: "item", id: "tofu", body: { id: "tofu", name: "豆腐", quantity: 2 }, baseVersion: 0 }
]);
check("新しい行は applied で返る",
  first.body.results.map((r) => [r.status, r.version]), [["applied", 1], ["applied", 1]]);

const all = await pull(0);
check("相手は中身を受け取れる",
  all.body.changes.map((c) => [c.kind, c.id, c.body.quantity, c.version]),
  [["item", "eggs", 6, 1], ["item", "tofu", 2, 1]]);
const pulledEggs = all.body.changes.find((change) => change.id === "eggs");
check("変更時刻と端末名も相手へ届く",
  [pulledEggs.changedAt, pulledEggs.changedBy],
  ["2026-08-05T09:15:00.000Z", { id: "device-a", name: "台所のiPad" }]);
const pulledTofu = all.body.changes.find((change) => change.id === "tofu");
check("古い端末からの変更は受信時刻と端末不明で補う",
  [Number.isNaN(Date.parse(pulledTofu.changedAt)), pulledTofu.changedBy],
  [false, null]);

// ---- 前回の続きから引ける ------------------------------------------------
await push([{
  kind: "item",
  id: "eggs",
  body: { id: "eggs", name: "卵", quantity: 4 },
  baseVersion: 1,
  changedAt: "2026-08-05T09:20:00.000Z",
  changedBy: { id: "device-b", name: "買い物用スマホ" }
}]);
const since = await pull(all.body.seq);
check("続きだけが届く（変えた1件）",
  since.body.changes.map((c) => [c.id, c.body.quantity, c.version]), [["eggs", 4, 2]]);
check("更新した端末の情報へ入れ替わる",
  [since.body.changes[0].changedAt, since.body.changes[0].changedBy?.name],
  ["2026-08-05T09:20:00.000Z", "買い物用スマホ"]);

// ---- ★同時に触っても黙って上書きしない ----------------------------------
const stale = await push([
  { kind: "item", id: "eggs", body: { id: "eggs", name: "卵", quantity: 99 }, baseVersion: 1 }
]);
check("古い版で書くと conflict",
  stale.body.results.map((r) => r.status), ["conflict"]);
check("競合のときサーバー側の中身を返す",
  stale.body.results[0].server.body.quantity, 4);
check("競合のときサーバー側の端末情報も返す",
  stale.body.results[0].server.changedBy?.name, "買い物用スマホ");
check("競合しても書き換わっていない", (await pull(0)).body.changes
  .find((c) => c.id === "eggs").body.quantity, 4);

// サーバーに無いのに版を申告した場合
const ghost = await push([
  { kind: "item", id: "ghost", body: { id: "ghost" }, baseVersion: 5 }
]);
check("知らない行に版を申告しても conflict",
  [ghost.body.results[0].status, ghost.body.results[0].server], ["conflict", null]);

// ---- 消したことが伝わる --------------------------------------------------
const removed = await push([{ kind: "item", id: "tofu", deleted: true, baseVersion: 1 }]);
check("削除は applied で返る", removed.body.results[0].status, "applied");
const afterDelete = (await pull(0)).body.changes.find((c) => c.id === "tofu");
check("削除は墓石として届く", [afterDelete.deleted, afterDelete.body], [true, null]);

// ---- 受け付けないもの ----------------------------------------------------
check("知らない種別は拒む",
  (await push([{ kind: "でたらめ", id: "x", body: {}, baseVersion: 0 }]))
    .body.results[0].status, "rejected");
check("他人の冷蔵庫は覗けない",
  (await call("GET", "/v1/fridges/aaaaaaaaaaaaaaaaaaaaaa/changes?since=0")).status, 404);
check("形の違うIDは弾く",
  (await call("GET", "/v1/fridges/short/changes?since=0")).status, 404);
check("知らないURLは404",
  (await call("GET", "/v1/nope")).status, 404);
check("一度に送りすぎたら断る",
  (await push(Array.from({ length: 201 }, (_, at) =>
    ({ kind: "item", id: `x${at}`, body: {}, baseVersion: 0 })))).status, 413);

console.log(failures
  ? `\n★${failures}件が期待と違います`
  : "共有サーバーのチェック: OK");
process.exit(failures ? 1 : 0);
