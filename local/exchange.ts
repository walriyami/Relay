import type { Agent, ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:http";
import type { Inbound, Mux, Outbound } from "../shared/lanes.ts";
import {
  isLocalRoute,
  LOCAL,
  LOCAL_TOKEN_HEADER,
  pickHeaders,
  REQUEST_HEADERS,
  RESPONSE_HEADERS,
  type LocalReply,
  type LocalRequest,
  type LocalResponse,
} from "../shared/local.ts";
import { LIMITS } from "../shared/model.ts";

export type Upstream = { socketPath: string; agent: Agent; token: string };

/**
 * The requests one connection carries to Relay, and their responses back (see shared/local.ts).
 * Relay's socket applies its own timeouts; the browser cancelling a request, or the connection
 * closing, abandons it.
 */
export class Exchanges {
  private readonly mux: Mux;
  private readonly upstream: Upstream;
  /** Cancels each request in flight, by number. */
  private readonly running = new Map<number, () => void>();
  private last = 0;

  constructor(mux: Mux, upstream: Upstream) {
    this.mux = mux;
    this.upstream = upstream;
  }

  /** A control message from the browser; false when it breaks the protocol. */
  control(message: Record<string, unknown>) {
    const { r } = message;
    if (typeof r !== "number") return false;
    if (message.cancel === true) {
      this.running.get(r)?.();
      return true;
    }
    // Numbered in order, so a request is never mistaken for one before it.
    if (!Number.isSafeInteger(r) || r <= this.last) return false;
    this.last = r;
    const head = parseHead(message);
    if (!head) this.mux.send({ r, error: "That request can't travel on this connection." } satisfies LocalReply);
    else if (this.running.size >= LOCAL.requests)
      this.mux.send({ r, error: "Too many requests at once." } satisfies LocalReply);
    else
      this.running.set(
        r,
        exchange(this.mux, head, this.upstream, () => this.running.delete(r)),
      );
    return true;
  }

  /** The connection is gone: every request on it is abandoned. */
  close() {
    for (const cancel of [...this.running.values()]) cancel();
  }
}

/** Carries one request to Relay and its response back; the function returned abandons it. */
function exchange(mux: Mux, head: LocalRequest, upstream: Upstream, onDone: () => void): () => void {
  const { r, length } = head;
  let res: IncomingMessage | null = null;
  let into: Inbound | null = null;
  let out: Outbound | null = null;
  /** Whether Relay has the whole request body. */
  let taken = !length;
  /** Response body bytes read from Relay, and credited back by the browser; those not on the lanes yet. */
  let read = 0;
  let credited = 0;
  const queue: Buffer[] = [];
  let ended = false;
  let finished = false;

  /** The browser has the whole response. */
  const complete = () => {
    if (finished) return;
    finished = true;
    out?.close();
    onDone();
  };
  /** Abandons the request, and Relay's connection with it. */
  const finish = () => {
    if (finished) return;
    finished = true;
    into?.close();
    out?.close();
    req.destroy();
    res?.destroy();
    onDone();
  };
  /** Ends the request with an error the browser can act on: it sends the request the usual way. */
  const abandon = (error: string) => {
    if (finished) return;
    mux.send({ r, error } satisfies LocalReply);
    finish();
  };

  const pump = () => {
    if (finished || !out || !res) return;
    while (queue.length && out.room > 0) {
      const piece = queue[0];
      const size = Math.min(piece.length, out.room);
      out.write(piece.subarray(0, size));
      if (size === piece.length) queue.shift();
      else queue[0] = piece.subarray(size);
    }
    if (queue.length) res.pause();
    else if (!ended) res.resume();
  };

  const req: ClientRequest = request(
    {
      socketPath: upstream.socketPath,
      agent: upstream.agent,
      method: head.method,
      path: head.path,
      headers: {
        ...pickHeaders(head.headers, REQUEST_HEADERS),
        ...(head.method === "PATCH" ? { "content-length": String(length) } : {}),
        [LOCAL_TOKEN_HEADER]: upstream.token,
      },
    },
    (response) => {
      res = response;
      // Relay answered, perhaps before taking the whole body (a refused chunk): the rest isn't needed.
      into?.close();
      mux.send({
        r,
        status: response.statusCode ?? 502,
        headers: pickHeaders(response.headers, RESPONSE_HEADERS),
      } satisfies LocalResponse);
      out = mux.outgoing(r, 0, LOCAL.windowBytes);
      out.onReady = pump;
      out.onCredit = (bytes) => {
        credited += bytes;
        if (ended && credited === read) complete();
      };
      response.on("data", (chunk: Buffer) => {
        read += chunk.length;
        queue.push(chunk);
        pump();
      });
      response.on("end", () => {
        ended = true;
        // A connection that still expects the rest of a refused body isn't returned to the pool.
        if (!taken) req.destroy();
        mux.send({ r, end: read } satisfies LocalReply);
        // Done once the browser has every byte: until then, frames may still wait for lanes.
        if (credited === read) complete();
      });
      response.on("close", () => {
        if (!ended) abandon("Relay stopped answering.");
      });
    },
  );
  req.on("error", () => {
    if (!res) abandon("Relay is not answering.");
  });

  if (length) {
    into = mux.incoming(r, {
      to: length,
      window: LOCAL.windowBytes,
      // Credit goes back once Relay's socket has taken the bytes, so the browser runs at Relay's pace.
      write: (bytes) =>
        new Promise<void>((resolve, reject) => req.write(bytes, (error) => (error ? reject(error) : resolve()))),
      done: () => {
        taken = true;
        req.end();
      },
      failed: () => abandon("The request's body arrived out of place."),
    });
    mux.send({ r, ready: true } satisfies LocalReply);
  } else req.end();

  return finish;
}

function parseHead(message: Record<string, unknown>): LocalRequest | null {
  const { r, method, path, headers, length } = message;
  if (typeof r !== "number" || typeof method !== "string" || typeof path !== "string") return null;
  if (!isLocalRoute(method, path)) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const limit = method === "PATCH" ? LIMITS.chunkBytes : 0;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > limit) return null;
  return { r, method, path, headers: headers as Record<string, string>, length };
}
