// ホーム画面から開いたときに、通信が無くても起動できるようにする。
//
// VERSION は scripts/cache-version.mjs が index.html・app.js・styles.css と
// このファイル自身の内容から書き込む。中身が変わればこのファイルも変わるので、
// ブラウザが新しい Service Worker と見なして入れ替え、古いキャッシュを捨てる。
// 手で番号を上げる必要はない。
const VERSION = "b8ce7748";
const SHELL_CACHE = `fridge-leftovers-${VERSION}`;
const ASSET_CACHE = "fridge-leftovers-assets";

// index.html が参照するファイル。?v= 付きの実物のパスでないとキャッシュに
// 入らないので、scripts/cache-version.mjs がここへ書き込む。手で直さない。
// ここから自動更新
const REFERENCED = [
  "./manifest.json?v=b750de2d",
  "./assets/icons/favicon-32.png?v=a1371f08",
  "./assets/icons/apple-touch-icon.png?v=0db390f0",
  "./styles.css?v=ec58aba3",
  "./recipe-expansion.js?v=3e0c5a6c",
  "./app.js?v=535bc3f7"
];
// ここまで自動更新

// 起動に必要なものだけ先に取る。app.js と styles.css は、これが無いと
// 画面が出ないので必ず含める（実測では、初回の読み込みは Service Worker が
// 制御を取る前に走ってしまい、あとから溜まる保証が無かった）。
//
// イラスト（28MB・styles.css から参照）とTesseract（21MB・vendor/）は
// 全部先に落とすと初回が重いので、使われたものだけ後から溜める。
// 起動用キャッシュと分けて長く残し、版が変わっても中身の変わらない
// イラストを捨てて取り直さない。
const SHELL = ["./", "./index.html", ...REFERENCED];
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.location.href).href));
const SHELL_PATHNAMES = new Set([...SHELL_URLS].map((url) => new URL(url).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // 全件を試すが、揃わなければ乗り換えず、不完全なキャッシュで古い版を捨てない
      .then(async (cache) => {
        const failed = [];
        await Promise.all(SHELL.map(async (path) => {
          try {
            await cache.add(path);
          } catch {
            failed.push(path);
            console.warn(`キャッシュへ追加できませんでした: ${path}`);
          }
        }));
        if (failed.length) {
          throw new Error(`起動用キャッシュが${failed.length}件不足しています`);
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const missing = (await Promise.all(
        SHELL.map(async (path) => await cache.match(path) ? null : path)
      )).filter(Boolean);
      if (missing.length) {
        console.warn(`起動用キャッシュが不足しているため古いキャッシュを残します: ${missing.join(", ")}`);
        return;
      }
      const keys = await caches.keys();
      const oldCacheNames = keys.filter(
        (key) => key.startsWith("fridge-leftovers-") && key !== SHELL_CACHE && key !== ASSET_CACHE
      );
      // 古い版に溜まっていたイラストを捨てず、固定アセットキャッシュへ引き継ぐ
      try {
        const assetCache = await caches.open(ASSET_CACHE);
        for (const cacheName of oldCacheNames) {
          const oldCache = await caches.open(cacheName);
          for (const request of await oldCache.keys()) {
            const url = new URL(request.url);
            if (SHELL_URLS.has(url.href) || SHELL_PATHNAMES.has(url.pathname)) continue;
            if (await assetCache.match(request)) continue;
            const response = await oldCache.match(request);
            if (response) await assetCache.put(request, response);
          }
        }
      } catch {
        console.warn("古い版に溜まっていたイラストを引き継げませんでした");
      }
      await Promise.all(
        oldCacheNames.map((key) => caches.delete(key))
      );
    })().finally(() => self.clients.claim())
  );
});

// 保存してよい応答か。他サイトのものや、エラー応答を溜めても意味がない。
function storable(response) {
  return response && response.ok && response.type === "basic";
}

// 画面そのもの（HTML）は、新しい版が出ていたら受け取りたいので通信を先に試す。
// 圏外なら取っておいた画面を返す。
async function html(request) {
  try {
    const response = await fetch(request);
    if (storable(response)) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put("./index.html", response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match("./index.html") || await caches.match("./");
    if (cached) return cached;
    throw new Error("画面を取り出せませんでした");
  }
}

// app.js・styles.css・イラスト・Tesseract は、内容が変わると ?v= も変わるので
// 溜めたものをそのまま使ってよい。無ければ取ってきて溜める。
async function asset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (storable(response)) {
    const cacheName = SHELL_URLS.has(request.url) ? SHELL_CACHE : ASSET_CACHE;
    const cache = await caches.open(cacheName);
    if (cacheName === ASSET_CACHE) {
      const requestUrl = new URL(request.url);
      const keys = await cache.keys();
      await Promise.all(
        keys.filter((key) => {
          const url = new URL(key.url);
          return url.pathname === requestUrl.pathname && url.href !== requestUrl.href;
        }).map((key) => cache.delete(key))
      );
    }
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // destination も見るのは、画面を JavaScript から取りに行った場合に
  // 溜めた古い画面を返してしまわないようにするため
  const wantsPage = request.mode === "navigate" || request.destination === "document";
  event.respondWith(wantsPage ? html(request) : asset(request));
});
