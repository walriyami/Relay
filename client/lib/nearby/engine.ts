import { useSyncExternalStore } from "react";
import type { DeviceKind } from "../../../shared/model";
import type { NearbyPeer, NearbySignal } from "../../../shared/nearby";
import type { Inbound, Outbound } from "../../../shared/lanes";
import { Link, type LinkEnd, type LinkEvents } from "./link";
import { NEARBY_WIRE, TEXT, randomId, type Control, type WireFile } from "./protocol";
import { openSink, roomFor, type Sink } from "./sink";

// This tab's side of Nearby: the connections to other endpoints, and the transfers on them. It
// runs while the tab is its device's endpoint (see presence.ts), or while a guest has the Nearby
// page open (see guest.ts), and knows Relay only through its `Host`.

export type Host = {
  /** This endpoint's id. */
  self: string;
  /** Passes a signal to another endpoint through Relay. Rejects when Relay won't. */
  signal(to: string, signal: NearbySignal): Promise<void>;
};

/** How a peer can be reached now: null until a connection is tried. */
export type PeerStatus = "connecting" | "ready" | "unreachable" | null;

export type TransferState =
  /** Out: reaching the other device. */
  | "connecting"
  /** Out: waiting for the other side to accept. */
  | "asking"
  /** In: waiting for this side to accept. */
  | "incoming"
  | "running"
  /** The connection dropped; carrying on once it's back. */
  | "reconnecting"
  | "done"
  | "declined"
  | "cancelled"
  | "failed";

export type NearbyTransfer = {
  id: string;
  direction: "out" | "in";
  peer: string;
  /** The other side's name and kind as they were when it began. */
  peerName: string;
  peerKind: DeviceKind;
  files: WireFile[];
  folders: string[];
  /** Bytes of text, when it carries text. */
  textBytes: number;
  preview: string;
  /** Everything it carries, in bytes, and how much of that has arrived. */
  bytes: number;
  moved: number;
  /** Bytes a second, recently. */
  speed: number;
  state: TransferState;
  /** Why it was declined, cancelled or failed. */
  reason: string;
  started: number;
  finished: number | null;
  /** In, once done: the files that arrived, in the order of `files`, with their CRC-32s. */
  received: File[] | null;
  crcs: number[] | null;
  /** The text: what was sent, or once done, what arrived. */
  text: string | null;
};

const ACTIVE = new Set<TransferState>(["connecting", "asking", "running", "reconnecting"]);
export const isActive = (t: NearbyTransfer) => ACTIVE.has(t.state);
/** Nothing is happening to it any more. */
export const isOver = (t: NearbyTransfer) => !isActive(t) && t.state !== "incoming";

/** A transfer whose connection dropped keeps trying this long before it fails. */
const RECONNECT_MS = 90_000;
/** Tries at connecting again, spaced out. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000];
/** An idle connection closes after this long once nothing wants it open. */
const IDLE_MS = 30_000;
/** A peer that couldn't be reached is tried again after this long while the page is open. */
const UNREACHABLE_RETRY_MS = 30_000;
/** At most this many connections are made ahead of need, while the page is open. */
const WATCH_MAX = 16;
/** Most files in one offer. */
const FILES_MAX = 100_000;
/**
 * How long an offer from a peer missing from the directory waits for it. Relay introduced them, so
 * the directory is only behind (a device that just signed in); after this, it's asked about as unknown.
 */
const UNKNOWN_MS = 10_000;

type Out = {
  t: NearbyTransfer;
  kind: "out";
  files: File[];
  text: Blob | null;
  link: Link | null;
  /** Once accepted: what the receiver has stored of each entry, and the number of the first's stream. */
  have: Record<string, number>;
  stream: number;
  accepted: boolean;
  /** The transfer this one tries again. */
  replaces: string | null;
  queue: string[];
  sending: number;
  streams: Set<Outbound>;
  retry?: ReturnType<typeof setTimeout>;
  tries: number;
  lostAt: number;
};
type In = {
  t: NearbyTransfer;
  kind: "in";
  link: Link | null;
  sinks: Map<string, Sink>;
  done: Set<string>;
  /** As last accepted: where each entry starts again, and the number of the first's stream. */
  from: Record<string, number>;
  stream: number;
  streams: Set<Inbound>;
  /** Stores what arrived, one piece after another, across entries. */
  work: Promise<void>;
  deadline?: ReturnType<typeof setTimeout>;
  finishing: boolean;
};
type Record_ = Out | In;

