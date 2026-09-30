import type { Inbound, Mux, Outbound } from "../../../shared/lanes";
import { LOCAL, type LocalCancel, type LocalReply, type LocalRequest, type LocalResponse } from "../../../shared/local";

// HTTP requests on the direct connection (see shared/local.ts): the request, its body once the
// helper is ready for it, then the response head and its body, each body spread over the lanes.

/** The direct connection failed this request; sent the usual way, it may well succeed. */
export class LocalFailure extends Error {}

/** How long a request may wait on the helper while it owes an answer or bytes. */
const IDLE_MS = 30_000;

export type ChannelRequest = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Blob;
  /** Request body bytes Relay has taken so far. */
  onProgress?: (sent: number) => void;
  signal?: AbortSignal;
};
export type ChannelResponse = {
  status: number;
  headers: Headers;
  /** Read at the pace it is consumed: the helper sends only what this side has room for. */
  body: ReadableStream<Uint8Array>;
};

/** The requests on one connection. */
export class Exchanges {
  private readonly mux: Mux;
  private next = 1;
  private readonly waiting = new Map<number, (message: LocalResponse | LocalReply | null) => void>();

  constructor(mux: Mux) {
    this.mux = mux;
  }

  /** A control message from the helper, for the request it names. */
  control(message: Record<string, unknown>) {
    if (typeof message.r === "number") this.waiting.get(message.r)?.(message as LocalResponse | LocalReply);
  }

  /** The connection is gone: every request on it fails. */
  close() {
    for (const handle of [...this.waiting.values()]) handle(null);
  }

  /** Sends `request`; its response streams in as the helper sends it. */
  send(request: ChannelRequest): Promise<ChannelResponse> {
    const r = this.next++;
    const body = request.body ?? new Blob();
    return new Promise<ChannelResponse>((resolve, reject) => {
      let head = false;
      let done = false;
      /** Request body bytes Relay has taken. */
      let taken = 0;
      let out: Outbound | null = null;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let room: (() => void) | null = null;

      const stream = new ReadableStream<Uint8Array>(
        {
          start: (c) => {
            controller = c;
          },
          // Called whenever the queue has room: after each read, and after each piece arrives.
          pull: () => {
            room?.();
            watch();
          },
          cancel: () => stop(true),
        },
        new ByteLengthQueuingStrategy({ highWaterMark: LOCAL.windowBytes }),
      );
      const into: Inbound = this.mux.incoming(r, {
        window: LOCAL.windowBytes,
        write: async (bytes) => {
          controller.enqueue(bytes);
          watch();
          // Credit returns only while the queue has room, so a slow reader holds the helper at its window.
          while (!done && (controller.desiredSize ?? 0) <= 0) await new Promise<void>((resolve) => (room = resolve));
        },
        done: () => {
          stop(false);
          controller.close();
        },
        failed: () => fail(new LocalFailure("The direct connection sent something unexpected.")),
      });

      /** Ends the request here; `cancel` tells the helper, when it hasn't finished it. */
      const stop = (cancel: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(idle);
        this.waiting.delete(r);
        request.signal?.removeEventListener("abort", aborted);
        out?.close();
        into.close();
        room?.();
        if (cancel) this.mux.send({ r, cancel: true } satisfies LocalCancel);
      };
      const fail = (error: Error) => {
        if (done) return;
        stop(true);
        if (head) controller.error(error);
        else reject(error);
      };
      const aborted = () => fail(new DOMException("The request was stopped.", "AbortError"));
      request.signal?.addEventListener("abort", aborted);
      if (request.signal?.aborted) return aborted();

      /** Waiting counts only while the helper owes something: the response head, or bytes it has credit for. */
      const watch = () => {
        clearTimeout(idle);
        const owed = !head || (controller.desiredSize ?? 0) > 0;
        if (!done && owed)
          idle = setTimeout(() => fail(new LocalFailure("The direct connection stopped answering.")), IDLE_MS);
      };

      /** Sends the body while the helper has room for it, reading the file a piece at a time. */
      let reading = false;
      const sendBody = async () => {
        if (reading || !out) return;
        reading = true;
        try {
          while (!done && !head && out.offset < body.size && out.room > 0) {
            const at = out.offset;
            const size = Math.min(out.room, LOCAL.readBytes, body.size - at);
            const bytes = await body.slice(at, at + size).arrayBuffer();
            if (done || head) return;
            out.write(new Uint8Array(bytes));
          }
        } catch {
          fail(new LocalFailure("The file could not be read."));
        } finally {
          reading = false;
        }
      };

      this.waiting.set(r, (message) => {
        if (done) return;
        if (!message) return fail(new LocalFailure("The direct connection closed."));
        if ("status" in message) {
          head = true;
          // Relay answered: whatever of the body it didn't take, it won't.
          out?.close();
          request.onProgress?.(taken);
          resolve({ status: message.status, headers: new Headers(message.headers), body: stream });
        } else if ("ready" in message) {
          if (out || !body.size) return fail(new LocalFailure("The direct connection sent something unexpected."));
          out = this.mux.outgoing(r, 0, LOCAL.windowBytes);
          out.onReady = () => void sendBody();
          out.onCredit = (bytes) => {
            taken += bytes;
            request.onProgress?.(taken);
            watch();
          };
          void sendBody();
        } else if ("end" in message) {
          if (!head) return fail(new LocalFailure("The direct connection ended the request early."));
          into.end(message.end);
        } else if ("error" in message) return fail(new LocalFailure(message.error));
        watch();
      });

      const start: LocalRequest = {
        r,
        method: request.method,
        path: request.path,
        headers: request.headers ?? {},
        length: body.size,
      };
      if (!this.mux.send(start)) return fail(new LocalFailure("The direct connection closed."));
      watch();
    });
  }
}
