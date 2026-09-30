import { LocalFailure, type ChannelResponse } from "./exchange";
import { linkState, onLink, openRequest, type DirectRequest } from "./link";
import { pathOf } from "./transport";

// Direct downloads. The file arrives over the direct connection and is handed, piece by piece, to a
// service worker (public/local-sw.js) that serves it to a hidden frame as an ordinary download, so
// the browser saves it to disk as it arrives and shows its progress as usual. The browser's pace
// holds the worker, the worker's holds this page, and this page's holds the helper.
//
// Until the browser has taken the download, anything that goes wrong leaves nothing behind and the
// file is downloaded the usual way. After that, a direct connection that fails is replaced by the
// usual way from the byte it reached, the file's ETag making sure it is the same file.

const WORKER = "/local-sw.js";
const SCOPE = "/local/";
/** Bytes handed to the worker and not yet taken by the browser. */
const AHEAD_BYTES = 8 * 1024 ** 2;
/** How long the worker and the browser may take to accept a download before it goes the usual way. */
const START_MS = 10_000;
/**
 * Pings keep the worker running, and any newer version of it waiting, while it serves a download;
 * its own watch expects them.
 */
const PING_MS = 5_000;
/** Silence from the worker, once everything is handed over, after which the download is let go. */
const SETTLE_MS = 60_000;
/** Resumes in a row that fail without a byte arriving, after which the download fails. */
const RESUMES = 3;

let registering: Promise<ServiceWorkerRegistration> | null = null;
/** Downloads the browser hasn't finished taking from this page: leaving it would cut them off. */
let active = 0;

async function activeWorker(): Promise<ServiceWorker> {
  const registration = await (registering ??= navigator.serviceWorker
    .register(WORKER, { scope: SCOPE })
    .catch((error: unknown) => {
      registering = null;
      throw error;
    }));
  if (registration.active) return registration.active;
  const pending = registration.installing ?? registration.waiting;
  if (!pending) throw new Error("The download worker didn't install.");
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (pending.state === "activating" || pending.state === "activated") resolve();
      else if (pending.state === "redundant") reject(new Error("The download worker didn't install."));
    };
    pending.addEventListener("statechange", check);
    check();
  });
  return pending;
}

/** The worker's messages about one download. */
type WorkerMessage =
  { type: "registered" | "started" | "finished" | "failed" | "cancel" } | { type: "delivered"; bytes: number };

/**
 * Downloads `url` over the direct connection. False when it couldn't start; then nothing was
 * saved, and the caller downloads it the usual way.
 */
export async function downloadDirect(url: string): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const direct = openRequest();
  if (!direct) return false;
  let res: ChannelResponse;
  try {
    res = await direct.send({ method: "GET", path: pathOf(url) });
  } catch (error) {
    if (error instanceof LocalFailure) direct.failed();
    else direct.done();
    return false;
  }
  // Anything but the file (a 404, say) is left to the usual way, which shows it as it always has.
  if (res.status !== 200) {
    void res.body.cancel();
    if (res.status === 421) direct.failed();
    else direct.done();
    return false;
  }

  const id = crypto.randomUUID();
  const { port1: port, port2 } = new MessageChannel();
  const listeners = new Set<(message: WorkerMessage) => void>();
  port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => listeners.forEach((fn) => fn(data));
  const reply = (type: WorkerMessage["type"]) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listen);
        reject(new Error(`The download worker didn't answer ${type}.`));
      }, START_MS);
      const listen = (message: WorkerMessage) => {
        if (message.type !== type) return;
        clearTimeout(timer);
        listeners.delete(listen);
        resolve();
      };
      listeners.add(listen);
    });

  let frame: HTMLIFrameElement | null = null;
  let worker: ServiceWorker;
  try {
    worker = await activeWorker();
    const registered = reply("registered");
    worker.postMessage(
      {
        type: "download",
        id,
        headers: {
          disposition: attachment(res.headers.get("content-disposition")),
          length: res.headers.get("content-length") ?? "",
        },
      },
      [port2],
    );
    await registered;
    const started = reply("started");
    frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = `${SCOPE}download/${id}`;
    document.body.append(frame);
    await started;
  } catch {
    port.postMessage({ type: "stop" });
    port.close();
    frame?.remove();
    void res.body.cancel();
    direct.done();
    return false;
  }
  void feed({ url, res, direct, port, frame, worker, listeners });
  return true;
}