let host: Host | null = null;
let directory = new Map<string, NearbyPeer>();
/** Offers from peers the directory doesn't list yet, taken up once it does. */
const waiting = new Map<Link, { messages: Extract<Control, { t: "offer" }>[]; timer: ReturnType<typeof setTimeout> }>();
const links = new Map<string, Link>();
/** When each peer last couldn't be reached. */
const unreachable = new Map<string, number>();
const records = new Map<string, Record_>();
/**
 * Cancels and declines made here while no connection to the other side was open, by peer: it hears
 * once one is.
 */
const owed = new Map<string, Control[]>();
/** Transfers declined here, so an offer made again is declined again rather than asked about. */
const declined = new Set<string>();
/** Newest first. */
let order: string[] = [];
let watching = false;
let idle: ReturnType<typeof setTimeout> | undefined;

// The snapshot views read, rebuilt at most a few times a second while bytes move.
type Snapshot = { transfers: NearbyTransfer[]; status: Record<string, PeerStatus>; running: boolean };
let snapshot: Snapshot = { transfers: [], status: {}, running: false };
const listeners = new Set<() => void>();
let flush: ReturnType<typeof setTimeout> | undefined;
function publish(now = false) {
  if (flush && !now) return;
  clearTimeout(flush);
  flush = setTimeout(
    () => {
      flush = undefined;
      const status: Record<string, PeerStatus> = {};
      for (const id of new Set([...links.keys(), ...unreachable.keys()])) status[id] = statusOf(id);
      snapshot = {
        transfers: order.map((id) => ({ ...records.get(id)!.t })),
        status,
        running: !!host,
      };
      listeners.forEach((fn) => fn());
      guard();
    },
    now ? 0 : 200,
  );
}
/** Runs `fn` whenever what `useNearby` shows changes. */
export function onEngine(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const nearbySnapshot = () => snapshot;
export function useNearby() {
  return useSyncExternalStore(onEngine, nearbySnapshot);
}

/**
 * `incoming`: waiting to be accepted here; `receiving`: accepted without asking (from the member's
 * own devices); `received` and `failed`: finished, or not, on this side.
 */
export type Notice = { kind: "incoming" | "receiving" | "received" | "failed"; transfer: NearbyTransfer };
const noticeListeners = new Set<(notice: Notice) => void>();
/** Hears transfers arriving, and finishing or failing on this side. */
export function onNotice(fn: (notice: Notice) => void) {
  noticeListeners.add(fn);
  return () => {
    noticeListeners.delete(fn);
  };
}
const notify = (kind: Notice["kind"], r: Record_) =>
  noticeListeners.forEach((fn) => fn({ kind, transfer: { ...r.t } }));

function statusOf(peer: string): PeerStatus {
  const link = links.get(peer);
  if (link?.state === "open") return "ready";
  if (link?.state === "connecting") return "connecting";
  return unreachable.has(peer) ? "unreachable" : null;
}

/** Starts (or restarts) this tab as an endpoint. */
export function startEngine(next: Host) {
  if (host && host.self !== next.self) stopEngine("Nearby stopped on this device.");
  host = next;
  publish(true);
}

/** Stops being an endpoint: transfers under way end with `reason`; finished ones stay to be saved. */
export function stopEngine(reason: string) {
  for (const r of records.values()) {
    if (r.t.state === "incoming" || isActive(r.t)) {
      r.link?.send({ t: "cancel", id: r.t.id });
      end(r, "cancelled", reason);
    }
  }
  for (const link of [...links.values()]) link.close();
  links.clear();
  unreachable.clear();
  owed.clear();
  for (const { timer } of waiting.values()) clearTimeout(timer);
  waiting.clear();
  host = null;
  publish(true);
}

/** Forgets every transfer, finished or not, and what they stored: someone else may sign in next. */
export function clearEngine() {
  stopEngine("Nearby stopped on this device.");
  declined.clear();
  for (const id of [...order]) dismiss(id);
}

/** Who this endpoint can see, for names and trust. */
export function setDirectory(peers: NearbyPeer[]) {
  const before = directory;
  directory = new Map(peers.map((p) => [p.id, p]));
  // Someone who just opened Relay is worth trying again at once.
  for (const peer of peers) if (peer.present && !before.get(peer.id)?.present) unreachable.delete(peer.id);
  for (const link of [...waiting.keys()]) if (directory.has(link.peer)) takeWaiting(link);
  if (watching) connectAhead();
  publish();
}

/**
 * While the Nearby page is open, connects to present peers ahead of need, so each one says whether
 * it can be reached before anything is sent.
 */
export function watch(on: boolean) {
  watching = on;
  if (on) connectAhead();
  else scheduleIdle();
}

let aheadTimer: ReturnType<typeof setTimeout> | undefined;
function connectAhead() {
  clearTimeout(aheadTimer);
  if (!host || !watching || document.hidden) return;
  let open = [...links.values()].filter((l) => l.state !== "ended").length;
  let next = Infinity;
  for (const peer of directory.values()) {
    if (!peer.present || links.has(peer.id) || open >= WATCH_MAX) continue;
    const failed = unreachable.get(peer.id);
    if (failed && Date.now() - failed < UNREACHABLE_RETRY_MS) {
      next = Math.min(next, failed + UNREACHABLE_RETRY_MS - Date.now());
      continue;
    }
    linkTo(peer.id);
    open++;
  }
  if (next < Infinity) aheadTimer = setTimeout(connectAhead, next + 50);
}
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) connectAhead();
  });

