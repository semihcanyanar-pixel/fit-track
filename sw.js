// Fit Track – basit çevrimdışı önbellek (sayfa önce ağdan, 4 sn içinde gelmezse önbellekten)
const CACHE = "fittrack-v32";
const FILES = ["./", "index.html", "manifest.json", "icon-180.png", "icon-512.png"];
const NET_TIMEOUT = 4000;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(handle(e, req));
});

async function handle(e, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  // Her açılışta sunucuya "değişti mi?" diye sor (HTTP önbelleğindeki eski sürüme takılma)
  const net = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
    // Yalnızca tam ve başarılı yanıtlar önbelleğe girer; 404/5xx iyi kopyanın üstüne yazılmaz
    if (res.ok && res.status === 200) e.waitUntil(cache.put(req, res.clone()));
    return res;
  });
  net.catch(() => {});   // zaman aşımından sonra gelen hata yakalanmamış kalmasın
  try {
    if (!cached) return await net;
    const res = await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), NET_TIMEOUT))]);
    return res.status >= 500 ? cached : res;
  } catch (err) {
    return cached || (req.mode === "navigate" ? await cache.match("index.html") : null) || Response.error();
  }
}
