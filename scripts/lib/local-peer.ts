// A browser's side of a direct connection (see shared/local.ts), in Node: node-datachannel stands in
// for RTCPeerConnection, so tests and verification drive the helper and Relay's socket exactly as a
// page does, lanes and all.
import nodeDataChannel, { type DataChannel, type PeerConnection } from "node-datachannel";
import { api } from "../../shared/api.ts";
import { LANES, Mux, type Lane } from "../../shared/lanes.ts";
import { LOCAL, type LocalReply, type LocalResponse } from "../../shared/local.ts";
import { feed, laneChannel, laneOf } from "../../local/lanes.ts";
import type { Session } from "./relay.ts";

export type LocalAnswer = { status: number; headers: Record<string, string>; body: Buffer };
export type LocalFetch = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  /** Holds the response back: each run of bytes that earns credit waits this long to be taken. */
  creditDelayMs?: number;
  /** Called before each of those runs earns its credit, with the body bytes arrived so far and the most the helper was allowed to send. */
  onCredit?: (arrived: number, allowed: number) => void;
};

const HEADER = 12;

export class LocalPeer {
  readonly mux: Mux;
  private readonly pcs: PeerConnection[];
  private next = 1;
  private readonly waiting = new Map<number, (message: LocalResponse | LocalReply) => void>();
  /** Response body bytes that arrived, and that were credited back, over the connection's life. */
  private arrived = 0;
  private credited = 0;
  /** Resolves once the connection is over. */
  readonly closed: Promise<void>;
  private onClosed = () => {};
  private answered = (_answers: string[]) => {};

  private constructor(pc: PeerConnection, channel: DataChannel) {
    this.pcs = [pc];
    this.closed = new Promise((resolve) => (this.onClosed = resolve));
    const lane = laneOf(channel);
    this.mux = new Mux(
      {
        send: (data) => {
          if (typeof data === "string" && data.startsWith('{"s":'))
            this.credited += (JSON.parse(data) as { credit: number }).credit;
          lane.send(data);
        },
        buffered: () => lane.buffered(),
      },
      {
        control: (message) => {
          if (Array.isArray(message.lanes)) return this.answered(message.lanes as string[]);
          if (typeof message.r === "number") this.waiting.get(message.r)?.(message as LocalResponse | LocalReply);
        },
        broken: () => this.close(),
      },
      LOCAL.messageChars,
    );
    this.use(channel);
    pc.onStateChange((state) => {
      if (state === "failed" || state === "closed") this.close();
    });
  }

  /** Sets up a connection the way the page does, signed in as `client`, and waits for its lanes. */
  static async connect(client: Pick<Session, "call">): Promise<LocalPeer> {
    const { pc, channel, opened } = offering(() => peer?.close());
    let peer: LocalPeer | undefined;
    try {
      const { answer } = await client.call(api.local.connect, { body: { offer: await offer(pc) } });
      pc.setRemoteDescription(answer, "answer");
      await opened;
      peer = new LocalPeer(pc, channel);
      await peer.widen();
      return peer;
    } catch (error) {
      peer?.close();
      pc.close();
      throw error;
    }
  }

  /** Lanes carrying bytes. */
  get width() {
    return this.mux.width;
  }

  /** Offers the other lanes on the first, as the page does, and waits for them to open. */
  private async widen() {
    // Any lane but the first may go; what it carried goes on the others.
    const joined = new Map<number, Lane>();
    const gone = (i: number) => {
      const lane = joined.get(i);
      if (lane) this.mux.remove(lane);
    };
    const lanes = Array.from({ length: LANES.count - 1 }, (_, i) => offering(() => gone(i)));
    const answers = new Promise<string[]>((resolve) => (this.answered = resolve));
    this.mux.send({ lanes: await Promise.all(lanes.map(({ pc }) => offer(pc))) });
    const sdps = await answers;
    for (const { pc } of lanes.slice(sdps.length)) pc.close();
    await Promise.all(
      sdps.map(async (sdp, i) => {
        const { pc, channel, opened } = lanes[i];
        this.pcs.push(pc);
        pc.setRemoteDescription(sdp, "answer");
        await opened;
        this.use(channel);
        joined.set(i, laneOf(channel));
        this.mux.add(joined.get(i)!);
        pc.onStateChange((state) => {
          if (state === "failed" || state === "closed") gone(i);
        });
      }),
    );
  }