/** Tries to reach `peer` again now. */
export function retryPeer(peer: string) {
  unreachable.delete(peer);
  linkTo(peer);
  publish();
}

function scheduleIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (watching) return;
    for (const [peer, link] of links)
      if (![...records.values()].some((r) => r.t.peer === peer && (isActive(r.t) || r.t.state === "incoming")))
        link.close();
  }, IDLE_MS);
}

function linkTo(peer: string): Link | null {
  if (!host) return null;
  const current = links.get(peer);
  if (current && current.state !== "ended") return current;
  const h = host;
  const link = Link.offer(peer, events, (signal) => h.signal(peer, signal));
  links.set(peer, link);
  publish();
  return link;
}

/** A signal from `from`, as Relay vouched for it. */
export function receiveSignal(from: string, signal: NearbySignal) {
  if (!host) return;
  const current = links.get(from);
  if (signal.kind === "answer") {
    if (current?.session === signal.session) void current.answered(signal.sdp);
    return;
  }
  if (signal.kind === "bye") {
    if (current?.session === signal.session) current.end("closed");
    return;
  }
  if (current?.session === signal.session) return;
  // Both offered at once: the endpoint with the lower id keeps its own offer.
  if (current?.state === "connecting" && current.offering && host.self < from) return;
  const h = host;
  const link = Link.answer(from, signal.session, signal.sdp, events, (s) => h.signal(from, s));
  links.set(from, link);
  unreachable.delete(from);
  // Replaced: its transfers carry on over the new connection.
  current?.close(false);
  publish();
}

const events: LinkEvents = {
  open(link) {
    if (links.get(link.peer) !== link) return link.close(false);
    unreachable.delete(link.peer);
    for (const message of owed.get(link.peer) ?? []) link.send(message);
    owed.delete(link.peer);
    for (const r of records.values())
      if (
        r.kind === "out" &&
        r.t.peer === link.peer &&
        r.link !== link &&
        (r.t.state === "connecting" || r.t.state === "reconnecting")
      )
        offer(r, link);
    publish();
    if (!watching) scheduleIdle();
  },
  end(link, why: LinkEnd) {
    const current = links.get(link.peer) === link;
    if (current) {
      links.delete(link.peer);
      if (why === "unreachable") unreachable.set(link.peer, Date.now());
    }
    for (const r of records.values()) if (r.link === link) lost(r);
    // Transfers still waiting for a first connection try again, or give up.
    if (current)
      for (const r of records.values())
        if (
          r.kind === "out" &&
          r.t.peer === link.peer &&
          !r.link &&
          (r.t.state === "connecting" || r.t.state === "reconnecting")
        )
          retryLater(r, why);
    publish();
  },
  control(link, message) {
    const r = records.get(message.id);
    if (message.t === "offer") return offered(link, message);
    if (!r || r.t.peer !== link.peer) return;
    if (r.kind === "out") outControl(r, link, message);
    else inControl(r, message);
  },
  stream(link, stream) {
    for (const r of records.values())
      if (r.kind === "in" && r.link === link && r.t.state === "running") {
        const index = stream - r.stream;
        if (index >= 0 && index < entryCount(r.t)) return receiveEntry(r, link, index);
      }
  },
};

