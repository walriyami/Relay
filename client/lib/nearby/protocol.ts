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

/** Validate controls received from the other endpoint before the engine uses their fields. */
export function controlOf(value: unknown): Control | null {
  if (!object(value) || !id(value.id)) return null;
  switch (value.t) {
    case "offer": {
      if (
        !Array.isArray(value.files) ||
        value.files.length > 100_000 ||
        !value.files.every(
          (file) =>
            object(file) &&
            typeof file.path === "string" &&
            file.path.length > 0 &&
            file.path.length <= 4096 &&
            offset(file.size) &&
            typeof file.type === "string" &&
            file.type.length < 256 &&
            Number.isSafeInteger(file.modified),
        ) ||
        !Array.isArray(value.folders) ||
        value.folders.length > 100_000 ||
        !value.folders.every((folder) => typeof folder === "string" && folder.length <= 4096) ||
        !offset(value.text) ||
        typeof value.preview !== "string" ||
        value.preview.length > 240 ||
        (value.replaces !== undefined && !id(value.replaces))
      )
        return null;
      const files = value.files as WireFile[];
      if (!Number.isSafeInteger(files.reduce((bytes, file) => bytes + file.size, value.text))) return null;
      return {
        t: "offer",
        id: value.id,
        files,
        folders: value.folders as string[],
        text: value.text,
        preview: value.preview,
        ...(value.replaces !== undefined ? { replaces: value.replaces } : {}),
      };
    }
    case "accept": {
      if (!object(value.have) || !offset(value.stream) || value.stream >= 2 ** 32) return null;
      const entries = Object.entries(value.have);
      if (
        entries.length > 100_001 ||
        !entries.every(([key, bytes]) => (key === TEXT || /^(0|[1-9]\d{0,4})$/.test(key)) && offset(bytes))
      )
        return null;
      return { t: "accept", id: value.id, have: value.have as Record<string, number>, stream: value.stream };
    }
    case "decline":
      return value.reason === "declined" || value.reason === "space"
        ? { t: "decline", id: value.id, reason: value.reason }
        : null;
    case "cancel":
    case "done":
      return { t: value.t, id: value.id };
    default:
      return null;
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;
const offset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

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
