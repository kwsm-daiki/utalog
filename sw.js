// Utalog の Service Worker（オフラインで動かすため）
// 中身を変えたら VERSION を上げる（index.html の ?v= と app.js の BUILD も合わせる）
// 同じオリジン（<ユーザー名>.github.io）に歌詞ビンゴ・Nudge もあるので、触るキャッシュは "utalog-" で始まるものだけ。
// 画像のキャッシュ（utalog-img）は app.js が使うので消さない
const VERSION = "v1";
const PREFIX = "utalog-";
const CACHE = PREFIX + VERSION;
const KEEP = [CACHE, "utalog-img"];
const FILES = [
  "./",
  "./index.html",
  "./style.css?v=1",
  "./app.js?v=1",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg"
];
const SCOPE = new URL("./", self.location).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function keep(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // api.github.com には触らない
  if (!url.pathname.startsWith(SCOPE)) return;
  if (url.pathname.startsWith(SCOPE + "img/")) return; // 画像は app.js が Cache Storage から直接読む

  // ページを開く: まずネット。3秒で返事がない・失敗したら保存してある版
  if (req.mode === "navigate") {
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const fromCache = () => caches.match("./index.html", { ignoreSearch: true });
      const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
      const net = fetch(req.url, { cache: "no-cache" }).then((res) => keep("./index.html", res));
      const timer = setTimeout(() => { fromCache().then(finish); }, 3000);
      net.then((res) => { clearTimeout(timer); finish(res); })
        .catch(() => { clearTimeout(timer); fromCache().then((c) => finish(c || Response.error())); });
    }));
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res)))
  );
});
