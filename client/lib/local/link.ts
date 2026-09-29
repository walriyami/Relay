import { useSyncExternalStore } from "react";
import { api, call } from "../../api";
import { getLocalPrefs, setLocalPrefs, subscribeLocalPrefs } from "../local-prefs";
import { exchange, LocalFailure, opened } from "./channel";

// The direct connection: this tab's WebRTC connection to the relay-local helper on Relay's own
// network, set up through Relay (see shared/local.ts). It is tried whenever Relay offers it and is
// ready only once a request has made the whole trip, so a browser elsewhere never routes anything
// to it. Uploads and downloads use it while it is ready and switched on, and fall back the usual
// way at the first sign of trouble.
//
// - `off`: Relay doesn't offer direct transfers, or no one is signed in.
// - `connecting`: trying now.
// - `ready`: requests can go direct.
// - `unavailable`: not connected (usually: not on Relay's network); another try follows later.
export type LinkState = "off" | "connecting" | "ready" | "unavailable";

/** A browser on Relay's network connects in well under a second; anywhere else, it never does. */
const CONNECT_TIMEOUT_MS = 8000;
/** Waits after tries that failed, or connections that dropped, in a row. */
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
/** A hidden tab lets its connection go after this long, so idle tabs don't hold the helper's. */
const HIDDEN_MS = 60_000;

let state: LinkState = "off";
let wanted = false;
let pc: RTCPeerConnection | null = null;
/** Each try's number; a newer one (or stopping) makes an older one's results irrelevant. */
let run = 0;
/** Tries that failed in a row. */
let failures = 0;
/**
 * Connections lost in a row without a request finishing on them. The first is retried at once; a
 * connection that keeps coming up only to fail real transfers backs off like a failed try.
 */
let drops = 0;
/** When the next try is due, while unavailable. */
let due = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let sleep: ReturnType<typeof setTimeout> | undefined;
/** Requests on the connection now; a hidden tab keeps it while any are running. */
let busy = 0;
const listeners = new Set<() => void>();

function set(next: LinkState) {
  if (state === next) return;
  state = next;
  listeners.forEach((fn) => fn());
}

export const linkState = () => state;
/** Whether a request may go direct now. */
export const isDirect = () => state === "ready" && getLocalPrefs().direct;
export function onLink(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function useLink() {
  const current = useSyncExternalStore(onLink, linkState);
  const enabled = useSyncExternalStore(subscribeLocalPrefs, () => getLocalPrefs().direct);
  return { state: current, enabled, setEnabled: (direct: boolean) => setLocalPrefs({ direct }) };
}

/** Starts connecting: someone is signed in and Relay offers direct transfers. */
export function startLink() {
  if (wanted) return;
  wanted = true;
  failures = drops = 0;
  void connect();
}
/** Signed out, or Relay stopped offering it: nothing more goes direct. */
export function stopLink() {
  wanted = false;
  run++;
  clearTimeout(retry);
  clearTimeout(sleep);
  teardown();
  set("off");
}

function teardown() {
  const old = pc;
  pc = null;
  if (!old) return;
  old.onconnectionstatechange = null;
  old.close();
}

/** Not connected; the next try runs `ms` from now, once the tab is visible. */
function unavailable(ms: number) {
  teardown();
  set("unavailable");
  due = Date.now() + ms;
  arm();
}
function arm() {
  clearTimeout(retry);
  if (wanted && state === "unavailable" && !document.hidden)
    retry = setTimeout(() => void connect(), Math.max(0, due - Date.now()));
}
const backoff = (n: number) => BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];

async function connect() {
  clearTimeout(retry);
  if (!wanted || state === "connecting" || state === "ready") return;
  const current = ++run;
  set("connecting");
  const next = new RTCPeerConnection({ iceServers: [] });
  pc = next;
  try {
    const check = next.createDataChannel("relay");
    // No candidates to wait for: the helper finds this browser from its connection checks.
    await next.setLocalDescription(await next.createOffer());
    const { answer } = await call(api.local.connect, { body: { offer: next.localDescription!.sdp } });
    if (current !== run) return;
    await next.setRemoteDescription({ type: "answer", sdp: answer });
    await opened(check, CONNECT_TIMEOUT_MS);
    // The connection is up; one request making the whole trip proves it reaches this Relay as this member.
    const res = await exchange(check, { method: "GET", path: api.local.check.path });
    await res.body.cancel();
    if (res.status !== 200) throw new LocalFailure(`The direct connection answered ${res.status}.`);
    if (current !== run) return;
    next.onconnectionstatechange = () => {
      const now = next.connectionState;
      // Losing it for a moment is losing it: requests fall back, and the next try follows.
      if (pc === next && (now === "disconnected" || now === "failed" || now === "closed")) lost();
    };
    failures = 0;
    set("ready");
    if (document.hidden) scheduleSleep();
  } catch {
    if (current !== run) return;
    unavailable(backoff(failures++));
  }
}

function lost() {
  if (state !== "ready") return;
  unavailable(drops++ ? backoff(drops - 2) : 0);
}

export type DirectChannel = {
  channel: RTCDataChannel;
  /** The request finished; the connection works. */
  done: () => void;
  /** The request failed on the connection, which is then dropped. */
  failed: () => void;
};
/** A new channel on the connection for one request, or null when requests can't go direct. */
export function openChannel(): DirectChannel | null {
  if (!isDirect() || !pc) return null;
  const owner = pc;
  const channel = owner.createDataChannel("request");
  busy++;
  let finished = false;
  const finish = () => {
    if (finished) return false;
    finished = true;
    busy--;
    if (document.hidden && pc === owner) scheduleSleep();
    return true;
  };
  return {
    channel,
    done: () => {
      if (finish() && pc === owner) drops = 0;
    },
    failed: () => {
      if (finish() && pc === owner) lost();
    },
  };
}

function scheduleSleep() {
  clearTimeout(sleep);
  sleep = setTimeout(() => {
    if (!document.hidden || busy || state !== "ready") return;
    run++;
    // Waking tries at once.
    unavailable(0);
  }, HIDDEN_MS);
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!wanted) return;
    if (document.hidden) {
      clearTimeout(retry);
      if (state === "ready") scheduleSleep();
    } else {
      clearTimeout(sleep);
      arm();
    }
  });
  // Joining a network (it may be Relay's) tries at once; a connection that is up tells for itself
  // when it breaks.
  const tryNow = () => {
    if (state !== "unavailable") return;
    failures = drops = 0;
    due = Date.now();
    arm();
  };
  window.addEventListener("online", tryNow);
  // Switching direct transfers back on tries again rather than waiting out the backoff.
  let direct = getLocalPrefs().direct;
  subscribeLocalPrefs(() => {
    if (direct === getLocalPrefs().direct) return;
    direct = getLocalPrefs().direct;
    if (direct) tryNow();
  });
}