/** The server's disposition as an attachment: the frame must save the file, never show it. */
function attachment(disposition: string | null) {
  if (!disposition) return "attachment";
  return disposition.replace(/^\s*inline\b/i, "attachment");
}

async function feed({
  url,
  res,
  direct,
  port,
  frame,
  worker,
  listeners,
}: {
  url: string;
  res: ChannelResponse;
  direct: DirectRequest;
  port: MessagePort;
  frame: HTMLIFrameElement;
  worker: ServiceWorker;
  listeners: Set<(message: WorkerMessage) => void>;
}) {
  active++;
  const etag = res.headers.get("etag");
  const length = res.headers.has("content-length") ? Number(res.headers.get("content-length")) : null;
  let delivered = 0;
  let sent = 0;
  let cancelled = false;
  let wake: (() => void) | null = null;

  // The worker's watch expects to hear from this page, and the browser stops an idle worker.
  const ping = setInterval(() => {
    port.postMessage({ type: "ping" });
    worker.postMessage({ type: "ping" });
  }, PING_MS);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    active--;
    clearInterval(ping);
    clearTimeout(quiet);
    port.close();
    frame.remove();
  };
  listeners.add((message) => {
    if (message.type === "delivered") delivered = message.bytes;
    else if (message.type === "cancel") cancelled = true;
    // The browser has everything, or the download ended in it: nothing more to keep running.
    if (message.type === "finished" || message.type === "failed" || message.type === "cancel") settle();
    else if (quiet) {
      clearTimeout(quiet);
      quiet = setTimeout(settle, SETTLE_MS);
    }
    wake?.();
  });

  let reader = res.body.getReader();
  let channel: DirectRequest | null = direct;
  let resumes = 0;
  let outcome: "end" | "error" | "stop" = "end";
  try {
    for (;;) {
      while (!cancelled && sent - delivered >= AHEAD_BYTES) await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
      if (cancelled) {
        outcome = "stop";
        void reader.cancel();
        break;
      }
      let piece: ReadableStreamReadResult<Uint8Array>;
      try {
        piece = await reader.read();
        if (piece.done && length !== null && sent !== length) throw new Error("The download ended early.");
      } catch (error) {
        if (cancelled) continue;
        if (channel) {
          if (error instanceof LocalFailure) channel.failed();
          else channel.done();
          channel = null;
        }
        if (++resumes > RESUMES) throw error;
        void reader.cancel().catch(() => {});
        reader = await resume(url, sent, etag);
        continue;
      }
      if (piece.done) break;
      const bytes = own(piece.value);
      // Counted first: handing the buffer over empties it here.
      sent += bytes.byteLength;
      port.postMessage({ type: "piece", bytes }, [bytes]);
      resumes = 0;
    }
  } catch {
    outcome = "error";
  } finally {
    channel?.done();
    port.postMessage({ type: outcome });
    if (outcome === "stop") settle();
    // The worker still hands the browser what it holds; it reports when it's done.
    else if (!settled) quiet = setTimeout(settle, SETTLE_MS);
  }
}

/** The rest of the file from byte `from`, the usual way; only the same file (by its ETag) will do. */
async function resume(url: string, from: number, etag: string | null) {
  if (!etag) throw new Error("The download can't resume.");
  const res = await fetch(url, {
    headers: { Range: `bytes=${from}-`, "If-Range": etag },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status !== 206 || !res.body || !res.headers.get("content-range")?.startsWith(`bytes ${from}-`)) {
    void res.body?.cancel();
    throw new Error("The download can't resume.");
  }
  return res.body.getReader();
}

/** The piece's bytes as a buffer of their own, which can be handed over without copying. */
function own(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer)
    return view.buffer;
  return view.slice().buffer;
}

if (typeof window !== "undefined") {
  // Installed once this browser can go direct, so its first download doesn't wait for the worker.
  onLink(() => {
    if (linkState() === "ready" && "serviceWorker" in navigator) void activeWorker().catch(() => {});
  });
  window.addEventListener("beforeunload", (event) => {
    if (!active) return;
    event.preventDefault();
    // Older Safari and Chrome only warn when returnValue is set.
    event.returnValue = "";
  });
}
