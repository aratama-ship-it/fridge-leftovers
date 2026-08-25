#!/usr/bin/env node
// 保存した在庫が壊れていても、サンプルで上書きせず安全に起動できるかを確かめる。
//
//   node scripts/check-inventory-load.mjs
//
// app.js はブラウザ前提なので、loadInventory() だけを対応する閉じ括弧まで
// 切り出し、localStorage などをモックに差し替えて評価する。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "app.js"), "utf8");
const STORAGE_KEY = "fridge-leftovers-inventory-v2";
const BACKUP_KEY = `${STORAGE_KEY}.corrupt-backup`;
const NO_SAVED_VALUE = Symbol("no-saved-value");
const SAMPLE_INVENTORY = Array.from({ length: 5 }, (_, index) => ({
  id: `sample-${index + 1}`,
  origin: "default-sample"
}));

function takeFunction(name) {
  const start = app.indexOf(`function ${name}() {`);
  if (start < 0) throw new Error(`関数 ${name} が見つかりません`);
  const opening = app.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    if (app[index] === "}") depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`関数 ${name} の終わりが見つかりません`);
}

const loadInventorySource = takeFunction("loadInventory");

function runCase({ saved = NO_SAVED_VALUE, getError = false, setError = false } = {}) {
  const state = { inventory: SAMPLE_INVENTORY.map((item) => ({ ...item })) };
  const writes = new Map();
  const toastMessages = [];
  let storageUnavailableCalls = 0;
  const localStorage = {
    getItem(key) {
      if (getError) throw new Error("getItem failed");
      if (key !== STORAGE_KEY || saved === NO_SAVED_VALUE) return null;
      return saved;
    },
    setItem(key, value) {
      if (setError) throw new Error("setItem failed");
      writes.set(key, value);
    }
  };
  const showToast = (message) => toastMessages.push(message);
  const markStorageUnavailable = () => {
    storageUnavailableCalls += 1;
  };
  const loadInventory = new Function(
    "localStorage",
    "state",
    "STORAGE_KEY",
    "showToast",
    "markStorageUnavailable",
    `"use strict";\n${loadInventorySource}\nreturn loadInventory;`
  )(localStorage, state, STORAGE_KEY, showToast, markStorageUnavailable);

  loadInventory();
  return { state, writes, toastMessages, storageUnavailableCalls };
}

const results = [];
const remember = (label, result) => {
  results.push({ label, result });
  return result;
};
let passed = 0;
function test(label, check) {
  check();
  passed += 1;
  console.log(`ok: ${label}`);
}

test("壊れたJSONは原文を退避し、空の在庫で初回登録へ進む", () => {
  const result = remember("壊れたJSON", runCase({ saved: "{oops" }));
  assert.deepEqual(result.state.inventory, []);
  assert.equal(result.state.needsOnboarding, true);
  assert.equal(result.writes.get(BACKUP_KEY), "{oops");
  assert.deepEqual(result.toastMessages, [
    "保存されていた在庫データを読み込めず、空の状態から始めました"
  ]);
});

test("配列でないJSONも壊れデータとして扱う", () => {
  const result = remember("配列でないJSON", runCase({ saved: "{}" }));
  assert.deepEqual(result.state.inventory, []);
  assert.equal(result.state.needsOnboarding, true);
  assert.equal(result.writes.get(BACKUP_KEY), "{}");
  assert.equal(result.toastMessages.length, 1);
});

test("正常な配列はそのまま在庫へ読み込み、退避しない", () => {
  const inventory = [{ id: "eggs", quantity: 2 }];
  const result = remember("正常な配列", runCase({ saved: JSON.stringify(inventory) }));
  assert.deepEqual(result.state.inventory, inventory);
  assert.equal(result.writes.has(BACKUP_KEY), false);
  assert.deepEqual(result.toastMessages, []);
});

test("保存値がなければ空の在庫で初回登録へ進み、通知しない", () => {
  const result = remember("保存値なし", runCase());
  assert.deepEqual(result.state.inventory, []);
  assert.equal(result.state.needsOnboarding, true);
  assert.deepEqual(result.toastMessages, []);
});

test("在庫の読み出し失敗は保存不可として扱い、初回登録にはしない", () => {
  const result = remember("getItem失敗", runCase({ getError: true }));
  assert.deepEqual(result.state.inventory, []);
  assert.equal(result.storageUnavailableCalls, 1);
  assert.equal(result.state.needsOnboarding, undefined);
});

test("壊れデータの退避に失敗しても空の在庫で起動を続ける", () => {
  let result;
  assert.doesNotThrow(() => {
    result = runCase({ saved: "{broken", setError: true });
  });
  remember("setItem失敗", result);
  assert.deepEqual(result.state.inventory, []);
  assert.equal(result.state.needsOnboarding, true);
});

test("どのケースもサンプル5品へ置き換えない", () => {
  for (const { label, result } of results) {
    if (label === "正常な配列") {
      assert.deepEqual(result.state.inventory, [{ id: "eggs", quantity: 2 }]);
    } else {
      assert.equal(result.state.inventory.length, 0, `${label} が空の在庫ではありません`);
    }
    assert.notDeepEqual(result.state.inventory, SAMPLE_INVENTORY);
  }
});

console.log(`在庫読み込みチェック: OK（${passed}件）`);
