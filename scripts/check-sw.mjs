#!/usr/bin/env node
// Service Worker のキャッシュ分離を、ブラウザを開かずに確かめる。
//
//   node scripts/check-sw.mjs
//
// sw.js はブラウザ前提なので、必要最小限の API を Map ベースで再現する。
// install・activate・fetch は、登録されたイベントハンドラを通して検査する。

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = readFileSync(path.join(ROOT, "sw.js"), "utf8");
const workerUrl = "https://example.test/fridge/sw.js";

const version = workerSource.match(/const VERSION = "([0-9a-f]{8})";/)?.[1];
if (!version) throw new Error("sw.js の VERSION を見つけられません");
const shellCache = `fridge-leftovers-${version}`;
const assetCache = "fridge-leftovers-assets";

const referencedSource = workerSource.match(
  /\/\/ ここから自動更新\nconst REFERENCED = (\[[\s\S]*?\]);\n\/\/ ここまで自動更新/
)?.[1];
if (!referencedSource) throw new Error("sw.js の REFERENCED を見つけられません");
const shellPaths = ["./", "./index.html", ...JSON.parse(referencedSource)];
const shellUrls = shellPaths.map((item) => new URL(item, workerUrl).href);

let failures = 0;
function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures += 1;
    console.log(`✗ ${label}\n    実際: ${JSON.stringify(actual)}\n    期待: ${JSON.stringify(expected)}`);
  }
}

function createHarness({ failedPath = "" } = {}) {
  const handlers = new Map();
  const stores = new Map();
  let skipWaitingCalls = 0;
  let claimCalls = 0;

  class FakeRequest {
    constructor(input, init = {}) {
      const original = input instanceof FakeRequest ? input : null;
      const value = typeof input === "string" ? input : input.url;
      this.url = new URL(value, workerUrl).href;
      this.method = init.method || original?.method || "GET";
      this.mode = init.mode || original?.mode || "cors";
      this.destination = init.destination || original?.destination || "";
    }
  }

  class FakeResponse {
    constructor(body = "", init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.type = init.type || "basic";
    }

    clone() {
      return new FakeResponse(this.body, { status: this.status, type: this.type });
    }
  }

  const requestFor = (input) => input instanceof FakeRequest ? input : new FakeRequest(input);

  class FakeCache {
    constructor() {
      this.entries = new Map();
    }

    async add(input) {
      const request = requestFor(input);
      const response = await fakeFetch(request);
      if (!response.ok) throw new Error(`取得に失敗しました: ${request.url}`);
      await this.put(request, response);
    }

    async match(input) {
      const entry = this.entries.get(requestFor(input).url);
      return entry?.response.clone();
    }

    async put(input, response) {
      const request = requestFor(input);
      this.entries.set(request.url, { request, response: response.clone() });
    }

    async keys() {
      return [...this.entries.values()].map(({ request }) => new FakeRequest(request));
    }

    async delete(input) {
      return this.entries.delete(requestFor(input).url);
    }
  }

  const fakeFetch = async (input) => {
    const request = requestFor(input);
    const status = failedPath && new URL(request.url).pathname === failedPath ? 500 : 200;
    return new FakeResponse(request.url, { status });
  };

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(input) {
      for (const cache of stores.values()) {
        const response = await cache.match(input);
        if (response) return response;
      }
      return undefined;
    }
  };

  const self = {
    location: {
      href: workerUrl,
      origin: new URL(workerUrl).origin
    },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    async skipWaiting() {
      skipWaitingCalls += 1;
    },
    clients: {
      async claim() {
        claimCalls += 1;
      }
    }
  };

  vm.runInNewContext(workerSource, {
    self,
    caches,
    fetch: fakeFetch,
    Request: FakeRequest,
    Response: FakeResponse,
    URL,
    console: { warn() {} }
  }, { filename: path.join(ROOT, "sw.js") });

  async function dispatchWait(type) {
    let promise;
    handlers.get(type)({
      waitUntil(value) {
        promise = Promise.resolve(value);
      }
    });
    if (!promise) throw new Error(`${type} が waitUntil を呼びませんでした`);
    return promise;
  }

  async function dispatchFetch(request) {
    let promise;
    handlers.get("fetch")({
      request,
      respondWith(value) {
        promise = Promise.resolve(value);
      }
    });
    if (!promise) throw new Error("fetch が respondWith を呼びませんでした");
    return promise;
  }

  async function urls(name) {
    const cache = await caches.open(name);
    return (await cache.keys()).map(({ url }) => url);
  }

  return {
    Request: FakeRequest,
    Response: FakeResponse,
    caches,
    dispatchWait,
    dispatchFetch,
    urls,
    skipWaitingCalls: () => skipWaitingCalls,
    claimCalls: () => claimCalls
  };
}

// install 成功時は、起動用の全件が版つきキャッシュへ入る。
{
  const harness = createHarness();
  await harness.dispatchWait("install");
  check("install成功でSHELL全件が版つきキャッシュへ入る",
    (await harness.urls(shellCache)).sort(), [...shellUrls].sort());
  check("install成功でskipWaitingが呼ばれる", harness.skipWaitingCalls(), 1);
}

