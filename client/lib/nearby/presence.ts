import { useSyncExternalStore } from "react";
import { api, call, tab } from "../../api";
import type { NearbyState } from "../../../shared/nearby";
import { coalesce } from "../coalesce";
import { liveOpen, onChange, onLiveOpen, onNearby } from "../live";
import {
  clearEngine,
  isActive,
  nearbySnapshot,
  onEngine,
  receiveSignal,
  setDirectory,
  startEngine,
  stopEngine,
} from "./engine";

// Which tab is a signed-in device's Nearby endpoint. One tab of each device is: the one holding the
// device's lock, so a second tab waits its turn and takes over when the first closes, or at once
// when someone chooses "Use here" in it. Browsers without locks (plain HTTP on the network) take
// Relay's word instead: the tab that registered last is the endpoint, and Relay tells the one it
// replaced. The endpoint keeps its stream registered with Relay, and runs the engine.

export type Role =
  /** Not signed in, or not yet decided. */
  | "off"
  /** This tab is the device's endpoint. */
  | "here"
  /** Another tab of this device is. */
  | "elsewhere";

export type Presence = {
  role: Role;
  /** The endpoint in another tab is sending or receiving right now. */
  busyElsewhere: boolean;
  /** Relay's view: who can be reached, and the member's Nearby code. Null until first loaded. */
  state: NearbyState | null;
  /** Why the last load failed, while it hasn't succeeded since. */
  error: string;
};

const LOCK = "relay-nearby:";

let presence: Presence = { role: "off", busyElsewhere: false, state: null, error: "" };
const listeners = new Set<() => void>();
function set(next: Partial<Presence>) {
  presence = { ...presence, ...next };
  listeners.forEach((fn) => fn());
}
export function usePresence() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => presence,
  );
}

type Running = {
  device: string;
  /** Ends what `start` began. */
  offs: (() => void)[];
  /** Lets the lock go, while this tab holds it. */
  release?: () => void;
  /** Ends a queued request for the lock. */
  abort?: AbortController;
  channel: BroadcastChannel | null;
  refresh: ReturnType<typeof coalesce>;
};
let running: Running | null = null;

const locks = () => (typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null);

/** Starts Nearby for the signed-in `device`: it becomes the endpoint here, or waits for its turn. */
export function startPresence(device: string) {
  if (running?.device === device) return;
  stopPresence();
  const refresh = coalesce(load, { delay: 150, interval: 1000 });
  const r: Running = {
    device,
    offs: [],
    channel: typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LOCK + device),
    refresh,
  };
  running = r;
  set({ role: "off", busyElsewhere: false, state: null, error: "" });

  const reload = () => void refresh.request().catch(() => {});
  r.offs.push(onChange("nearby", reload), onChange("devices", reload));
  // Every stream that opens is new to Relay: register it again while this tab is the endpoint.
  r.offs.push(
    onLiveOpen(() => {
      if (presence.role === "here" && liveOpen()) register();
    }),
  );
  r.offs.push(
    onNearby((event) => {
      if (running !== r) return;
      if (event.type === "signal" && presence.role === "here") {
        // A device Relay introduced since the list was loaded: its name and trust come next.
        if (!presence.state?.peers.some((peer) => peer.id === event.from)) reload();
        receiveSignal(event.from, event.signal);
      } else if (event.type === "replaced" && presence.role === "here") {
        // Another tab took over without the lock (a browser without locks). It stays there until
        // someone chooses this one again.
        leave();
      }
    }),
  );
  // Tabs tell each other whether the endpoint is busy, so "Use here" can say what it would stop.
  if (r.channel) {
    r.channel.onmessage = ({ data }: MessageEvent<{ busy?: boolean; ask?: true }>) => {
      if (data.ask && presence.role === "here") tellBusy(true);
      else if (typeof data.busy === "boolean" && presence.role !== "here") set({ busyElsewhere: data.busy });
    };
    let busy = false;
    const tellBusy = (always = false) => {
      const now = nearbySnapshot().transfers.some(isActive);
      if (now === busy && !always) return;
      busy = now;
      r.channel!.postMessage({ busy: now });
    };
    r.offs.push(onEngine(() => presence.role === "here" && tellBusy()));
    r.channel.postMessage({ ask: true });
  }

  const held = locks();
  if (held) queue(r, true);
  else become();
  reload();
}

/** Signed out: this tab stops being an endpoint, and forgets every transfer. */
export function stopPresence() {
  const r = running;
  if (!r) return;
  running = null;
  r.offs.forEach((off) => off());
  r.refresh.cancel();
  r.abort?.abort();
  r.release?.();
  r.channel?.close();
  clearEngine();
  set({ role: "off", busyElsewhere: false, state: null, error: "" });
}

/** Makes this tab the device's endpoint now, taking over from whichever tab was. */
export function takeOver() {
  const r = running;
  if (!r || presence.role === "here") return;
  if (locks()) {
    r.abort?.abort();
    queue(r, false, true);
  } else become();
}

/**
 * Asks for the device's lock. `first` asks only if it's free (otherwise another tab is the endpoint,
 * and this one then queues for it); `steal` takes it from whichever tab holds it.
 */
function queue(r: Running, first: boolean, steal = false) {
  const abort = new AbortController();
  r.abort = abort;
  const options: LockOptions = first ? { ifAvailable: true } : steal ? { steal: true } : { signal: abort.signal };
  locks()!
    .request(LOCK + r.device, options, (lock) => {
      if (running !== r) return;
      if (!lock) {
        // Another tab is the endpoint; this one takes over when it closes.
        set({ role: "elsewhere" });
        queue(r, false);
        return;
      }
      r.abort = undefined;
      become();
      return new Promise<void>((release) => {
        r.release = () => {
          r.release = undefined;
          release();
        };
      });
    })
    .catch(() => {
      // Stolen by a tab choosing "Use here", or given up on here: the other tab is the endpoint now,
      // and this one waits for it to close.
      if (running !== r || abort.signal.aborted) return;
      r.release = undefined;
      leave();
      queue(r, false);
    });
}

// A tab that's going lets the lock go, so another tab takes over at once; WebKit also won't load the
// tab's next page while it holds one. Brought back from the back-forward cache, it asks again.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    running?.abort?.abort();
    running?.release?.();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && running && locks()) queue(running, true);
  });
}

function become() {
  const r = running;
  if (!r) return;
  set({ role: "here", busyElsewhere: false });
  startEngine({
    self: r.device,
    signal: (to, signal) => call(api.nearby.signal, { body: { to, signal } }).then(() => {}),
  });
  if (presence.state) setDirectory(presence.state.peers);
  if (liveOpen()) register();
}

function leave() {
  set({ role: "elsewhere" });
  stopEngine("Nearby moved to another tab of this device.");
}

function register() {
  const r = running;
  call(api.nearby.present, { body: { tab: tab() } })
    .then(() => {
      if (running === r) void r?.refresh.request(true).catch(() => {});
    })
    .catch(() => {
      // The stream closed meanwhile; registering again waits for it to reopen.
    });
}

async function load() {
  const r = running;
  if (!r) return;
  try {
    const state = await call(api.nearby.get);
    if (running !== r) return;
    set({ state, error: "" });
    if (presence.role === "here") setDirectory(state.peers);
  } catch (error) {
    if (running === r) set({ error: (error as Error).message });
  }
}

/** Loads Relay's view again now, after changing it (the code, a guest, visibility). */
export function reloadPresence() {
  return running?.refresh.request(true).catch(() => {});
}
