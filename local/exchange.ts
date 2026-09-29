import type { Agent, ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:http";
import type { DataChannel } from "node-datachannel";
import {
  isLocalRoute,
  LOCAL,
  LOCAL_TOKEN_HEADER,
  pickHeaders,
  REQUEST_HEADERS,
  RESPONSE_HEADERS,
  type LocalControl,
  type LocalRequest,
  type LocalResponse,
} from "../shared/local.ts";
import { LIMITS } from "../shared/model.ts";
import { hold } from "./channels.ts";

/** How long a new channel may take to name its request. */
const HEAD_TIMEOUT_MS = 10_000;

export type Upstream = { socketPath: string; agent: Agent; token: string };

/**
 * Carries one request from a data channel to Relay and its response back (see shared/local.ts).
 * Relay's socket applies its own timeouts; closing the channel cancels the request, and so does the
 * function returned, for a connection that closes without reporting its channels closed.
 */
export function exchange(channel: DataChannel, upstream: Upstream, onDone: () => void): () => void {
  let req: ClientRequest | null = null;
  let res: IncomingMessage | null = null;
  let length = 0;
  let received = 0;
  /** Request body bytes handed to Relay's socket, and how many of them were credited back. */
  let written = 0;
  let credited = 0;
  /** Response bytes the browser will still take. */
  let allowance: number = LOCAL.windowBytes;
  const queue: Buffer[] = [];
  let ended = false;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(headTimer);
    req?.destroy();
    res?.destroy();
    onDone();
  };
  /** Ends the exchange with an error the browser can act on: it sends the request the usual way. */
  const abandon = (error: string) => {
    if (finished) return;
    send({ error });
    finish();
    channel.close();
  };
  /** Sends while the channel is open; a closed channel ends the exchange through onClosed. */
  const deliver = (message: string | Buffer) => {
    if (!channel.isOpen()) return false;
    try {
      // False only means the message was queued behind others.
      if (typeof message === "string") channel.sendMessage(message);
      else channel.sendMessageBinary(message);
      return true;
    } catch {
      return false;
    }
  };
  const send = (message: LocalControl | LocalResponse) => deliver(JSON.stringify(message));
  const headTimer = setTimeout(() => abandon("No request arrived."), HEAD_TIMEOUT_MS);

  const pump = () => {
    while (queue.length && allowance >= queue[0].length) {
      const piece = queue.shift()!;
      allowance -= piece.length;
      if (!deliver(piece)) return finish();
    }
    if (queue.length) res?.pause();
    else if (ended) {
      send({ end: true });
      // The browser closes the channel once it has read the end.
      finished = true;
      onDone();
    } else res?.resume();
  };

  const start = (head: LocalRequest) => {
    clearTimeout(headTimer);
    length = head.length;
    req = request(
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
        send({ status: response.statusCode ?? 502, headers: pickHeaders(response.headers, RESPONSE_HEADERS) });
        response.on("data", (chunk: Buffer) => {
          for (let at = 0; at < chunk.length; at += LOCAL.messageBytes)
            queue.push(chunk.subarray(at, at + LOCAL.messageBytes));
          pump();
        });
        response.on("end", () => {
          ended = true;
          // Relay answered before taking the whole body (a refused chunk): drop the connection that
          // still expects it rather than return it to the pool.
          if (received < length) req?.destroy();
          pump();
        });
        response.on("error", () => abandon("Relay stopped answering."));
      },
    );
    // Relay answered before the whole body arrived (a refused chunk): the rest is not needed.
    req.on("error", () => {
      if (!res) abandon("Relay is not answering.");
    });
    if (!length) req.end();
  };

  channel.onMessage((message) => {
    if (finished) return;
    if (typeof message === "string") {
      if (!req) {
        const head = parseHead(message);
        return head ? start(head) : abandon("That request can't travel on this connection.");
      }
      const control = parseControl(message);
      if (!control) return abandon("The connection sent something unexpected.");
      allowance += control.credit;
      return pump();
    }
    const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message);
    if (!req || res || received + bytes.length > length) {
      // Bytes after Relay answered belong to a body it refused; any others break the protocol.
      if (res) return;
      return abandon("The request sent more than it announced.");
    }
    received += bytes.length;
    const request = req;
    request.write(bytes, (error) => {
      if (error || finished) return;
      written += bytes.length;
      if (written - credited >= LOCAL.creditBytes || written === length) {
        send({ credit: written - credited });
        credited = written;
      }
    });
    if (received === length) request.end();
  });
  hold(channel, finish);
  channel.onError(finish);
  return finish;
}

function parseHead(message: string): LocalRequest | null {
  if (message.length > LOCAL.headBytes) return null;
  let head: Partial<LocalRequest>;
  try {
    head = JSON.parse(message) as Partial<LocalRequest>;
  } catch {
    return null;
  }
  const { method, path, headers, length } = head;
  if (typeof method !== "string" || typeof path !== "string" || !isLocalRoute(method, path)) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const limit = method === "PATCH" ? LIMITS.chunkBytes : 0;
  if (!Number.isSafeInteger(length) || length! < 0 || length! > limit) return null;
  return { method, path, headers, length: length! };
}

function parseControl(message: string): { credit: number } | null {
  try {
    const control = JSON.parse(message) as { credit?: unknown };
    const credit = control.credit;
    return typeof credit === "number" && Number.isSafeInteger(credit) && credit > 0 && credit <= LOCAL.windowBytes
      ? { credit }
      : null;
  } catch {
    return null;
  }
}
