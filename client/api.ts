import { api, headers, type Endpoint, type Input, type NoFields, type Response } from "../shared/api";
import { uuidv7 } from "../shared/ids";
import { isProxyFailure, reportFailure, reportReachable } from "./lib/connection";

export { api, urls } from "../shared/api";
export { LIMITS, DEFAULTS, LINK_USED_UP, displayName } from "../shared/model";
export type * from "../shared/model";

/** This page load. Transfers belong to it: closing or reloading the tab abandons them. */
let tabId = uuidv7().replaceAll("-", "");
let principal: string | null = null;
export const tab = () => tabId;

/**
 * Bind this page's tab identity to its signed-in member and device. A principal transition gets a
 * fresh identity so a later account cannot renew or continue the previous account's tab lease.
 */
export function setPrincipal(value: string | null) {
  if (principal === value) return;
  principal = value;
  tabId = uuidv7().replaceAll("-", "");
}

let csrf = "";
const csrfListeners = new Set<() => void>();
export const csrfToken = () => csrf;
export function setCsrf(value: string) {
  csrf = value;
  if (value) csrfListeners.forEach((fn) => fn());
}
/** Runs `fn` once a CSRF token is known (now, or after sign-in). */
export function onCsrf(fn: () => void) {
  csrfListeners.add(fn);
  if (csrf) fn();
  return () => csrfListeners.delete(fn);
}
/** Headers every same-origin write needs; tus uploads and keepalive beacons use them too. */
export const writeHeaders = (): Record<string, string> => ({
  ...(csrf ? { [headers.csrf]: csrf } : {}),
  [headers.tab]: tab(),
});

export class ApiError extends Error {
  readonly status: number;
  /** Seconds until a refused (429) request may be tried again, when the server said. */
  readonly retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const SIGN_IN_PATHS = new Set<string>([
  api.session.password.path,
  api.session.passkey.path,
  api.session.code.path,
  api.session.deviceLink.path,
  api.session.join.path,
]);

/** The message for a response without a JSON body, which comes from a proxy or a cut-off reply. */
function unreadable(status: number): string {
  if (status === 413) return "That is too large for the server to accept.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  // The proxy in front of Relay answered for it: Relay is down or restarting.
  if (status >= 500) return "Relay isn’t responding right now.";
  // Headers arrived but the body was cut off. Creates carry client ids, so retrying is safe.
  return "The connection was interrupted. Try again.";
}

/** Calls a contract endpoint. Rejects with ApiError carrying the server's message. */
export async function call<E extends Endpoint>(
  endpoint: E,
  ...[input]: NoFields extends Input<E> ? [Input<E>?] : [Input<E>]
): Promise<Response<E>> {
  const { params, query, body } = (input ?? {}) as {
    params?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  };
  let url: string = endpoint.path;
  for (const [key, value] of Object.entries(params ?? {})) url = url.replace(`:${key}`, encodeURIComponent(value));
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
    if (search.size) url += `?${search}`;
  }
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: endpoint.method,
      credentials: "same-origin",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...writeHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // Browsers word network failures differently; status 0 marks it as retryable.
    reportFailure();
    throw new ApiError(0, "Relay couldn’t be reached.");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    if (!res.status || res.status >= 500 || isProxyFailure(res.status)) reportFailure();
    throw new ApiError(res.status, unreadable(res.status));
  }
  // Relay itself answered, whatever it said.
  reportReachable();
  if (!res.ok) {
    const message = (data as { error?: string })?.error || "Request failed.";
    if (
      !SIGN_IN_PATHS.has(endpoint.path) &&
      (res.status === 401 || (res.status === 403 && message === "Your session has changed. Refresh and retry."))
    )
      window.dispatchEvent(new Event("relay-session-expired"));
    const wait = res.status === 429 ? Number(res.headers.get("retry-after")) : NaN;
    throw new ApiError(res.status, message, wait > 0 ? Math.ceil(wait) : undefined);
  }
  return data as Response<E>;
}

const STABLE_IDS = "relay.stable-ids";
/**
 * A client id for one logical create (a link, a delivery, a request), reused while the same
 * action is retried in this tab session — including across a reload — so the server can make the
 * create idempotent. Call `forget` once it succeeded.
 */
export function stableId(key: string): { id: string; forget: () => void } {
  let saved: Record<string, string>;
  try {
    saved = JSON.parse(sessionStorage.getItem(STABLE_IDS) || "{}") as Record<string, string>;
  } catch {
    saved = {};
  }
  const scoped = `${csrf}:${key}`;
  const id = saved[scoped] || uuidv7();
  const write = (next: Record<string, string>) => {
    try {
      const entries = Object.entries(next).slice(-64);
      if (entries.length) sessionStorage.setItem(STABLE_IDS, JSON.stringify(Object.fromEntries(entries)));
      else sessionStorage.removeItem(STABLE_IDS);
    } catch {
      // Without storage the id still covers retries within this page.
    }
  };
  write({ ...saved, [scoped]: id });
  return {
    id,
    forget: () => {
      try {
        const current = JSON.parse(sessionStorage.getItem(STABLE_IDS) || "{}") as Record<string, string>;
        delete current[scoped];
        write(current);
      } catch {
        // Nothing to forget.
      }
    },
  };
}