// Sending.

/**
 * Sends `files` (with their paths) and `text` to `peer`, trying again transfer `replaces` if given.
 * Returns the transfer's id.
 */
export function send(
  peer: NearbyPeer,
  files: { file: File; path: string }[],
  folders: string[],
  text: string,
  replaces: string | null = null,
) {
  const blob = text ? new Blob([text]) : null;
  const t: NearbyTransfer = {
    id: randomId(),
    direction: "out",
    peer: peer.id,
    peerName: peer.name,
    peerKind: peer.deviceKind,
    files: files.map(({ file, path }) => ({ path, size: file.size, type: file.type, modified: file.lastModified })),
    folders,
    textBytes: blob?.size ?? 0,
    preview: preview(text),
    bytes: files.reduce((n, f) => n + f.file.size, 0) + (blob?.size ?? 0),
    moved: 0,
    speed: 0,
    state: "connecting",
    reason: "",
    started: Date.now(),
    finished: null,
    received: null,
    crcs: null,
    text: text || null,
  };
  const r: Out = {
    t,
    kind: "out",
    files: files.map((f) => f.file),
    text: blob,
    link: null,
    have: {},
    stream: 0,
    accepted: false,
    replaces,
    queue: [],
    sending: 0,
    streams: new Set(),
    tries: 0,
    lostAt: 0,
  };
  add(r);
  unreachable.delete(peer.id);
  const link = linkTo(peer.id);
  if (link?.state === "open") offer(r, link);
  publish(true);
  return t.id;
}

function preview(text: string) {
  const lines = text.trim().split("\n").slice(0, 3).join("\n");
  return lines.length > 240 ? `${lines.slice(0, 239)}…` : lines;
}

/** Makes the offer on `link`: the first time, or again after a dropped connection. */
function offer(r: Out, link: Link) {
  clearTimeout(r.retry);
  r.link = link;
  r.tries = 0;
  if (!r.accepted) r.t.state = "asking";
  link.send({
    t: "offer",
    id: r.t.id,
    files: r.t.files,
    folders: r.t.folders,
    text: r.t.textBytes,
    preview: r.t.preview,
    ...(r.replaces ? { replaces: r.replaces } : {}),
  });
  publish();
}

function outControl(r: Out, link: Link, message: Control) {
  if (!isActive(r.t)) return;
  // A cancel or decline counts on whichever connection brings it: it may have waited for one.
  if (message.t !== "cancel" && message.t !== "decline" && r.link !== link) return;
  switch (message.t) {
    case "accept": {
      if (!Number.isSafeInteger(message.stream) || message.stream < 0 || message.stream + entryCount(r.t) > 2 ** 32)
        return failOut(r, `${r.t.peerName} answered in a way this device doesn’t understand.`);
      r.accepted = true;
      r.have = sane(message.have);
      r.stream = message.stream;
      r.t.state = "running";
      r.lostAt = 0;
      const entries = [...r.files.keys()].map(String);
      if (r.text) entries.push(TEXT);
      r.queue = entries.filter((e) => (r.have[e] ?? 0) < sizeOf(r, e));
      r.t.moved = entries.reduce((n, e) => n + Math.min(r.have[e] ?? 0, sizeOf(r, e)), 0);
      pump(r, link);
      break;
    }
    case "decline":
      end(
        r,
        "declined",
        message.reason === "space" ? `${r.t.peerName} doesn’t have room for this.` : `${r.t.peerName} declined.`,
      );
      break;
    case "cancel":
      end(r, "cancelled", `${r.t.peerName} stopped it.`);
      break;
    case "done":
      r.t.moved = r.t.bytes;
      end(r, "done");
      break;
  }
  publish();
}

function sane(have: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (have && typeof have === "object")
    for (const [key, value] of Object.entries(have))
      if (Number.isSafeInteger(value) && (value as number) >= 0) result[key] = value as number;
  return result;
}

const sizeOf = (r: Out, entry: string) => (entry === TEXT ? (r.text?.size ?? 0) : r.files[Number(entry)].size);
/** Entries in a transfer, empty ones included: its files, then its text. */
const entryCount = (t: NearbyTransfer) => t.files.length + (t.textBytes ? 1 : 0);
const indexOf = (t: NearbyTransfer, entry: string) => (entry === TEXT ? t.files.length : Number(entry));

