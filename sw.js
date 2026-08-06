// ホーム画面から開いたときに、通信が無くても起動できるようにする。
//
// VERSION は scripts/cache-version.mjs が index.html・app.js・styles.css と
// このファイル自身の内容から書き込む。中身が変わればこのファイルも変わるので、
// ブラウザが新しい Service Worker と見なして入れ替え、古いキャッシュを捨てる。
// 手で番号を上げる必要はない。
const VERSION = "3e78d965";
const CACHE = `fridge-leftovers-${VERSION}`;

// index.html が参照するファイル。?v= 付きの実物のパスでないとキャッシュに
// 入らないので、scripts/cache-version.mjs がここへ書き込む。手で直さない。
// ここから自動更新
const REFERENCED = [
  "./manifest.json?v=b750de2d",
  "./assets/icons/favicon-32.png?v=a1371f08",
  "./assets/icons/apple-touch-icon.png?v=0db390f0",
  "./styles.css?v=85b2d06c",
  "./app.js?v=673cba56"
];
// ここまで自動更新

// 起動に必要なものだけ先に取る。app.js と styles.css は、これが無いと
// 画面が出ないので必ず含める（実測では、初回の読み込みは Service Worker が
// 制御を取る前に走ってしまい、あとから溜まる保証が無かった）。
//
// イラスト（14MB・styles.css から参照）とTesseract（21MB・vendor/）は
// 全部先に落とすと初回が重いので、使われたものだけ後から溜める。
const SHELL = ["./", "./index.html", ...REFERENCED];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 1つ落ちても残りは入れたいので addAll は使わない
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("fridge-leftovers-") && key !== CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
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
      const cache = await caches.open(CACHE);
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
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
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
