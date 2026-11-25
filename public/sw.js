// Relay's service worker (registered by client/lib/pwa.ts). It does three things:
//
// 1. Keeps the app shell (index.html, the built scripts and styles, fonts and icons) so Relay opens
//    quickly and shows its own "can't reach Relay" screen when offline. It never stores API answers,
//    uploads, downloads, previews or anything else that belongs to an account: those always go to
//    the network, and on browsers that support it they skip this worker entirely.
// 2. Receives "Share to Relay" from the phone's share sheet (the manifest's share_target), keeps
//    what was shared in this browser's own storage, and opens /share, which shows it and adds it to
//    the Send draft only when the person chooses Add (a website can post the same form).
// 3. Shows push notifications (server/modules/push) and opens the right page when one is tapped.
//
// Updates: the browser fetches this file again on every visit (Relay serves it "no-cache"); a new
// version takes over at once and drops caches it doesn't know. Built assets have content hashes in
// their names, so an old page keeps working with the files it already has.

const SHELL = "relay-shell-1";
const SHELL_FILES = ["/", "/theme.js", "/favicon.svg", "/manifest.webmanifest", "/icon-192.png"];
const SHARE_DB = "relay-share";
/** Shares kept waiting for Add or Discard at once (a new one replaces the oldest), and for how long. */
const SHARES_WAITING = 5;
const SHARE_DAY = 24 * 3600 * 1000;
/** Paths that are never the app shell: they are the account's data and go straight to the network. */
const PRIVATE = ["/api/", "/uploads/", "/local/"];

self.addEventListener("install", (event) => {
  // Chrome's static routing skips this worker for data requests altogether (no startup cost).
  try {
    if (event.addRoutes && typeof URLPattern !== "undefined")
      event
        .addRoutes(
          PRIVATE.map((prefix) => ({
            condition: { urlPattern: new URLPattern({ pathname: `${prefix}*` }) },
            source: "network",
          })),
        )
        .catch(() => {});
  } catch {
    // Unsupported here; the fetch handler below leaves these requests alone instead.
  }
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL);
        await cache.addAll(SHELL_FILES);
        // The scripts and styles this index.html loads, so Relay opens offline after one visit.
        await cache.addAll(assetsOf(await (await cache.match("/")).text()));
      } catch {
        // Kept on the next visit instead.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name);
      await self.registration.navigationPreload?.enable().catch(() => {});
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === "POST" && url.pathname === "/share") return event.respondWith(receiveShare(event));
  if (request.method !== "GET" || PRIVATE.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") return event.respondWith(page(event));
  if (url.pathname.startsWith("/assets/") || SHELL_FILES.includes(url.pathname))
    return event.respondWith(shellFile(event, url));
});

/** Every page is the same index.html: from the network when possible, so updates show at once. */
async function page(event) {
  try {
    const response = (await event.preloadResponse) || (await fetch(event.request));
    if (response.ok && (response.headers.get("content-type") || "").startsWith("text/html"))
      event.waitUntil(keepShell(response.clone()));
    return response;
  } catch {
    const cache = await caches.open(SHELL);
    return (await cache.match("/")) || Response.error();
  }
}

/** The built files an index.html loads. */
const assetsOf = (html) => [...new Set([...html.matchAll(/\/assets\/[^"'\s)]+/g)].map((match) => match[0]))];

/** Stores a new index.html with the files it loads, and forgets built files it no longer uses. */
async function keepShell(response) {
  const cache = await caches.open(SHELL);
  const html = await response.clone().text();
  const previous = await cache.match("/");
  await cache.put("/", response);
  if (previous && (await previous.text()) === html) return;
  const used = new Set(assetsOf(html));
  await cache.addAll([...used]).catch(() => {});
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (/^\/assets\/.+-[\w-]{8,}\.\w+$/.test(path) && !used.has(path)) await cache.delete(key);
  }
}

/**
 * Built files (their names change with their content) come from the cache when there; the few
 * fixed-name files are refreshed in the background so a change shows on the next visit.
 */
async function shellFile(event, url) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(event.request);
  const hashed = /-[\w-]{8,}\.\w+$/.test(url.pathname);
  if (cached && hashed) return cached;
  const fresh = fetch(event.request).then(async (response) => {
    if (response.ok && response.type === "basic" && response.status === 200)
      await cache.put(event.request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(fresh.catch(() => {}));
    return cached;
  }
  return fresh;
}

// ---- Share to Relay ----

function shareStore(mode) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(SHARE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("shares", { keyPath: "id" });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result.transaction("shares", mode).objectStore("shares"));
  });
}

/**
 * What the share sheet sent waits in this browser's storage (never on the server) until the person
 * adds or discards it on /share (client/lib/pwa-share.ts), at most a day.
 */
async function receiveShare(event) {
  try {
    const form = await event.request.formData();
    const field = (name) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, 100_000) : "";
    };
    const files = form.getAll("files").filter((file) => typeof file !== "string" && (file.size > 0 || file.name));
    const share = {
      id: crypto.randomUUID(),
      created: Date.now(),
      title: field("title"),
      text: field("text"),
      url: field("url"),
      files,
    };
    const store = await shareStore("readwrite");
    await new Promise((resolve, reject) => {
      // Only the newest few wait, so a website posting this form over and over can't fill the
      // browser's storage, which Nearby saves received files in. Those older than a day go too.
      const all = store.getAll();
      all.onsuccess = () => {
        const waiting = all.result.sort((a, b) => b.created - a.created);
        for (const [i, old] of waiting.entries())
          if (i >= SHARES_WAITING - 1 || share.created - old.created > SHARE_DAY) store.delete(old.id);
        const put = store.put(share);
        put.onsuccess = resolve;
        put.onerror = () => reject(put.error);
      };
      all.onerror = () => reject(all.error);
    });
    return Response.redirect(`/share?id=${share.id}`, 303);
  } catch {
    return Response.redirect("/share?id=failed", 303);
  }
}

// ---- Notifications ----

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // An unreadable message still gets a plain notice below.
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const subscription = await self.registration.pushManager.getSubscription();
      // A Relay window in front already shows this (a popup, a toast, the bell). Safari requires a
      // notice for every push, so it always gets one.
      const apple = !!subscription && subscription.endpoint.includes(".push.apple.com");
      if (!apple && windows.some((w) => w.visibilityState === "visible" && w.focused)) {
        for (const w of windows) w.postMessage({ type: "relay-push", message });
        return;
      }
      await self.registration.showNotification(message.title || "Relay", {
        body: message.body || "Something new in Relay.",
        tag: message.tag || undefined,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: message.url || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only Relay's own pages, whatever the message said.
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.pathname + target.search : "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // The page moves itself, keeping anything in progress (a reload would lose a draft).
        open.postMessage({ type: "relay-open", url });
        return open.focus().catch(() => {});
      }
      return self.clients.openWindow(url);
    })(),
  );
});
