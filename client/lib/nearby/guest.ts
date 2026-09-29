import { useSyncExternalStore } from "react";
import { ApiError, api, guestCall, urls } from "../../api";
import type { DeviceKind, SessionEnded } from "../../../shared/model";
import type { NearbyEvent, NearbyGuestState } from "../../../shared/nearby";
import { coalesce } from "../coalesce";
import { eventStream } from "../event-stream";
import { clearEngine, receiveSignal, setDirectory, startEngine, stopEngine } from "./engine";

// Someone without an account, on a member's Nearby link. They give a name, and while the page is
// open their stream makes them present to the member's devices, and the engine runs for them.

export type GuestPhase =
  | "loading"
  /** The link works; they haven't given a name yet (or left). */
  | "join"
  /** Joined: the engine runs while the stream is open. */
  | "joined"
  /** This browser's other tab has the link open; this one stepped aside. */
  | "elsewhere"
  /** The code ended, or the member removed them. */
  | "ended"
  /** The link doesn't work, or Relay couldn't be reached at first. */
  | "failed";

export type Guest = {
  phase: GuestPhase;
  info: NearbyGuestState | null;
  /** Relay can reach this page now: sending can start, and others see this guest. */
  connected: boolean;
  /** For `ended` and `failed`: what to say. */
  message: string;
};

let guest: Guest = { phase: "loading", info: null, connected: false, message: "" };
const listeners = new Set<() => void>();
function set(next: Partial<Guest>) {
  guest = { ...guest, ...next };
  listeners.forEach((fn) => fn());
}
export function useGuest() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => guest,
  );
}

type Running = { token: string; stream?: ReturnType<typeof eventStream>; refresh: ReturnType<typeof coalesce> };
let running: Running | null = null;

/** Opens the link `token`: shows who it belongs to, and carries on if this browser joined already. */
export function startGuest(token: string) {
  if (running?.token === token) return;
  stopGuest();
  const r: Running = { token, refresh: coalesce(() => load(r), { delay: 150, interval: 1000 }) };
  running = r;
  set({ phase: "loading", info: null, connected: false, message: "" });
  void r.refresh.request(true).catch(() => {});
}

export function stopGuest() {
  const r = running;
  if (!r) return;
  running = null;
  r.refresh.cancel();
  r.stream?.close();
  clearEngine();
}

async function load(r: Running) {
  try {
    const info = await guestCall(api.nearby.guest, { params: { token: r.token } });
    if (running !== r) return;
    set({ info });
    if (!info.self) {
      // Joined a moment ago, and no longer: the member removed them.
      if (guest.phase === "joined" || guest.phase === "elsewhere") end(r, `${info.host} removed you from Nearby.`);
      else set({ phase: "join" });
      return;
    }
    setDirectory(info.peers);
    if (guest.phase === "loading" || guest.phase === "failed") connect(r, info);
  } catch (error) {
    if (running !== r) return;
    if (error instanceof ApiError && (error.status === 410 || error.status === 404)) {
      end(
        r,
        error.status === 410 ? "This Nearby code has ended." : "This Nearby link doesn’t work. Ask for a new one.",
      );
    } else if (guest.phase === "loading") set({ phase: "failed", message: (error as Error).message });
  }
}

/** Joins under `name`; the member's devices show it from now on. */
export async function joinGuest(name: string, kind: DeviceKind) {
  const r = running;
  if (!r) return;
  const info = await guestCall(api.nearby.join, { params: { token: r.token }, body: { name, kind } });
  if (running !== r) return;
  set({ info });
  setDirectory(info.peers);
  connect(r, info);
}

/** Leaves: the member's devices stop showing this guest, and this browser forgets it joined. */
export async function leaveGuest() {
  const r = running;
  const csrf = guest.info?.self?.csrf;
  if (!r || !csrf) return;
  await guestCall(api.nearby.leave, { params: { token: r.token } }, csrf);
  if (running !== r) return;
  leaveStream(r, "join");
  set({ info: guest.info && { ...guest.info, self: null, peers: [] } });
}

/** This tab again, after another took over. */
export function guestTakeOver() {
  const r = running;
  if (r && guest.info?.self && guest.phase === "elsewhere") connect(r, guest.info);
}

function connect(r: Running, info: NearbyGuestState) {
  const self = info.self!;
  r.stream?.close();
  set({ phase: "joined", connected: false, message: "" });
  startEngine({
    self: self.id,
    signal: (to, signal) =>
      guestCall(api.nearby.guestSignal, { params: { token: r.token }, body: { to, signal } }, self.csrf).then(() => {}),
    // Nothing starts on a guest's device without them saying so.
  });
  r.stream = eventStream(urls.nearbyEvents(r.token), {
    ready: () => {
      set({ connected: true });
      void r.refresh.request().catch(() => {});
    },
    nearby: (event) => {
      let sent: NearbyEvent;
      try {
        sent = JSON.parse(event.data) as NearbyEvent;
      } catch {
        return;
      }
      if (sent.type === "signal") {
        // A device Relay introduced since the list was loaded: its name comes next.
        if (!guest.info?.peers.some((peer) => peer.id === sent.from)) void r.refresh.request().catch(() => {});
        receiveSignal(sent.from, sent.signal);
      } else if (sent.type === "peers") void r.refresh.request().catch(() => {});
      else if (sent.type === "replaced") leaveStream(r, "elsewhere");
    },
    ended: (event) => {
      let reason: SessionEnded["reason"] = "expired";
      try {
        reason = (JSON.parse(event.data) as SessionEnded).reason;
      } catch {
        /* The code ended. */
      }
      end(r, reason === "expired" ? "This Nearby code has ended." : `${info.host} removed you from Nearby.`);
    },
    // A refused stream says nothing: loading the link again tells a blip from an ending.
    failed: () => {
      set({ connected: false });
      void r.refresh.request().catch(() => {});
    },
  });
}

function leaveStream(r: Running, phase: GuestPhase) {
  r.stream?.close();
  r.stream = undefined;
  stopEngine(phase === "elsewhere" ? "Nearby moved to another tab." : "You left Nearby.");
  set({ phase, connected: false });
}

function end(r: Running, message: string) {
  leaveStream(r, "ended");
  set({ message });
}