function pump(r: Out, link: Link) {
  while (r.sending < NEARBY_WIRE.parallel && r.queue.length && r.link === link && r.t.state === "running") {
    const entry = r.queue.shift()!;
    r.sending++;
    void sendEntry(r, link, entry).then(() => {
      r.sending--;
      pump(r, link);
    });
  }
}

/** Sends one entry as a stream of its own; resolves once it's stored, or can't be. */
function sendEntry(r: Out, link: Link, entry: string) {
  const blob = entry === TEXT ? r.text! : r.files[Number(entry)];
  const out = link.mux!.outgoing(r.stream + indexOf(r.t, entry), r.have[entry] ?? 0, NEARBY_WIRE.windowBytes);
  r.streams.add(out);
  return new Promise<void>((resolve) => {
    let reading = false;
    const write = async () => {
      if (reading) return;
      reading = true;
      try {
        while (out.offset < blob.size && out.room > 0) {
          const at = out.offset;
          const bytes = await blob
            .slice(at, at + Math.min(out.room, NEARBY_WIRE.readBytes, blob.size - at))
            .arrayBuffer();
          if (out.closed) return;
          out.write(new Uint8Array(bytes));
        }
      } catch {
        if (out.closed) return;
        out.close();
        failOut(r, "A file couldn’t be read. It may have been moved or changed since you chose it.");
      } finally {
        reading = false;
      }
    };
    out.onReady = () => void write();
    out.onCredit = (bytes) => {
      r.have[entry] = Math.min(blob.size, (r.have[entry] ?? 0) + bytes);
      progress(r);
      if (r.have[entry] === blob.size) out.close();
    };
    // Stored, or closed under it: the connection dropped (the transfer waits for the next), or it was stopped.
    out.onClose = () => {
      r.streams.delete(out);
      resolve();
    };
    void write();
  });
}

function progress(r: Record_) {
  const moved =
    r.kind === "out"
      ? Object.entries(r.have).reduce((n, [e, v]) => n + Math.min(v, sizeOf(r, e)), 0)
      : [...r.sinks.values()].reduce((n, s) => n + s.written, 0);
  r.t.moved = Math.min(moved, r.t.bytes);
  measure();
  publish();
}

function failOut(r: Out, reason: string) {
  if (!isActive(r.t)) return;
  r.link?.send({ t: "cancel", id: r.t.id });
  end(r, "failed", reason);
  publish();
}

/** The connection under a transfer went: it waits for another, or fails in time. */
function lost(r: Record_) {
  if (!isActive(r.t) && r.t.state !== "incoming") return;
  r.link = null;
  for (const stream of [...r.streams]) stream.close();
  r.streams.clear();
  if (r.kind === "out") {
    if (r.t.state === "connecting") return;
    r.t.state = "reconnecting";
    r.lostAt ||= Date.now();
    r.queue = [];
    retryLater(r, "lost");
  } else {
    if (r.t.state === "running") r.t.state = "reconnecting";
    clearTimeout(r.deadline);
    // The sender comes back if it can; one that doesn't in time isn't coming.
    r.deadline = setTimeout(() => {
      if (r.link) return;
      if (r.t.state === "incoming") remove(r);
      else end(r, "failed", `Lost the connection to ${r.t.peerName}.`);
      publish();
    }, RECONNECT_MS + 15_000);
  }
}

function retryLater(r: Out, why: LinkEnd) {
  clearTimeout(r.retry);
  if (r.t.state === "connecting" && why === "unreachable") {
    end(r, "failed", `Couldn’t reach ${r.t.peerName} on this network.`);
    notify("failed", r);
    return;
  }
  r.lostAt ||= Date.now();
  if (Date.now() - r.lostAt > RECONNECT_MS) {
    end(r, "failed", `Lost the connection to ${r.t.peerName}.`);
    notify("failed", r);
    return;
  }
  r.retry = setTimeout(
    () => {
      if (!isActive(r.t) || r.link) return;
      const link = linkTo(r.t.peer);
      if (link?.state === "open") offer(r, link);
    },
    RETRY_MS[Math.min(r.tries++, RETRY_MS.length - 1)],
  );
}

// Receiving.

function takeWaiting(link: Link) {
  const held = waiting.get(link);
  if (!held) return;
  waiting.delete(link);
  clearTimeout(held.timer);
  if (link.state === "open" && links.get(link.peer) === link)
    for (const message of held.messages) offered(link, message, true);
}