// 1件でも取得できなければ install を失敗させ、待機中Workerへ切り替えない。
{
  const harness = createHarness({ failedPath: "/fridge/app.js" });
  let rejected = false;
  try {
    await harness.dispatchWait("install");
  } catch {
    rejected = true;
  }
  check("install失敗でpromiseがrejectする", rejected, true);
  check("install失敗でskipWaitingが呼ばれない", harness.skipWaitingCalls(), 0);
}

// activate は古い版だけを消し、固定名のアセットキャッシュは残す。
{
  const harness = createHarness();
  await harness.dispatchWait("install");
  await harness.caches.open("fridge-leftovers-old");
  await harness.caches.open(assetCache);
  await harness.dispatchWait("activate");
  const names = await harness.caches.keys();
  check("activateで古い版つきキャッシュを消す", names.includes("fridge-leftovers-old"), false);
  check("activateで固定アセットキャッシュを残す", names.includes(assetCache), true);
}

// 現版の起動用キャッシュが不完全なら、従来どおり古い版を残す。
{
  const harness = createHarness();
  await harness.caches.open(shellCache);
  await harness.caches.open("fridge-leftovers-old");
  await harness.dispatchWait("activate");
  check("SHELL不足時は古いキャッシュを消さない",
    (await harness.caches.keys()).includes("fridge-leftovers-old"), true);
}

// 古い版に溜まったイラストを固定アセットキャッシュへ引き継いでから、古い版を消す。
{
  const harness = createHarness();
  await harness.dispatchWait("install");
  const illustrationUrl = new URL("./assets/ingredient-atlas-05.png?v=20260727-2", workerUrl).href;
  const oldCacheName = "fridge-leftovers-old";
  const oldCache = await harness.caches.open(oldCacheName);
  await oldCache.put(new harness.Request(illustrationUrl), new harness.Response("old illustration"));

  await harness.dispatchWait("activate");
  check("activateで古い版のイラストをASSET_CACHEへ引き継ぐ",
    (await harness.urls(assetCache)).includes(illustrationUrl), true);
  check("イラスト引き継ぎ後に古い版つきキャッシュを消す",
    (await harness.caches.keys()).includes(oldCacheName), false);
}

// ?v= だけが違う古いシェルは、固定アセットキャッシュへ引き継がない。
{
  const harness = createHarness();
  await harness.dispatchWait("install");
  const oldShellUrl = new URL("./app.js?v=ふるいハッシュ", workerUrl).href;
  const oldCache = await harness.caches.open("fridge-leftovers-old");
  await oldCache.put(new harness.Request(oldShellUrl), new harness.Response("old shell"));

  await harness.dispatchWait("activate");
  check("pathnameがSHELLと同じ旧版をASSET_CACHEへ引き継がない",
    (await harness.urls(assetCache)).includes(oldShellUrl), false);
}

// 固定アセットキャッシュに同じURLがあれば、古い版の内容で上書きしない。
{
  const harness = createHarness();
  await harness.dispatchWait("install");
  const illustrationUrl = new URL("./assets/ingredient-atlas-05.png?v=20260727-2", workerUrl).href;
  const asset = await harness.caches.open(assetCache);
  const oldCache = await harness.caches.open("fridge-leftovers-old");
  await asset.put(new harness.Request(illustrationUrl), new harness.Response("existing asset"));
  await oldCache.put(new harness.Request(illustrationUrl), new harness.Response("old asset"));

  await harness.dispatchWait("activate");
  check("ASSET_CACHEの同じURLを古い版の内容で上書きしない",
    (await asset.match(illustrationUrl)).body, "existing asset");
}

// fetch 経由で、シェルかどうかに応じた保存先を選ぶ。
{
  const harness = createHarness();
  const illustrationUrl = new URL("./assets/ingredient-atlas-05.png?v=20260727-2", workerUrl).href;
  const appPath = shellPaths.find((item) => item.startsWith("./app.js?v="));
  if (!appPath) throw new Error("REFERENCED に app.js がありません");
  const appUrl = new URL(appPath, workerUrl).href;

  await harness.dispatchFetch(new harness.Request(illustrationUrl, { destination: "image" }));
  await harness.dispatchFetch(new harness.Request(appUrl, { destination: "script" }));
  check("イラストをASSET_CACHEへ入れる",
    (await harness.urls(assetCache)).includes(illustrationUrl), true);
  check("SHELLのファイルをSHELL_CACHEへ入れる",
    (await harness.urls(shellCache)).includes(appUrl), true);
}

// 同じpathnameの旧版だけを、新版の保存直前に取り除く。
{
  const harness = createHarness();
  const oldUrl = new URL("./assets/ingredient-atlas-05.png?v=20260727-1", workerUrl).href;
  const newUrl = new URL("./assets/ingredient-atlas-05.png?v=20260727-2", workerUrl).href;
  const otherUrl = new URL("./assets/ingredient-atlas-06.png?v=20260727-1", workerUrl).href;
  const cache = await harness.caches.open(assetCache);
  await cache.put(new harness.Request(oldUrl), new harness.Response("old"));
  await cache.put(new harness.Request(otherUrl), new harness.Response("other"));

  await harness.dispatchFetch(new harness.Request(newUrl, { destination: "image" }));
  check("同じパスの古い?v=をASSET_CACHEから消す",
    (await harness.urls(assetCache)).sort(), [newUrl, otherUrl].sort());
}

console.log(failures
  ? `\n★${failures}件が期待と違います`
  : "Service Worker チェック: OK");
process.exit(failures ? 1 : 0);
