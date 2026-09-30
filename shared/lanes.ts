// Lanes: one connection made of several WebRTC peer connections, for bulk bytes on the local network.
// A browser receiving on a peer connection lets only a few dozen kilobytes arrive per round trip,
// however fast the network is, so over Wi-Fi's round trips one connection carries a few megabits a
// second. Each further peer connection carries as much again. Nearby (browser to browser) and direct
// transfers (browser to Relay's helper) both spread their bytes over lanes this way.
//
// Every lane is a peer connection with one data channel (negotiated, id 0), ordered and reliable:
//
//   text     a JSON control message. Only the first lane carries them, so they stay in order; one too
//            long for a single message goes in pieces, "+" for each piece but the last, which is "=".
//   binary   a frame: u32 stream | f64 offset | bytes, big-endian. Any lane carries frames.
//
// A stream is one run of bytes in one direction (an entry of a Nearby transfer, the body of a direct
// request or response), numbered by the protocol above. Its receiver puts frames back in order,
// whichever lanes they came on, and hands the bytes on; the sender sends no further ahead than the
// receiver has credited: a window, then {s, credit} for each run of bytes the receiver has handed on.
//
// The first lane comes up through the signalling each protocol has; its offering side then offers
// the other lanes on it, {lanes: [sdp, …]}, and the answering side answers the same way.
//
// The first lane is the connection: losing it ends it. Any other may come and go. One that loses its
// path is taken out of use and whatever it carried that isn't credited yet is sent again on the rest;
// it's put back if it finds its path again. So a frame can arrive twice, and the second is dropped.

export const LANES = {
  /** Peer connections in a full connection, the first included. */
  count: 16,
  /** Largest frame, header included: every browser takes a message this long. */
  frameBytes: 64 * 1024,
  /** A lane holding this much unsent is full; frames wait for another. */
  laneBytes: 512 * 1024,
  /** Frames waiting for a lane before streams stop being read. */
  queueBytes: 1024 * 1024,
  /** A receiver credits bytes back in runs of at least this, so credit messages stay rare. */
  creditBytes: 1024 * 1024,
  /** Characters in each piece of a long control message; any browser takes that, in UTF-8. */
  pieceChars: 16_000,
} as const;

const HEADER = 12;

/** One lane's data channel, as each side's WebRTC library has it. */
export interface Lane {
  send(data: string | Uint8Array): void;
  /** Bytes it holds and hasn't sent yet. */
  buffered(): number;
}

export type MuxEvents = {
  /** A control message, other than a credit. */
  control(message: Record<string, unknown>): void;
  /**
   * Frames arrived for a stream this side hasn't opened: `open` may open it now. Frames for a stream
   * that stays unopened are dropped, as they are once it's closed.
   */
  open?(stream: number): void;
  /** A lane couldn't send, or the other side sent something unreadable: the connection is over. */
  broken(): void;
};

export class Mux {
  private readonly lanes: Lane[] = [];
  private readonly events: MuxEvents;
  private readonly maxMessage: number;
  private readonly inbound = new Map<number, Inbound>();
  private readonly outbound = new Map<number, Outbound>();
  /** Frames waiting for room on a lane, oldest first, from `head`. */
  private queue: Frame[] = [];
  private head = 0;
  private queued = 0;
  /** The lane to try first for the next frame. */
  private turn = 0;
  private pieces: string[] = [];
  private pieceChars = 0;
  closed = false;

  /** `first` carries control messages. `maxMessage` bounds a control message put back together. */
  constructor(first: Lane, events: MuxEvents, maxMessage: number) {
    this.lanes.push(first);
    this.events = events;
    this.maxMessage = maxMessage;
  }

  /** Lanes carrying frames now. */
  get width() {
    return this.lanes.length;
  }

  /** Another lane is open, or one taken out of use found its path again. */
  add(lane: Lane) {
    if (this.closed || this.lanes.includes(lane)) return;
    this.lanes.push(lane);
    this.flush();
  }

