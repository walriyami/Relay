// Direct transfers on the local network. A signed-in browser on the server's network opens a WebRTC
// connection to the helper, a process Relay runs beside itself, and sends its bulk requests (upload
// chunks and downloads) through it instead of the internet connection. The browser's offer names
// its own addresses (usually hidden behind .local names), and the helper's answer names the host's.
// Each side checks the other's, only ever at local network addresses, so the connection comes up
// only on the server's own networks, whichever side's checks get through. The helper passes each
// request on to Relay over a private socket, as the session that set up the connection. Every
// request travels on a data channel of its own:
//
//   browser → helper   text: LocalRequest, then exactly `length` body bytes as binary messages
//   helper → browser   text: LocalResponse, then the body as binary messages, then {end} or {error}
//
// Body bytes are flow controlled in both directions: a sender may have `LOCAL.windowBytes` bytes
// in flight, and the receiver returns {credit} as it passes them on. Either side closes the channel
// to abandon the request.

export const LOCAL = {
  /** Largest binary message; every browser accepts 64 KiB, and larger ones are no faster. */
  messageBytes: 64 * 1024,
  /** Body bytes a sender may have in flight on one request before it must wait for credit. */
  windowBytes: 4 * 1024 ** 2,
  /** A receiver returns credit once this much has been passed on, so credit messages stay rare. */
  creditBytes: 1024 ** 2,
  /** Largest offer the browser may send to set up a connection. */
  offerBytes: 16 * 1024,
  /** Largest request or response head. */
  headBytes: 8 * 1024,
} as const;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** What a data channel may carry: a member's bulk requests, and the check that proves the route. */
const ROUTES: readonly [string, RegExp][] = [
  ["HEAD", new RegExp(`^/uploads/${ID}$`)],
  ["PATCH", new RegExp(`^/uploads/${ID}$`)],
  ["GET", new RegExp(`^/api/nodes/${ID}/content$`)],
  ["GET", new RegExp(`^/api/items/${ID}/zip(\\?folder=${ID})?$`)],
  ["GET", /^\/api\/local\/check$/],
];
export const isLocalRoute = (method: string, path: string) =>
  ROUTES.some(([m, pattern]) => m === method && pattern.test(path));

/** Headers a request may carry through the helper; anything else is dropped. Lowercase. */
export const REQUEST_HEADERS = new Set([
  "content-type",
  "if-range",
  "range",
  "tus-resumable",
  "upload-offset",
  "x-relay-csrf",
  "x-relay-tab",
]);
/** Headers a response may carry back. Lowercase. */
export const RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "tus-resumable",
  "tus-version",
  "upload-length",
  "upload-offset",
]);

export type LocalRequest = {
  method: string;
  /** Path and query, as in a URL on Relay's origin. */
  path: string;
  headers: Record<string, string>;
  /** Body bytes that follow. */
  length: number;
};
export type LocalResponse = { status: number; headers: Record<string, string> };
export type LocalControl = { credit: number } | { end: true } | { error: string };

/** Keeps the headers in `allowed`, lowercased, with string values. */
export function pickHeaders(headers: Record<string, unknown>, allowed: ReadonlySet<string>) {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (allowed.has(key) && (typeof value === "string" || typeof value === "number")) picked[key] = String(value);
  }
  return picked;
}

// Relay runs the helper as a process of its own and gives it a private directory, where the two
// talk over two sockets: Relay serves the helper's forwarded requests, and the helper answers
// Relay's connection requests.
export const SOCKETS = { relay: "relay.sock", helper: "helper.sock" } as const;
/** Set by the helper on every forwarded request; see Secrets.localToken. */
export const LOCAL_TOKEN_HEADER = "x-relay-local";

/** The helper's answer to Relay's status request. */
export type HelperStatus = {
  /** Browsers connected right now. */
  links: number;
};

/** What the helper's process tells Relay's over their IPC channel. */
export type HelperMessage =
  | { type: "log"; level: "info" | "warn" | "error"; msg: string; fields?: Record<string, unknown> }
  /** It is answering on its socket. */
  | { type: "ready" }
  /** It can't run, for this reason; it exits next. */
  | { type: "failed"; reason: string };
