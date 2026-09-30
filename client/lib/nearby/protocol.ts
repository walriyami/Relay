// What two Nearby endpoints say to each other once connected (see shared/nearby.ts for how they
// get there). Relay never sees any of it.
//
// A connection is made of lanes (see shared/lanes.ts): JSON control messages about transfers, and
// each entry of a transfer (a file, or the text) as a stream of its own. The receiver's accept numbers
// the streams: entry i is stream `stream + i`, the text comes after the files. The sender sends each
// entry from where the receiver's accept says it has got to, and counts the receiver's credits as
// bytes stored. A connection that drops mid-transfer is set up again and the sender makes the same
// offer on it: the receiver, knowing the transfer, accepts it again with how much of each entry it
// already has, and the sender carries on from there.

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
      /** The transfer this one tries again: the receiver lists this one in its place. */
      replaces?: string;
    }
  /**
   * Go ahead (again): `have` is how many bytes of each entry the receiver already stored, and
   * `stream` numbers the entries' streams.
   */
  | { t: "accept"; id: string; have: Record<string, number>; stream: number }
  | { t: "decline"; id: string; reason: "declined" | "space" }
  /** Either side stops the transfer. */
  | { t: "cancel"; id: string }
  /** The receiver stored everything. */
  | { t: "done"; id: string };

/** The entry key of a transfer's text; files are keyed by their index. */
export const TEXT = "text";

export const NEARBY_WIRE = {
  /** A sender reads files this much at a time. */
  readBytes: 1024 * 1024,
  /** Bytes of one entry a sender may have in flight before the receiver has stored them. */
  windowBytes: 8 * 1024 * 1024,
  /** Entries sent at once: small files don't wait on each other's round trips. */
  parallel: 3,
} as const;

/** A random id for a connection attempt or a transfer: 128 bits, URL-safe. */
export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