  /**
   * A lane other than the first lost its path, or closed: nothing more goes on it, and what it carried
   * that the receiver hasn't credited goes again on the others, ahead of anything else waiting.
   */
  remove(lane: Lane) {
    if (this.takeOut(lane)) this.flush();
  }

  private takeOut(lane: Lane) {
    const index = this.lanes.indexOf(lane);
    if (this.closed || index < 1) return false;
    this.lanes.splice(index, 1);
    if (this.turn > index) this.turn--;
    this.turn %= this.lanes.length;
    const again = [...this.outbound.values()].flatMap((out) => out.carried(lane));
    this.queue.splice(this.head, 0, ...again);
    for (const { frame } of again) this.queued += frame.byteLength;
    return true;
  }

  /** Sends a control message; false once the connection can't. */
  send(message: object) {
    if (this.closed) return false;
    const text = JSON.stringify(message);
    try {
      if (text.length <= LANES.pieceChars) this.lanes[0].send(text);
      else
        for (let at = 0; at < text.length;) {
          let end = Math.min(at + LANES.pieceChars, text.length);
          // Never between the two halves of a character outside the basic plane.
          const last = text.charCodeAt(end - 1);
          if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
          this.lanes[0].send((end < text.length ? "+" : "=") + text.slice(at, end));
          at = end;
        }
      return true;
    } catch {
      this.break();
      return false;
    }
  }

  /** A message arrived on any lane. */
  receive(data: string | ArrayBuffer | Uint8Array) {
    if (this.closed) return;
    if (typeof data === "string") return this.text(data);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength <= HEADER) return this.break();
    const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER);
    const stream = view.getUint32(0);
    const offset = view.getFloat64(4);
    if (!Number.isSafeInteger(offset) || offset < 0) return this.break();
    if (!this.inbound.has(stream)) this.events.open?.(stream);
    this.inbound.get(stream)?.frame(offset, bytes.subarray(HEADER));
  }

  /** A lane has room again. */
  drained() {
    this.flush();
  }

  /** Starts sending stream `id` from `offset`, with `allowance` bytes credited already. */
  outgoing(id: number, offset: number, allowance: number) {
    this.outbound.get(id)?.close();
    const out = new Outbound(this, id, offset, allowance);
    this.outbound.set(id, out);
    return out;
  }

  /** Starts receiving stream `id`. */
  incoming(id: number, options: InboundOptions) {
    this.inbound.get(id)?.close();
    const into = new Inbound(this, id, options);
    this.inbound.set(id, into);
    return into;
  }

  /** Ends every stream: the connection is over. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const out of [...this.outbound.values()]) out.close();
    for (const into of [...this.inbound.values()]) into.close();
    this.queue = [];
    this.head = this.queued = 0;
  }

  private break() {
    if (this.closed) return;
    this.close();
    this.events.broken();
  }

  private text(data: string) {
    let text = data;
    if (data[0] === "+" || data[0] === "=") {
      this.pieces.push(data.slice(1));
      this.pieceChars += data.length - 1;
      if (this.pieceChars > this.maxMessage) return this.break();
      if (data[0] === "+") return;
      text = this.pieces.join("");
      this.pieces = [];
      this.pieceChars = 0;
    } else if (text.length > this.maxMessage) return this.break();
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return this.break();
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.break();
    const m = message as Record<string, unknown>;
    if ("credit" in m) {
      const { s, credit } = m;
      if (typeof s !== "number" || typeof credit !== "number" || !Number.isSafeInteger(credit) || credit <= 0)
        return this.break();
      this.outbound.get(s)?.credited(credit);
      return;
    }
    this.events.control(m);
  }

  /** @internal */
  enqueue(frame: Frame) {
    this.queue.push(frame);
    this.queued += frame.frame.byteLength;
    this.flush();
  }

  /** @internal Whether streams may queue more frames now. */
  get roomy() {
    return this.queued < LANES.queueBytes;
  }

  /** @internal */
  forget(out: Outbound | Inbound) {
    const map: Map<number, Outbound | Inbound> = out instanceof Outbound ? this.outbound : this.inbound;
    if (map.get(out.id) === out) map.delete(out.id);
  }

  /** Hands waiting frames to the emptiest lane with room, and wakes streams once there's room for more. */
  private flush() {
    const wasRoomy = this.roomy;
    while (!this.closed && this.head < this.queue.length) {
      // Ties go to each lane in turn: a library that hands frames straight to its transport
      // reports every lane empty until that fills.
      let lane: Lane | null = null;
      let least: number = LANES.laneBytes;
      for (let i = 0; i < this.lanes.length; i++) {
        const candidate = this.lanes[(this.turn + i) % this.lanes.length];
        const buffered = candidate.buffered();
        if (buffered < least) {
          lane = candidate;
          least = buffered;
        }
      }
      if (!lane) break;
      this.turn = (this.lanes.indexOf(lane) + 1) % this.lanes.length;
      const next = this.queue[this.head++];
      this.queued -= next.frame.byteLength;
      if (next.out.closed) continue;
      next.out.sent(next, lane);
      try {
        lane.send(next.frame);
      } catch {
        // The first lane closed: the connection is over. Another closing only takes it out of use,
        // and the frame goes with what it carried.
        if (lane === this.lanes[0]) return this.break();
        this.takeOut(lane);
      }
    }
    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head > 1024) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    if (!wasRoomy && this.roomy) for (const out of [...this.outbound.values()]) out.onReady?.();
  }
}