  private use(channel: DataChannel) {
    feed(this.mux, channel);
    // Counting what arrives on the way.
    const deliver = (message: string | Buffer | ArrayBuffer) => {
      if (typeof message !== "string") this.arrived += message.byteLength - HEADER;
      this.mux.receive(message);
    };
    channel.onMessage(deliver);
  }

  /** Closes lane `index` (not the first), as a lane that lost its path for good. */
  dropLane(index: number) {
    if (index < 1) throw new RangeError("The first lane is the connection.");
    this.pcs[index].close();
  }

  /** The next request's number. */
  number() {
    return this.next++;
  }

  /** Sends a control message as is, for tests that break the protocol. */
  control(message: unknown) {
    this.mux.send(message as object);
  }

  /** The helper's next message about request `r`. */
  reply(r: number) {
    return new Promise<LocalResponse | LocalReply>((resolve, reject) => {
      this.waiting.set(r, (message) => {
        this.waiting.delete(r);
        resolve(message);
      });
      void this.closed.then(() => reject(new Error("The connection closed.")));
    });
  }

  /** One request, answered in full. */
  fetch(request: LocalFetch): Promise<LocalAnswer> {
    const r = this.number();
    const body = request.body ?? Buffer.alloc(0);
    return new Promise<LocalAnswer>((resolve, reject) => {
      let head: LocalResponse | null = null;
      const chunks: Buffer[] = [];
      let owed = 0;
      const fail = (error: Error) => {
        this.waiting.delete(r);
        into.close();
        reject(error);
      };
      const into = this.mux.incoming(r, {
        window: LOCAL.windowBytes,
        write: async (bytes) => {
          chunks.push(Buffer.from(bytes));
          owed += bytes.byteLength;
          if (!request.creditDelayMs || owed < LANES.creditBytes) return;
          owed = 0;
          await new Promise((wait) => setTimeout(wait, request.creditDelayMs));
          request.onCredit?.(this.arrived, LOCAL.windowBytes + this.credited);
        },
        done: () => {
          this.waiting.delete(r);
          resolve({ status: head!.status, headers: head!.headers, body: Buffer.concat(chunks) });
        },
        failed: (error) => fail(error as Error),
      });
      this.waiting.set(r, (message) => {
        if ("status" in message) head = message;
        else if ("ready" in message) {
          const out = this.mux.outgoing(r, 0, LOCAL.windowBytes);
          const send = () => {
            while (!head && out.offset < body.length && out.room > 0)
              out.write(body.subarray(out.offset, out.offset + Math.min(out.room, LOCAL.readBytes)));
          };
          out.onReady = send;
          send();
        } else if ("end" in message) into.end(message.end);
        else fail(new Error(message.error));
      });
      void this.closed.then(() => fail(new Error("The connection closed.")));
      this.mux.send({
        r,
        method: request.method ?? "GET",
        path: request.path,
        headers: request.headers ?? {},
        length: body.length,
      });
    });
  }

  close() {
    this.mux.close();
    for (const pc of this.pcs) pc.close();
    this.onClosed();
  }
}

/** A lane's peer connection, offering; `opened` resolves when its channel opens. */
function offering(onClosed: () => void) {
  const pc = new nodeDataChannel.PeerConnection("browser", { iceServers: [], maxMessageSize: LANES.frameBytes });
  // Offering, node-datachannel creates the channel before any description, and offers on its own.
  const channel = laneChannel(pc, onClosed);
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The lane did not open.")), 5000);
    channel.onOpen(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  opened.catch(() => pc.close());
  return { pc, channel, opened };
}

/** `pc`'s offer, with its candidates, as a page's offer has them. */
function offer(pc: PeerConnection) {
  return until(() => (pc.gatheringState() === "complete" ? pc.localDescription()?.sdp : undefined));
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < timeoutMs;) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out.");
}
