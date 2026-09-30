// Direct transfers on the local network. A signed-in browser on the server's network opens a WebRTC
// connection to the helper, a process Relay runs beside itself, and sends its bulk requests (upload
// chunks and downloads) through it instead of the internet connection. The browser's offer names
// its own addresses (usually hidden behind .local names), and the helper's answer names the host's.
// Each side checks the other's, only ever at local network addresses, so the connection comes up
// only on the server's own networks, whichever side's checks get through. The helper passes each
// request on to Relay over a private socket, as the session that set up the connection.
//
// The connection is made of lanes (see shared/lanes.ts): the first is set up through Relay, and the
// browser offers the others on it, which the helper checks as it did the first. The browser numbers
// its requests from 1 on each connection. A request travels as control messages, with its body and
// its response's body as streams numbered the same as the request, one each way:
//
//   browser → helper   LocalRequest, then (once the helper is ready for it) the body, if any
//                      {r, cancel: true} to abandon the request
//   helper → browser   {r, ready: true} once it takes the request's body, which it has a window for
//                      LocalResponse, then the body, then {r, end} with the body's length
//                      {r, error} when the request failed on the way; sent the usual way, it may work

export const LOCAL = {
  /** A browser reads a request body this much at a time. */
  readBytes: 1024 ** 2,
  /** Body bytes a sender may have in flight on one request before the receiver has passed them on. */
  windowBytes: 16 * 1024 ** 2,
  /** Largest offer the browser may send to set up a connection, or a lane of it. */
  offerBytes: 16 * 1024,
  /** Largest control message: a request, a response head, or the lanes' offers. */
  messageChars: 256 * 1024,
  /** Requests one connection may carry at once. */
  requests: 16,
} as const;

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** What the direct connection may carry: a member's bulk requests, and the check that proves the route. */
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
  r: number;
  method: string;
  /** Path and query, as in a URL on Relay's origin. */
  path: string;
  headers: Record<string, string>;
  /** Body bytes that follow. */
  length: number;
};
export type LocalResponse = { r: number; status: number; headers: Record<string, string> };
/** The browser's other messages about a request. */
export type LocalCancel = { r: number; cancel: true };
/** The helper's other messages about a request. */
export type LocalReply = { r: number; ready: true } | { r: number; end: number } | { r: number; error: string };

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