/** A frame of stream `out`, starting at `offset`. */
type Frame = { out: Outbound; offset: number; frame: Uint8Array };

/** Bytes of one stream going out. */
export class Outbound {
  readonly id: number;
  private readonly mux: Mux;
  /** Offset of the next byte to send. */
  offset: number;
  /** Bytes the receiver will still take. */
  allowance: number;
  /** Offset up to which the receiver has credited every byte. */
  private credit: number;
  /** Frames on a lane and not credited yet, by offset, with the lane each went on; in offset order. */
  private readonly unsettled = new Map<number, { frame: Frame; lane: Lane }>();
  closed = false;
  /** The receiver handed on `bytes` more. */
  onCredit?: (bytes: number) => void;
  /** There may be room to write again: credit arrived, or lanes emptied. */
  onReady?: () => void;
  /** It closed: the connection went, or it was closed here. */
  onClose?: () => void;

  constructor(mux: Mux, id: number, offset: number, allowance: number) {
    this.mux = mux;
    this.id = id;
    this.offset = offset;
    this.credit = offset;
    this.allowance = allowance;
  }

  /** How much may be written now: what the receiver allows, while lanes aren't backed up. */
  get room() {
    return this.closed || !this.mux.roomy ? 0 : this.allowance;
  }

  /** Sends `bytes`, no more than `room`, from `offset` on. */
  write(bytes: Uint8Array) {
    if (this.closed) return;
    if (bytes.byteLength > this.allowance) throw new RangeError("Written past the receiver's credit.");
    const most = LANES.frameBytes - HEADER;
    for (let at = 0; at < bytes.byteLength; at += most) {
      const piece = bytes.subarray(at, at + most);
      const frame = new Uint8Array(HEADER + piece.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, this.id);
      view.setFloat64(4, this.offset + at);
      frame.set(piece, HEADER);
      this.mux.enqueue({ out: this, offset: this.offset + at, frame });
    }
    this.offset += bytes.byteLength;
    this.allowance -= bytes.byteLength;
  }

  /** @internal `frame` went on `lane`. */
  sent(frame: Frame, lane: Lane) {
    this.unsettled.set(frame.offset, { frame, lane });
  }

  /** @internal The frames `lane` carried that aren't credited yet, to send again. */
  carried(lane: Lane) {
    return [...this.unsettled.values()].filter((u) => u.lane === lane).map((u) => u.frame);
  }

