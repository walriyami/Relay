// What two Nearby endpoints say to each other once connected (see shared/nearby.ts for how they
// get there). Relay never sees any of it.
//
// Each connection has one `control` channel for JSON messages about transfers. Every file (and a
// transfer's text) then travels on a data channel of its own, labelled `<transfer>/<entry>`: the
// sender opens it with `{ from }`, the offset it starts at, sends the bytes as binary messages no
// further ahead than the receiver has credited, then `{ end: true }`; the receiver answers
// `{ ok: true }` once the entry is stored. A connection that drops mid-transfer is set up again and
// the sender makes the same offer on it: the receiver, knowing the transfer, accepts it again with how
// much of each entry it already has, and the sender carries on from there.

/** One file in an offer. `path` may name folders ("Trip/IMG_1.jpg"). */
export type WireFile = { path: string; size: number; type: string; modified: number };

export type Control =
  | {
      t: "offer";
      id: string;
      files: WireFile[];
      /** Folders in the selection, including empty ones. */
      folders: string[];
      /** The text's size in bytes, when it has text; the text itself comes as entry `text`. */
      text: number;
      /** The first lines of the text, for the prompt. */
      preview: string;
    }
  /** Go ahead (again): `have` is how many bytes of each entry the receiver already stored. */
  | { t: "accept"; id: string; have: Record<string, number> }
  | { t: "decline"; id: string; reason: "declined" | "space" }
  /** Either side stops the transfer. */
  | { t: "cancel"; id: string }
  /** The receiver stored everything. */
  | { t: "done"; id: string };

/** Messages on an entry's channel, besides its bytes. */
export type EntryControl = { from: number } | { credit: number } | { end: true } | { ok: true } | { error: string };

/** The entry key of a transfer's text; files are keyed by their index. */
export const TEXT = "text";

export const NEARBY_WIRE = {
  /** Largest binary message; every browser takes this much in one message. */
  chunkBytes: 64 * 1024,
  /** Bytes a sender may have in flight on one entry before the receiver has stored them. */
  windowBytes: 8 * 1024 * 1024,
  /** The receiver credits stored bytes back in steps of at least this. */
  creditBytes: 1024 * 1024,
  /** Entries sent at once: small files don't wait on each other's round trips. */
  parallel: 3,
} as const;

export const entryLabel = (transfer: string, entry: string) => `${transfer}/${entry}`;
export function parseLabel(label: string): { transfer: string; entry: string } | null {
  const slash = label.lastIndexOf("/");
  return slash > 0 ? { transfer: label.slice(0, slash), entry: label.slice(slash + 1) } : null;
}

/** A JSON message, or null when it isn't one this side understands. */
export function parse<T>(data: unknown): T | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" ? (value as T) : null;
  } catch {
    return null;
  }
}

/** A random id for a connection attempt or a transfer: 128 bits, URL-safe. */
export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
