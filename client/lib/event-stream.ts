import type { ChangeStamp, StreamLimited, StreamReady } from "../../shared/model.ts";

type Options = {
  /** With where changes stood when the stream opened, if the server said. */
  ready?: (changes?: ChangeStamp) => void;
  change?: (event: MessageEvent<string>) => void;
  /** Nearby's signals and notices; see shared/nearby.ts. */
  nearby?: (event: MessageEvent<string>) => void;
  limited?: () => void;
  ended?: (event: MessageEvent<string>) => void;
  failed?: () => void;
};

const BROWSER_KEY = "relay.stream-browser";
const validBrowser = (value: string | null) => value !== null && /^[a-f0-9]{32}$/.test(value);

/** Shared admission only, never authentication. getRandomValues also works on HTTP LAN origins. */
function browserId(): string | null {
  try {
    const stored = localStorage.getItem(BROWSER_KEY);
    if (validBrowser(stored)) return stored;
    const id = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    localStorage.setItem(BROWSER_KEY, id);
    // Another tab can win initialization between our read and write; always use the current value.
    const current = localStorage.getItem(BROWSER_KEY);
    return validBrowser(current) ? current : null;
  } catch {
    // The server turns these into short lease probes, leaving sockets free for normal requests.
    return null;
  }
}

/** Own every reconnect, including browsers' CONNECTING errors, so there is only one retry clock. */
export function eventStream(url: string, options: Options = {}) {
  let source: EventSource | undefined;
  let cleanup: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let limited = false;
  let delay = 1000;
  let browser = browserId();

  const closeSource = () => {
    cleanup?.();
    cleanup = undefined;
    source = undefined;
  };
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    retry = undefined;
    closeSource();
    globalThis.removeEventListener?.("storage", storageChanged);
  };
  const schedule = (wait?: number) => {
    closeSource();
    if (stopped || retry) return;
    limited = wait !== undefined;
    const next = wait ?? delay;
    if (!limited) delay = Math.min(delay * 2, 30_000);
    // Desynchronize tabs after an outage, without exceeding the maximum network retry delay.
    const jittered = Math.min(limited ? 60_000 : 30_000, next * (1 + Math.random() * 0.2));
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, jittered);
  };
  const connect = () => {
    if (stopped || source || retry) return;
    limited = false;
    let current: EventSource;
    try {
      browser = browserId();
      current = new EventSource(browser ? `${url}${url.includes("?") ? "&" : "?"}browser=${browser}` : url);
    } catch {
      schedule();
      options.failed?.();
      return;
    }
    source = current;
    let beatMs = 20_000;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !stopped && source === current;
    const failed = () => {
      if (!valid()) return;
      schedule();
      options.failed?.();
    };
    const heard = () => {
      clearTimeout(silence);
      silence = setTimeout(failed, beatMs * 2.5);
    };
    const ready = (event: Event) => {
      if (!valid()) return;
      let changes: ChangeStamp | undefined;
      try {
        const sent = JSON.parse((event as MessageEvent<string>).data) as Partial<StreamReady>;
        const beat = sent.beatMs ?? NaN;
        if (Number.isFinite(beat) && beat > 0) beatMs = Math.min(20_000, Math.max(100, beat));
        if (typeof sent.changes === "string") changes = sent.changes;
      } catch {
        /* Keep the default cadence, and load every view again. */
      }
      heard();
      // A ready-then-close loop is still unhealthy; only a subsequent beat resets backoff.
      options.ready?.(changes);
    };
    const beat = () => {
      if (!valid()) return;
      delay = 1000;
      heard();
    };
    const change = (event: Event) => {
      if (!valid()) return;
      heard();
      options.change?.(event as MessageEvent<string>);
    };
    const nearby = (event: Event) => {
      if (!valid()) return;
      heard();
      options.nearby?.(event as MessageEvent<string>);
    };
    const capacity = (event: Event) => {
      if (!valid()) return;
      let wait = 20_000;
      try {
        const sent = (JSON.parse((event as MessageEvent<string>).data) as StreamLimited).retryMs;
        if (Number.isFinite(sent) && sent > 0) wait = Math.min(50_000, Math.max(100, sent));
      } catch {
        /* A malformed response must not create a tight retry loop. */
      }
      schedule(wait);
      options.limited?.();
    };
    const ended = (event: Event) => {
      if (!valid()) return;
      stop();
      options.ended?.(event as MessageEvent<string>);
    };
    const handlers = { ready, beat, change, nearby, limited: capacity, ended, error: failed };
    for (const [name, handler] of Object.entries(handlers)) current.addEventListener(name, handler);
    cleanup = () => {
      clearTimeout(silence);
      for (const [name, handler] of Object.entries(handlers)) current.removeEventListener(name, handler);
      current.close();
    };
    heard();
  };
  const storageChanged = (event: StorageEvent) => {
    if (stopped || (event.key !== BROWSER_KEY && event.key !== null)) return;
    // Storage events can be stale. Reading the winner converges concurrent first tabs and avoids
    // bouncing between IDs while their six HTTP/1 sockets are needed by normal requests.
    const current = browserId();
    if (current === browser) return;
    browser = current;
    clearTimeout(retry);
    retry = undefined;
    schedule(1000);
  };
  globalThis.addEventListener?.("storage", storageChanged);
  connect();
  return {
    close: stop,
    /** Network recovery can shorten failure backoff, but must respect a server capacity delay. */
    retryNow() {
      if (stopped || limited || !retry) return;
      clearTimeout(retry);
      retry = undefined;
      connect();
    },
  };
}