  /** @internal */
  credited(bytes: number) {
    if (this.closed) return;
    this.allowance += bytes;
    this.credit += bytes;
    // Frames go on lanes in offset order, and one sent again keeps its place.
    for (const [offset, { frame }] of this.unsettled) {
      if (offset + frame.frame.byteLength - HEADER > this.credit) break;
      this.unsettled.delete(offset);
    }
    this.onCredit?.(bytes);
    this.onReady?.();
  }

  /** Stops sending; frames not yet on a lane are dropped. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsettled.clear();
    this.mux.forget(this);
    this.onClose?.();
  }
}

export type InboundOptions = {
  /** Offset of the first byte to arrive. */
  from?: number;
  /** Offset the stream ends at, when known from the start (see Inbound.end). */
  to?: number;
  /** Bytes the sender may send before any credit. */
  window: number;
  /** Takes the next bytes, in order; the next call waits for its promise. */
  write(bytes: Uint8Array): void | Promise<void>;
  /** Every byte up to the end was written. */
  done?(): void;
  /** The sender broke the stream's rules, or `write` threw: nothing more is written. */
  failed?(error: unknown): void;
};

/** Bytes of one stream coming in, put back in order and handed on. */
export class Inbound {
  readonly id: number;
  private readonly mux: Mux;
  private readonly options: InboundOptions;
  /** Offset of the next byte to hand on, and of the byte after the last the sender may send. */
  private next: number;
  private limit: number;
  private to: number | null;
  /** Bytes that arrived ahead of `next`, by offset. */
  private readonly early = new Map<number, Uint8Array>();
  /** Bytes written so far, as an offset, and those not yet credited. */
  written: number;
  private owed = 0;
  private work: Promise<void> = Promise.resolve();
  closed = false;

  constructor(mux: Mux, id: number, options: InboundOptions) {
    this.mux = mux;
    this.id = id;
    this.options = options;
    this.next = this.written = options.from ?? 0;
    this.limit = this.next + options.window;
    this.to = options.to ?? null;
  }

  /** The stream ends at offset `to`. */
  end(to: number) {
    if (this.closed) return;
    if (!Number.isSafeInteger(to) || to < this.next || (this.to !== null && to !== this.to))
      return this.fail(new Error("The stream ended in the wrong place."));
    this.to = to;
    this.check();
  }

  /** @internal */
  frame(offset: number, bytes: Uint8Array) {
    if (this.closed) return;
    const end = offset + bytes.byteLength;
    // Sent again after its lane lost its path, and here already.
    if (end <= this.next || this.early.has(offset)) return;
    if (offset < this.next || end > this.limit || (this.to !== null && end > this.to))
      return this.fail(new Error("Bytes arrived out of place."));
    if (offset > this.next) {
      this.early.set(offset, bytes);
      return;
    }
    this.take(bytes);
    for (let ahead = this.early.get(this.next); ahead; ahead = this.early.get(this.next)) {
      this.early.delete(this.next);
      this.take(ahead);
    }
  }

  private take(bytes: Uint8Array) {
    this.next += bytes.byteLength;
    this.work = this.work.then(async () => {
      if (this.closed) return;
      try {
        await this.options.write(bytes);
      } catch (error) {
        return this.fail(error);
      }
      if (this.closed) return;
      this.written += bytes.byteLength;
      this.owed += bytes.byteLength;
      this.check();
    });
  }

  /** Credits what was written, and finishes once everything was. */
  private check() {
    if (this.closed) return;
    const complete = this.to !== null && this.written === this.to;
    if (this.owed >= LANES.creditBytes || (complete && this.owed)) {
      this.limit += this.owed;
      this.mux.send({ s: this.id, credit: this.owed });
      this.owed = 0;
    }
    if (complete) {
      this.close();
      this.options.done?.();
    }
  }

  private fail(error: unknown) {
    if (this.closed) return;
    this.close();
    this.options.failed?.(error);
  }

  /** Stops taking bytes; any that arrive are dropped. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.early.clear();
    this.mux.forget(this);
  }
}
