const CACHE = "wilco-v3";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

// SELF-DESTRUCT on non-canonical origins. A SW installed against an old Vercel
// alias (e.g. fortis-ten.vercel.app) keeps serving cached code and phoning home
// long after the alias is retired. If this script ever activates anywhere but the
// canonical production host, it unregisters itself and wipes its caches so the
// stale install cleans up and future loads follow the redirect to the real host.
// localhost is exempt so local dev/PWA testing is unaffected.
const CANONICAL_HOST = "app.trainwilco.com";
const IS_CANONICAL =
  self.location.hostname === CANONICAL_HOST ||
  self.location.hostname === "localhost" ||
  self.location.hostname === "127.0.0.1";

if (!IS_CANONICAL) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", e => {
    e.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.registration.unregister();
      const clientList = await self.clients.matchAll({ type: "window" });
      clientList.forEach(c => c.navigate(c.url).catch(() => {}));
    })());
  });
} else {

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Offline strategy: the app shell alone isn't enough — index.html references a
// HASHED bundle under /assets/, so unless those files are cached too, an offline
// open loads the shell and then dies on the missing script. Hashed assets are
// immutable → cache-first; navigations stay network-first (so deploys show up
// immediately) with the cached shell as the offline fallback; everything else
// same-origin is network-first with cache fallback. API calls are never cached.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // fonts/Stripe: browser cache handles these
  if (url.pathname.startsWith("/api/")) return;       // live data only, never from cache

  // Immutable hashed build assets: serve from cache, fetch+store on first miss.
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Navigations: network-first (fresh deploys), keep the latest shell cached,
  // fall back to the cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/", copy)); }
        return res;
      }).catch(() => caches.match("/"))
    );
    return;
  }

  // Icons, manifest, misc static: network-first with cache fallback.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req))
  );
});

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────
self.addEventListener("push", e => {
  let data = { title: "WILCO", body: "Your Proof Feed is ready.", url: "/" };
  if (e.data) {
    try { data = { ...data, ...JSON.parse(e.data.text()) }; } catch (_) {}
  }
  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "wilco-proof-feed",
    renotify: true,
    data: { url: data.url || "/" },
    actions: [{ action: "open", title: "View Now" }],
  };
  e.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) { client.focus(); return; }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

} // end canonical-host handlers (see SELF-DESTRUCT guard above)
