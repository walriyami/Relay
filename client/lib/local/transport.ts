import type { HttpRequest, HttpResponse, HttpStack } from "tus-js-client";
import { isLocalRoute } from "../../../shared/local";
import { LocalFailure } from "./exchange";
import { isDirect, openRequest } from "./link";

// Upload requests, sent straight to Relay while the direct connection is ready and the route may
// travel on it (see shared/local.ts), and the usual way otherwise. A request that fails on the direct
// connection rejects with LocalFailure and drops the connection, so the same request sent again goes
// the usual way.

export type Route = "direct" | "relay";
export { LocalFailure };

/**
 * The route a request takes if it starts now. Only a member's own requests may go direct: the helper
 * acts for the session that set up the connection and carries no cookies, so a guest's grant would
 * not travel.
 */
export const routeFor = (method: string, url: string, member: boolean): Route =>
  member && isDirect() && isLocalRoute(method, pathOf(url)) ? "direct" : "relay";

/** A URL on Relay's origin as a direct request names it: path and query. */
export function pathOf(url: string) {
  const parsed = new URL(url, location.origin);
  return parsed.pathname + parsed.search;
}

export type Request = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Blob;
  /** Request body bytes sent so far (directly: bytes Relay has taken). */
  onProgress?: (sent: number) => void;
};
export type Answer = { status: number; header: (name: string) => string | null; text: string };
export type Sending = { answer: Promise<Answer>; abort: () => void };

/**
 * Sends `request` by `route`. The answer rejects with an AbortError once aborted, with LocalFailure
 * when the direct connection failed it, and with another Error when the usual way did.
 */
export const send = (route: Route, request: Request): Sending =>
  route === "direct" ? direct(request) : relay(request);

const stoppedError = () => new DOMException("The request was stopped.", "AbortError");

function relay(request: Request): Sending {
  const xhr = new XMLHttpRequest();
  const answer = new Promise<Answer>((resolve, reject) => {
    xhr.open(request.method, request.url);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    const { onProgress } = request;
    if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () =>
      resolve({ status: xhr.status, header: (name) => xhr.getResponseHeader(name), text: xhr.responseText });
    xhr.onerror = () => reject(new Error("The connection was interrupted."));
    xhr.onabort = () => reject(stoppedError());
    xhr.send(request.body ?? null);
  });
  return { answer, abort: () => xhr.abort() };
}

function direct(request: Request): Sending {
  const controller = new AbortController();
  const answer = (async (): Promise<Answer> => {
    const opened = openRequest();
    if (!opened) throw new LocalFailure("The direct connection isn't ready.");
    try {
      const res = await opened.send({
        method: request.method,
        path: pathOf(request.url),
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        body: request.body,
        onProgress: request.onProgress,
        signal: controller.signal,
      });
      const text = await readText(res.body);
      // Relay no longer knows the connection's session key: it restarted since it was set up.
      if (res.status === 421) throw new LocalFailure("The direct connection needs setting up again.");
      opened.done();
      return { status: res.status, header: (name) => res.headers.get(name), text };
    } catch (error) {
      if (error instanceof LocalFailure) opened.failed();
      else opened.done();
      throw error;
    }
  })();
  return { answer, abort: () => controller.abort() };
}

/** Reads a small response body; a failure is the stream's own error, as a LocalFailure stays one. */
async function readText(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * tus's HTTP layer. Each request's route is chosen as tus opens it, which is before tus cuts the
 * chunk it sends, so `onRoute` can size the chunk for the route.
 */
export function tusStack(member: boolean, onRoute: (route: Route) => void): HttpStack {
  return {
    createRequest(method, url) {
      const route = routeFor(method, url, member);
      onRoute(route);
      return new TusRequest(route, method, url);
    },
    getName: () => "RelayHttpStack",
  };
}

class TusRequest implements HttpRequest {
  private readonly route: Route;
  private readonly method: string;
  private readonly url: string;
  private readonly headers: Record<string, string> = {};
  private progress?: (sent: number) => void;
  private sending?: Sending;
  private aborted = false;

  constructor(route: Route, method: string, url: string) {
    this.route = route;
    this.method = method;
    this.url = url;
  }
  getMethod() {
    return this.method;
  }
  getURL() {
    return this.url;
  }
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getHeader(name: string) {
    return this.headers[name];
  }
  setProgressHandler(handler: (sent: number) => void) {
    this.progress = handler;
  }
  async send(body?: unknown): Promise<HttpResponse> {
    if (this.aborted) throw stoppedError();
    if (body != null && !(body instanceof Blob)) throw new TypeError("Uploads send files.");
    this.sending = send(this.route, {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: body ?? undefined,
      onProgress: this.progress,
    });
    const { status, header, text } = await this.sending.answer;
    return {
      getStatus: () => status,
      getHeader: (name: string) => header(name) ?? undefined,
      getBody: () => text,
      getUnderlyingObject: () => null,
    };
  }
  abort() {
    this.aborted = true;
    this.sending?.abort();
    return Promise.resolve();
  }
  getUnderlyingObject() {
    return null;
  }
}
