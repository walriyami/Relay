import { LANES, Mux, type Lane, type MuxEvents } from "../../shared/lanes";

// A browser's side of a connection made of lanes (see shared/lanes.ts): the first peer connection,
// set up through Relay by whoever owns it, and the lanes offered and answered on it once it's open.

export type LanesState =
  /** The first lane is connected. */
  | "connected"
  /** The first lane lost its path for now; it may find it again. */
  | "disconnected"
  /** The first lane is gone, or the other side broke the protocol: the connection is over. */
  | "failed";

export type LanesEvents = Omit<MuxEvents, "broken"> & { state(state: LanesState): void };

export class Lanes {
  readonly mux: Mux;
  private readonly events: LanesEvents;
  private readonly sdpBytes: number;
  /** The first lane's peer connection: the connection's state is its state. */
  private readonly first: RTCPeerConnection;
  /** The other lanes that opened, until they close. */
  private readonly others = new Set<RTCPeerConnection>();
  /** Lanes offered or answered and not open yet. */
  private readonly pending = new Set<RTCPeerConnection>();
  /** This side offered lanes and waits for the answers; or lanes were set up, and won't be again. */
  private offered: RTCPeerConnection[] | null = null;
  private settled = false;
  private state: LanesState = "connected";
  closed = false;

  /** `first` is open, with `channel` its lane. */
  constructor(
    first: RTCPeerConnection,
    channel: RTCDataChannel,
    events: LanesEvents,
    options: { maxMessage: number; sdpBytes: number },
  ) {
    this.events = events;
    this.sdpBytes = options.sdpBytes;
    this.first = first;
    this.mux = new Mux(
      lane(channel),
      { ...events, control: (m) => this.control(m), broken: () => this.fail() },
      options.maxMessage,
    );
    feed(this.mux, channel);
    channel.onclose = () => this.fail();
    first.onconnectionstatechange = () => {
      const now = first.connectionState;
      if (now === "failed" || now === "closed") this.fail();
      else if (now === "disconnected" || now === "connected") this.report(now);
    };
  }

  /** Lanes carrying bytes now. */
  get width() {
    return this.mux.width;
  }

  /** Offers the other lanes; the side that offered the first does. */
  async offer() {
    if (this.offered || this.settled) return;
    const pcs = Array.from({ length: LANES.count - 1 }, () => this.create());
    this.offered = pcs;
    try {
      const sdps = await Promise.all(pcs.map((pc) => describe(pc)));
      if (!this.closed) this.mux.send({ lanes: sdps });
    } catch {
      // This browser won't make more connections: the first carries everything.
      this.drop(pcs);
    }
  }

  private control(message: Record<string, unknown>) {
    if (!("lanes" in message)) return this.events.control(message);
    const sdps = message.lanes;
    if (
      this.settled ||
      !Array.isArray(sdps) ||
      sdps.length > LANES.count - 1 ||
      !sdps.every((sdp) => typeof sdp === "string" && sdp.length <= this.sdpBytes)
    )
      return;
    this.settled = true;
    if (this.offered) void this.answered(this.offered, sdps as string[]);
    else void this.answer(sdps as string[]);
  }

  private async answered(pcs: RTCPeerConnection[], sdps: string[]) {
    // Fewer answers than offers: the other side takes that many.
    this.drop(pcs.slice(sdps.length));
    await Promise.all(
      sdps.map((sdp, i) => pcs[i].setRemoteDescription({ type: "answer", sdp }).catch(() => this.drop([pcs[i]]))),
    );
  }

  private async answer(offers: string[]) {
    const answers = await Promise.all(
      offers.map(async (sdp) => {
        const pc = this.create();
        try {
          return await describe(pc, sdp);
        } catch {
          this.drop([pc]);
          return null;
        }
      }),
    );
    // Answers pair with offers in order, so a lane this side couldn't make ends the list.
    const usable = answers.indexOf(null) < 0 ? answers.length : answers.indexOf(null);
    if (!this.closed) this.mux.send({ lanes: answers.slice(0, usable) });
  }

  /** A lane's peer connection, joining the connection once its channel opens. */
  private create() {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel("lane", { negotiated: true, id: 0 });
    this.pending.add(pc);
    channel.onopen = () => {
      if (this.closed || !this.pending.delete(pc)) return;
      this.join(pc, channel);
    };
    // One that never opens is left out; it never carried anything.
    pc.onconnectionstatechange = () => {
      if (this.pending.has(pc) && (pc.connectionState === "failed" || pc.connectionState === "closed")) this.drop([pc]);
    };
    return pc;
  }

  private drop(pcs: RTCPeerConnection[]) {
    for (const pc of pcs) {
      this.pending.delete(pc);
      pc.onconnectionstatechange = null;
      pc.close();
    }
  }

  /**
   * A lane that opened carries frames while it has its path: losing it takes the lane out of use for
   * now, and closing takes it out for good. Either way, what it carried goes again on the others.
   */
  private join(pc: RTCPeerConnection, channel: RTCDataChannel) {
    const own = lane(channel);
    this.others.add(pc);
    feed(this.mux, channel);
    this.mux.add(own);
    const gone = () => {
      if (!this.others.delete(pc)) return;
      pc.onconnectionstatechange = channel.onclose = null;
      pc.close();
      this.mux.remove(own);
    };
    channel.onclose = gone;
    pc.onconnectionstatechange = () => {
      const now = pc.connectionState;
      if (now === "failed" || now === "closed") gone();
      else if (now === "disconnected") this.mux.remove(own);
      else if (now === "connected") this.mux.add(own);
    };
  }

  private report(state: LanesState) {
    if (this.state === state) return;
    this.state = state;
    this.events.state(state);
  }

  private fail() {
    if (this.closed) return;
    this.close();
    this.state = "failed";
    this.events.state("failed");
  }

  /** Ends every lane, the first included. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.mux.close();
    this.drop([...this.pending, ...this.others, this.first]);
    this.others.clear();
  }
}

function lane(channel: RTCDataChannel): Lane {
  return {
    send: (data) => channel.send(data as never),
    buffered: () => channel.bufferedAmount,
  };
}

/** Whatever arrives on `channel` goes to `mux`, which hears when the channel has room again. */
function feed(mux: Mux, channel: RTCDataChannel) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = LANES.laneBytes / 2;
  channel.onbufferedamountlow = () => mux.drained();
  channel.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => mux.receive(data);
}

/** Finding local addresses takes moments; a description goes with those found by then. */
const GATHER_MS = 2500;
/**
 * Peer connections finding their addresses at once, across the page. In WebKit, a dozen or so doing
 * so together cut off those already connected, so the rest wait their turn.
 */
const GATHERING = 4;
let gathering = 0;
const turns: (() => void)[] = [];

/** `pc`'s description with the local addresses it found: its offer, or its answer to `offer`. */
export async function describe(pc: RTCPeerConnection, offer?: string) {
  if (gathering < GATHERING) gathering++;
  else await new Promise<void>((resolve) => turns.push(resolve));
  try {
    if (offer === undefined) await pc.setLocalDescription(await pc.createOffer());
    else {
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
    }
    await gathered(pc, GATHER_MS);
    return pc.localDescription!.sdp;
  } finally {
    const next = turns.shift();
    if (next) next();
    else gathering--;
  }
}

/** Resolves once `pc` knows its local addresses, or after `ms` with those it has. */
function gathered(pc: RTCPeerConnection, ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
    check();
  });
}
