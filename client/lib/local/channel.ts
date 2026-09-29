import { LOCAL, type LocalControl, type LocalRequest, type LocalResponse } from "../../../shared/local";

// One HTTP request on a data channel of its own (see shared/local.ts): a head, the body in credited
// pieces, then the response head, its body under the same credit, and an end.

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

/** Sends `request` on `channel`, new or open but unused, and closes it once answered. */
export function exchange(channel: RTCDataChannel, request: ChannelRequest): Promise<ChannelResponse> {
  const body = request.body ?? new Blob();
  channel.binaryType = "arraybuffer";
  return new Promise<ChannelResponse>((resolve, reject) => {
    let head = false;
    let done = false;
    /** Request body bytes sent, bytes the helper may still take, and bytes Relay has taken. */
    let sent = 0;
    let allowance: number = LOCAL.windowBytes;
    let taken = 0;
    let reading = false;
    /** Response body bytes received and not yet credited back. */
    let owed = 0;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const stream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          controller = c;
        },
        // Called whenever the queue has room: after each read, and after each piece arrives.
        pull: () => {
          credit();
          watch();
        },
        cancel: () => close(),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: LOCAL.windowBytes }),
    );

    const close = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      request.signal?.removeEventListener("abort", aborted);
      channel.onmessage = channel.onclose = channel.onerror = null;
      channel.close();
    };
    const fail = (error: Error) => {
      if (done) return;
      close();
      if (head) controller.error(error);
      else reject(error);
    };
    const aborted = () => fail(new DOMException("The request was stopped.", "AbortError"));
    request.signal?.addEventListener("abort", aborted);
    if (request.signal?.aborted) return aborted();

    /** Waiting counts only while the helper owes something: the response head, or bytes it has credit for. */
    const watch = () => {
      clearTimeout(idle);
      const owedByHelper = !head || (controller.desiredSize ?? 0) > 0;
      if (!done && owedByHelper)
        idle = setTimeout(() => fail(new LocalFailure("The direct connection stopped answering.")), IDLE_MS);
    };
    const credit = () => {
      // Credit returns only while the queue has room, so a slow reader holds the helper at its window.
      if (done || owed < LOCAL.creditBytes || (controller.desiredSize ?? 0) <= 0) return;
      const message: LocalControl = { credit: owed };
      owed = 0;
      send(JSON.stringify(message));
    };
    const send = (message: string | ArrayBuffer) => {
      try {
        channel.send(message as never);
      } catch {
        fail(new LocalFailure("The direct connection closed."));
      }
    };

    /** Sends body pieces while the helper has room; reads the file a window at a time. */
    const sendBody = async () => {
      if (reading) return;
      reading = true;
      try {
        while (!done && !head && sent < body.size && allowance > 0) {
          const size = Math.min(allowance, LOCAL.windowBytes, body.size - sent);
          const bytes = await body.slice(sent, sent + size).arrayBuffer();
          if (done || head) return;
          for (let at = 0; at < bytes.byteLength; at += LOCAL.messageBytes)
            send(bytes.slice(at, at + LOCAL.messageBytes));
          sent += bytes.byteLength;
          allowance -= bytes.byteLength;
        }
      } catch {
        fail(new LocalFailure("The file could not be read."));
      } finally {
        reading = false;
      }
    };

    channel.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
      if (done) return;
      if (typeof data !== "string") {
        if (!head) return fail(new LocalFailure("The direct connection sent something unexpected."));
        owed += data.byteLength;
        controller.enqueue(new Uint8Array(data));
        return;
      }
      let message: LocalResponse | LocalControl;
      try {
        message = JSON.parse(data) as LocalResponse | LocalControl;
      } catch {
        return fail(new LocalFailure("The direct connection sent something unexpected."));
      }
      if ("status" in message) {
        head = true;
        request.onProgress?.(taken);
        resolve({ status: message.status, headers: new Headers(message.headers), body: stream });
      } else if ("credit" in message) {
        allowance += message.credit;
        taken += message.credit;
        request.onProgress?.(taken);
        void sendBody();
      } else if ("end" in message) {
        if (!head) return fail(new LocalFailure("The direct connection ended the request early."));
        close();
        controller.close();
        return;
      } else return fail(new LocalFailure(message.error));
      watch();
    };
    channel.onclose = () => fail(new LocalFailure("The direct connection closed."));
    channel.onerror = () => fail(new LocalFailure("The direct connection failed."));

    const start: LocalRequest = {
      method: request.method,
      path: request.path,
      headers: request.headers ?? {},
      length: body.size,
    };
    const begin = () => {
      send(JSON.stringify(start));
      watch();
      void sendBody();
    };
    // A new channel opens a moment after it's made; the helper answers it at once.
    if (channel.readyState === "open") begin();
    else opened(channel, IDLE_MS).then(() => !done && begin(), fail);
  });
}

/** Resolves once `channel` is open. */
export function opened(channel: RTCDataChannel, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (channel.readyState === "open") return resolve();
    const timer = setTimeout(() => {
      cleanup();
      reject(new LocalFailure("The direct connection didn't open in time."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", open);
      channel.removeEventListener("close", closed);
    };
    const open = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new LocalFailure("The direct connection closed."));
    };
    channel.addEventListener("open", open);
    channel.addEventListener("close", closed);
  });
}
