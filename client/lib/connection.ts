import { useSyncExternalStore } from "react";
import { api } from "../../shared/api";

/**
 * Whether this tab can talk to Relay and, when it can't, whose side the problem is on.
 *
 * - `ok`: Relay answers.
 * - `checking`: something just failed in a way the connection could explain. A health check decides;
 *   work carries on meanwhile, so a single blip never shows as an outage.
 * - `offline`: the browser has no network at all.
 * - `no-network`: the browser has a network, but nothing got through to Relay's address (Wi‑Fi
 *   without internet, a sign-in portal, DNS). Relay is normally reached through a reverse proxy
 *   (Vite in development) that answers even when Relay itself is down, so a request that gets no
 *   answer at all points at this side of the connection.
 * - `down`: the proxy in front of Relay answered, so this device's internet works, but Relay did not.
 */
export type ConnectionState = "ok" | "checking" | "offline" | "no-network" | "down";

export type Connection = {
  state: ConnectionState;
  /** When the current problem began, for "since 2 min". */
  since: number | null;
  /** When the next automatic check runs, while there is a problem. */
  retryAt: number | null;
  /** A check is in flight. */
  probing: boolean;
  /** What was wrong just before the connection came back, for a moment after it did. */
  recovered: Exclude<ConnectionState, "ok" | "checking"> | null;
};

/** How long "Back online" stays after the connection returns. */
const RECOVERED_MS = 3000;
/** Waits between automatic checks while Relay can't be reached. */
const BACKOFF = [2000, 4000, 8000, 15_000];
/** A health check that takes longer than this counts as no answer. */
const PROBE_TIMEOUT = 8000;

const browserOnline = () => typeof navigator === "undefined" || navigator.onLine;

let current: Connection = {
  state: browserOnline() ? "ok" : "offline",
  since: browserOnline() ? null : Date.now(),
  retryAt: null,
  probing: false,
  recovered: null,
};
const listeners = new Set<() => void>();
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let recoveredTimer: ReturnType<typeof setTimeout> | undefined;
let probeRun = 0;
/** When a check last found Relay fine. */
let lastFine = 0;
/** After a check finds Relay fine, how long further failures are left to their own retries. */
const RECHECK_MS = 5000;

function set(next: Partial<Connection>) {
  const before = current;
  current = { ...current, ...next };
  if (before.state !== current.state && current.state === "ok" && before.state !== "checking") {
    current.recovered = before.state as Connection["recovered"];
    clearTimeout(recoveredTimer);
    recoveredTimer = setTimeout(() => set({ recovered: null }), RECOVERED_MS);
  } else if (current.state !== "ok") {
    clearTimeout(recoveredTimer);
    current.recovered = null;
  }
  listeners.forEach((fn) => fn());
}

/** Everything a view needs to say what's happening; replaced (never mutated) on each change. */
export const connection = () => current;
export function onConnectivity(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const useConnection = () => useSyncExternalStore(onConnectivity, connection);

/** Relay can be talked to, or may well be: a check in progress doesn't stop anything yet. */
export const isOnline = () => current.state === "ok" || current.state === "checking";
export const useOnline = () => useSyncExternalStore(onConnectivity, isOnline);
/** Resolves once Relay can be talked to again. */
export function whenOnline() {
  return new Promise<void>((resolve) => {
    if (isOnline()) return resolve();
    const off = onConnectivity(() => {
      if (!isOnline()) return;
      off();
      resolve();
    });
  });
}
/** Resolves once a check in progress has decided, so a retry doesn't race it. */
export function whenSettled() {
  return new Promise<void>((resolve) => {
    if (current.state !== "checking") return resolve();
    const off = onConnectivity(() => {
      if (current.state === "checking") return;
      off();
      resolve();
    });
  });
}

/** Asks Relay's health endpoint, and reads the way it fails as whose side the problem is on. */
async function diagnose(): Promise<Exclude<ConnectionState, "checking">> {
  if (!browserOnline()) return "offline";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const res = await fetch(api.health.path, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    // A network that makes you sign in first answers every address with its own page.
    if (res.redirected && new URL(res.url).origin !== location.origin) return "no-network";
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && body?.ok === true ? "ok" : "down";
  } catch {
    return browserOnline() ? "no-network" : "offline";
  } finally {
    clearTimeout(timeout);
  }
}

async function probe() {
  clearTimeout(timer);
  timer = undefined;
  const run = ++probeRun;
  set({ probing: true, retryAt: null });
  const result = await diagnose();
  if (run !== probeRun) return;
  if (result === "ok") {
    attempt = 0;
    lastFine = Date.now();
    set({ state: "ok", since: null, retryAt: null, probing: false });
    return;
  }
  const wasFine = current.state === "ok" || current.state === "checking";
  // Offline, the browser says when it's back; there is nothing to poll.
  const wait = result === "offline" ? null : BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
  set({
    state: result,
    since: wasFine ? Date.now() : current.since,
    probing: false,
    retryAt: wait === null ? null : Date.now() + wait,
  });
  if (wait !== null) timer = setTimeout(() => void probe(), wait);
}

/**
 * A request failed in a way the connection could explain (no answer, or a proxy's error page).
 * Checks once; an outage already known is being checked on its own schedule.
 */
export function reportFailure() {
  // Relay was just found fine: a stream reconnecting or a request cut short shouldn't ask again at once.
  if (current.state !== "ok" || Date.now() - lastFine < RECHECK_MS) return;
  set({ state: "checking" });
  void probe();
}

/** Relay itself answered, so whatever was wrong has passed. */
export function reportReachable() {
  if (current.state === "ok") return;
  // A check still in flight would only repeat what this answer already says.
  probeRun++;
  clearTimeout(timer);
  timer = undefined;
  attempt = 0;
  set({ state: "ok", since: null, retryAt: null, probing: false });
}

/** "Try now": checks at once instead of waiting for the next automatic check. */
export function retryNow() {
  if (current.state === "ok" || current.probing) return;
  attempt = Math.max(0, attempt - 1);
  void probe();
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => {
    probeRun++;
    clearTimeout(timer);
    timer = undefined;
    set({
      state: "offline",
      since: current.state === "ok" || current.state === "checking" ? Date.now() : current.since,
      retryAt: null,
      probing: false,
    });
  });
  // Back on a network isn't the same as reaching Relay: check before saying so.
  window.addEventListener("online", () => {
    attempt = 0;
    void probe();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && current.state !== "ok" && current.state !== "offline" && !current.probing) void probe();
  });
}

/** A response that says Relay's proxy answered and Relay didn't: its error page, or a gateway status. */
export const isProxyFailure = (status: number) =>
  status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