function offered(link: Link, message: Extract<Control, { t: "offer" }>, late = false) {
  if (!late && !directory.has(link.peer)) {
    const held = waiting.get(link);
    if (held) held.messages.push(message);
    else waiting.set(link, { messages: [message], timer: setTimeout(() => takeWaiting(link), UNKNOWN_MS) });
    return;
  }
  if (declined.has(message.id)) {
    link.send({ t: "decline", id: message.id, reason: "declined" });
    return;
  }
  const known = records.get(message.id);
  if (known) {
    if (known.kind !== "in" || known.t.peer !== link.peer) return;
    // The same transfer on a new connection: carry on where it was.
    clearTimeout(known.deadline);
    known.link = link;
    switch (known.t.state) {
      case "reconnecting":
      case "running":
        known.t.state = "running";
        void acceptOn(known, link);
        break;
      case "done":
        link.send({ t: "done", id: known.t.id });
        break;
      case "incoming":
        break;
      default:
        link.send({ t: "cancel", id: known.t.id });
    }
    publish();
    return;
  }
  const files = checkFiles(message.files);
  const folders = Array.isArray(message.folders) ? message.folders.map(cleanPath).filter(Boolean) : [];
  const textBytes = Number.isSafeInteger(message.text) && message.text >= 0 ? message.text : -1;
  if (
    !files ||
    textBytes < 0 ||
    (!files.length && !textBytes) ||
    typeof message.id !== "string" ||
    message.id.length > 64
  ) {
    link.send({ t: "cancel", id: String(message.id).slice(0, 64) });
    return;
  }
  // The sender trying again: the attempt it replaces goes, unless it arrived in full.
  const old = typeof message.replaces === "string" ? records.get(message.replaces) : undefined;
  if (old?.kind === "in" && old.t.peer === link.peer && old.t.state !== "done") remove(old);
  const peer = directory.get(link.peer);
  const t: NearbyTransfer = {
    id: message.id,
    direction: "in",
    peer: link.peer,
    peerName: peer?.name ?? "A nearby device",
    peerKind: peer?.deviceKind ?? "computer",
    files,
    folders,
    textBytes,
    preview: typeof message.preview === "string" ? message.preview.slice(0, 240) : "",
    bytes: files.reduce((n, f) => n + f.size, 0) + textBytes,
    moved: 0,
    speed: 0,
    state: "incoming",
    reason: "",
    started: Date.now(),
    finished: null,
    received: null,
    crcs: null,
    text: null,
  };
  const r: In = {
    t,
    kind: "in",
    link,
    sinks: new Map(),
    done: new Set(),
    from: {},
    stream: 0,
    streams: new Set(),
    work: Promise.resolve(),
    finishing: false,
  };
  add(r);
  // What the member's own devices send starts without asking.
  if (peer?.kind === "device") {
    notify("receiving", r);
    void accept(t.id);
  } else notify("incoming", r);
  publish(true);
}

function checkFiles(files: unknown): WireFile[] | null {
  if (!Array.isArray(files) || files.length > FILES_MAX) return null;
  const result: WireFile[] = [];
  for (const f of files as Partial<WireFile>[]) {
    const path = typeof f?.path === "string" ? cleanPath(f.path) : "";
    if (!path || !Number.isSafeInteger(f.size) || f.size! < 0) return null;
    result.push({
      path,
      size: f.size!,
      type: typeof f.type === "string" && f.type.length < 256 ? f.type : "",
      modified: Number.isSafeInteger(f.modified) ? f.modified! : Date.now(),
    });
  }
  return result;
}

/** A relative path with no way out of its folder, and nothing a file system refuses. */
function cleanPath(path: string) {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .map((part) =>
      [...part]
        .filter((c) => c.charCodeAt(0) >= 32 && c !== "\u007f")
        .join("")
        .trim(),
    )
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 4096);
}

const entriesOf = (r: In) => [
  ...r.t.files.flatMap((f, i) => (f.size ? [String(i)] : [])),
  ...(r.t.textBytes ? [TEXT] : []),
];
function haveOf(r: In) {
  const have: Record<string, number> = {};
  for (const [entry, sink] of r.sinks) have[entry] = sink.written;
  for (const entry of r.done) have[entry] = entry === TEXT ? r.t.textBytes : r.t.files[Number(entry)].size;
  return have;
}

/** Numbers the streams of connections' transfers, per connection. */
const streamsUsed = new WeakMap<Link, number>();

