// Saves direct downloads (see client/lib/local/download.ts). The page receives a file over the
// direct connection and hands it here piece by piece; this worker serves it to a hidden frame as an
// ordinary download, so the browser writes it to disk as it arrives, whatever its size. It controls
// only /local/ and serves nothing but the downloads a page has handed it.

/** Silence from the page while the browser waits for bytes, after which the download fails. */
const SILENCE_MS = 30_000;
/**
 * How long each message from a page holds off a newer version of this worker while it serves
 * downloads; the page sends one every few seconds until the browser has taken the download.
 */
const HOLD_MS = 15_000;

/** @type {Map<string, Download>} */
const downloads = new Map();

/**
 * @typedef {{
 *   port: MessagePort,
 *   headers: Record<string, string>,
 *   pieces: ArrayBuffer[],
 *   ended: boolean,
 *   failed: boolean,
 *   started: boolean,
 *   delivered: number,
 *   wake: (() => void) | null,
 * }} Download
 */

// A newer version of this worker (after an upgrade, found when a download's frame loads) takes over
// only once no download depends on this one: taking over cuts off the downloads it is serving. So
// there is no skipWaiting, and while downloads are under way every message from their pages extends
// one of this worker's events, which keeps the newer version waiting.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (downloads.size || data?.type === "download")
    event.waitUntil(new Promise((resolve) => setTimeout(resolve, HOLD_MS)));
  // Anything else (the page's pings) needs no answer: receiving it keeps this worker running.
  if (data?.type !== "download" || typeof data.id !== "string" || !event.ports[0]) return;
  const port = event.ports[0];
  /** @type {Download} */
  const download = {
    port,
    headers: data.headers,
    pieces: [],
    ended: false,
    failed: false,
    started: false,
    delivered: 0,
    wake: null,
  };
  downloads.set(data.id, download);
  port.onmessage = ({ data: message }) => {
    if (message.type === "piece") download.pieces.push(message.bytes);
    else if (message.type === "end") download.ended = true;
    else if (message.type === "error") download.failed = true;
    else if (message.type === "stop") {
      // The page gave up on it, or the browser cancelled it: a body still being read ends in failure.
      download.failed = true;
      downloads.delete(data.id);
    }
    // Every message, pings included, shows the page is still there.
    download.wake?.();
  };
  port.postMessage({ type: "registered" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = /^\/local\/download\/([\w-]+)$/.exec(url.pathname);
  if (!match) return;
  const id = match[1];
  const download = downloads.get(id);
  if (!download || download.started) {
    event.respondWith(new Response("Not found.", { status: 404 }));
    return;
  }
  download.started = true;
  const finish = () => {
    downloads.delete(id);
    download.port.close();
  };

  // Pulled only as the browser writes, so `delivered` is what it has taken, and the page sends more
  // only as it goes.
  const body = new ReadableStream(
    {
      async pull(controller) {
        for (;;) {
          if (download.failed) {
            controller.error(new Error("The download failed."));
            download.port.postMessage({ type: "failed" });
            return finish();
          }
          const piece = download.pieces.shift();
          if (piece) {
            controller.enqueue(new Uint8Array(piece));
            download.delivered += piece.byteLength;
            download.port.postMessage({ type: "delivered", bytes: download.delivered });
            return;
          }
          if (download.ended) {
            controller.close();
            download.port.postMessage({ type: "finished" });
            return finish();
          }
          const heard = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), SILENCE_MS);
            download.wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          download.wake = null;
          // The page is gone (closed, or crashed): fail rather than wait forever.
          if (!heard) download.failed = true;
        }
      },
      // Cancelled in the browser's downloads.
      cancel() {
        download.port.postMessage({ type: "cancel" });
        finish();
      },
    },
    { highWaterMark: 0 },
  );

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": download.headers.disposition,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "no-store",
  });
  if (download.headers.length) headers.set("Content-Length", download.headers.length);
  event.respondWith(new Response(body, { headers }));
  // From here the download is the browser's: it may ask first, and saves or cancels it.
  download.port.postMessage({ type: "started" });
});
