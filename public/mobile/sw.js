// Only public app code is persisted. Never cache APIs, terminal data or credentials.
const APP_VERSION = "1.18.6";
const APP_CACHE = `harbor-mobile-shell-${APP_VERSION}`;
const publicAsset = (path) =>
  /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|svg|png)$/.test(path) ||
  path === "/mobile/icon.png";
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      const shell = await fetch("/mobile/", {
        cache: "reload",
        credentials: "omit",
      });
      if (!shell.ok) throw new Error("App shell unavailable");
      const html = await shell.clone().text();
      const files = [
        ...new Set(
          [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(
            (match) => match[1],
          ),
        ),
      ].filter(publicAsset);
      await Promise.all(
        files.map(async (file) => {
          const response = await fetch(file, { credentials: "omit" });
          if (!response.ok) throw new Error("App asset unavailable");
          await cache.put(file, response);
        }),
      );
      await cache.put("/mobile/", shell);
      await self.skipWaiting();
    })(),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("harbor-mobile-shell-") && key !== APP_CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const shell = request.mode === "navigate" && url.pathname === "/mobile/";
  if (!shell && !publicAsset(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(APP_CACHE),
        key = shell ? "/mobile/" : url.pathname;
      const saved = await cache.match(key);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok && response.type !== "opaque")
        await cache.put(key, response.clone());
      return response;
    })(),
  );
});
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  if (!data) return;
  const url =
    typeof data.url === "string" && /^\/mobile\/(?:\?|$)/.test(data.url)
      ? data.url
      : "/mobile/";
  event.waitUntil(
    self.registration.showNotification(String(data.title || "Harbor"), {
      body: String(data.body || "세션을 확인하세요."),
      ...(typeof data.tag === "string" ? { tag: data.tag.slice(0, 80) } : {}),
      icon: "/mobile/icon.png",
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.url || "/mobile/",
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients)
          if (client.url.startsWith(self.location.origin + "/mobile/")) {
            client.postMessage({ type: "harbor-open", url });
            return client.focus();
          }
        return self.clients.openWindow(url);
      }),
  );
});