/**
 * Accepts the transfer on `link`, from what's stored: once whatever arrived on an earlier connection
 * is written, so the sender starts again from exactly there.
 */
async function acceptOn(r: In, link: Link) {
  await r.work;
  if (r.link !== link || r.t.state !== "running") return;
  r.from = haveOf(r);
  r.stream = streamsUsed.get(link) ?? 0;
  streamsUsed.set(link, r.stream + entryCount(r.t));
  link.send({ t: "accept", id: r.t.id, have: r.from, stream: r.stream });
}

/** Takes the transfer: it starts, or, if this device has no room, is declined. */
export async function accept(id: string) {
  const r = records.get(id);
  if (!r || r.kind !== "in" || r.t.state !== "incoming") return;
  if (!(await roomFor(r.t.bytes))) {
    tell(r, { t: "decline", id, reason: "space" });
    end(r, "failed", "There isn’t room on this device for it.");
    notify("failed", r);
    publish();
    return;
  }
  if (r.t.state !== "incoming") return;
  r.t.state = r.link ? "running" : "reconnecting";
  if (r.link) void acceptOn(r, r.link);
  if (!entriesOf(r).length) void finishIn(r);
  publish(true);
}

export function decline(id: string) {
  const r = records.get(id);
  if (!r || r.kind !== "in" || r.t.state !== "incoming") return;
  declined.add(id);
  tell(r, { t: "decline", id, reason: "declined" });
  remove(r);
  publish(true);
}

function inControl(r: In, message: Control) {
  // A cancel counts on whichever connection brings it: it may have waited for one.
  if (message.t === "cancel" && (isActive(r.t) || r.t.state === "incoming")) {
    const asked = r.t.state === "incoming";
    end(r, "cancelled", `${r.t.peerName} stopped sending.`);
    // An offer withdrawn before it was answered leaves nothing to show.
    if (asked) remove(r);
    publish();
  }
}

/** Couldn't store what arrived. */
class StoreError extends Error {}

/** Receives entry `index` of the transfer, which its sender started sending on `link`. */
function receiveEntry(r: In, link: Link, index: number) {
  const entry = index < r.t.files.length ? String(index) : TEXT;
  const size = entry === TEXT ? r.t.textBytes : r.t.files[index].size;
  if (!size || r.done.has(entry)) return;
  const store = (bytes: Uint8Array) => {
    const stored = r.work.then(async () => {
      if (!isActive(r.t)) return;
      let sink = r.sinks.get(entry);
      if (!sink) {
        sink = await openSink(entry === TEXT);
        // Ended while it opened: nothing keeps it.
        if (!isActive(r.t)) return void sink.discard();
        r.sinks.set(entry, sink);
      }
      try {
        await sink.write(bytes);
      } catch {
        throw new StoreError();
      }
      progress(r);
    });
    r.work = stored.catch(() => {});
    return stored;
  };
  const into = link.mux!.incoming(r.stream + index, {
    from: r.from[entry] ?? 0,
    to: size,
    window: NEARBY_WIRE.windowBytes,
    write: store,
    done: () => {
      r.streams.delete(into);
      r.done.add(entry);
      if (entriesOf(r).every((e) => r.done.has(e))) void finishIn(r);
    },
    failed: (error) => {
      r.streams.delete(into);
      if (!isActive(r.t)) return;
      r.link?.send({ t: "cancel", id: r.t.id });
      end(
        r,
        "failed",
        error instanceof StoreError
          ? "This device ran out of room for it."
          : `What ${r.t.peerName} sent didn’t match what it offered.`,
      );
      notify("failed", r);
      publish();
    },
  });
  r.streams.add(into);
}

async function finishIn(r: In) {
  if (r.finishing) return;
  r.finishing = true;
  try {
    const received: File[] = [];
    const crcs: number[] = [];
    for (const [i, f] of r.t.files.entries()) {
      const name = f.path.split("/").pop()!;
      const sink = r.sinks.get(String(i));
      received.push(
        sink
          ? await sink.finish(f.type, name, f.modified)
          : new File([], name, { type: f.type, lastModified: f.modified }),
      );
      crcs.push(sink?.crc ?? 0);
    }
    const text = r.sinks.get(TEXT);
    r.t.text = text ? await (await text.finish("text/plain", "text.txt", Date.now())).text() : null;
    if (text) {
      await text.discard();
      r.sinks.delete(TEXT);
    }
    r.t.received = received;
    r.t.crcs = crcs;
    r.t.moved = r.t.bytes;
    r.link?.send({ t: "done", id: r.t.id });
    end(r, "done");
    notify("received", r);
  } catch {
    r.link?.send({ t: "cancel", id: r.t.id });
    end(r, "failed", "What arrived couldn’t be put together on this device.");
    notify("failed", r);
  }
  publish(true);
}

/** What an outgoing transfer carries, to send it again or another way. */
export function payloadOf(id: string) {
  const r = records.get(id);
  if (!r || r.kind !== "out") return null;
  return {
    files: r.files.map((file, i) => ({ file, path: r.t.files[i].path })),
    folders: r.t.folders,
    text: r.t.text ?? "",
  };
}

// Both directions.

/** Stops a transfer under way, or withdraws an offer. */
export function cancel(id: string) {
  const r = records.get(id);
  if (!r || !isActive(r.t)) return;
  // Not offered yet, the other side knows nothing of it; otherwise it hears now, or once it can.
  if (r.kind === "in" || r.t.state !== "connecting") tell(r, { t: "cancel", id });
  end(r, "cancelled", "You stopped it.");
  publish(true);
}

/** Sends `message` about `r` to the other side now, or once a connection to it opens. */
function tell(r: Record_, message: Control) {
  if (r.link?.send(message)) return;
  owed.set(r.t.peer, [...(owed.get(r.t.peer) ?? []), message]);
  linkTo(r.t.peer);
}

/** Takes a finished transfer off the list, and frees what it stored. */
export function dismiss(id: string) {
  const r = records.get(id);
  if (!r) return;
  if (isActive(r.t)) cancel(id);
  remove(r);
  publish(true);
}

function add(r: Record_) {
  records.set(r.t.id, r);
  order = [r.t.id, ...order];
}

function remove(r: Record_) {
  end(r, r.t.state === "incoming" ? "declined" : r.t.state);
  if (r.kind === "in") {
    for (const sink of r.sinks.values()) void sink.discard();
    r.sinks.clear();
  }
  records.delete(r.t.id);
  order = order.filter((id) => id !== r.t.id);
}

function end(r: Record_, state: TransferState, reason = "") {
  if (r.t.state !== state) {
    r.t.state = state;
    r.t.reason = reason;
    r.t.finished = Date.now();
    r.t.speed = 0;
  }
  for (const stream of [...r.streams]) stream.close();
  r.streams.clear();
  if (r.kind === "out") {
    clearTimeout(r.retry);
    r.queue = [];
  } else {
    clearTimeout(r.deadline);
    if (state !== "done") {
      for (const sink of r.sinks.values()) void sink.discard();
      r.sinks.clear();
    }
  }
  if (!watching) scheduleIdle();
}

// Speed, measured over the last few seconds.
let lastMeasure = 0;
const lastMoved = new Map<string, number>();
function measure() {
  const now = performance.now();
  if (now - lastMeasure < 500) return;
  const dt = lastMeasure ? (now - lastMeasure) / 1000 : 0;
  lastMeasure = now;
  for (const r of records.values()) {
    const before = lastMoved.get(r.t.id);
    lastMoved.set(r.t.id, r.t.moved);
    if (!dt || before === undefined || r.t.state !== "running") continue;
    const rate = (r.t.moved - before) / dt;
    r.t.speed = r.t.speed ? r.t.speed * 0.7 + rate * 0.3 : rate;
  }
}

// While bytes move: the screen stays on, and leaving the page asks first.
let wake: WakeLockSentinel | null = null;
let wanting = false;
function guard() {
  const busy = [...records.values()].some((r) => isActive(r.t));
  if (busy === wanting) return;
  wanting = busy;
  if (busy) {
    window.addEventListener("beforeunload", leaving);
    void keepAwake();
  } else {
    window.removeEventListener("beforeunload", leaving);
    void wake?.release().catch(() => {});
    wake = null;
  }
}
function leaving(event: BeforeUnloadEvent) {
  event.preventDefault();
}
async function keepAwake() {
  if (!wanting || wake || document.hidden || !navigator.wakeLock) return;
  try {
    wake = await navigator.wakeLock.request("screen");
    wake.addEventListener("release", () => {
      wake = null;
    });
  } catch {
    // Not allowed here (low battery, no user gesture yet); transfers carry on regardless.
  }
}
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void keepAwake();
  });
