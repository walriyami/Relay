import type { NearbySignal } from "../../../shared/nearby";
import { parse, randomId, type Control } from "./protocol";

// One WebRTC connection to another Nearby endpoint. There are no STUN or TURN servers: the two
// browsers only try each other's local addresses, so a connection either stays on the network or
// never forms. The whole description goes in one offer and one answer, candidates included, which
// keeps signalling to two messages through Relay.

/** Devices on one network connect in a second or two; a network that isolates them never does. */
const CONNECT_MS = 12_000;
/** Finding local addresses takes moments; the description goes with those found by then. */
const GATHER_MS = 2500;
/** A connection that lost its path gets this long to find it again before it counts as lost. */
const RECOVER_MS = 10_000;
/**
 * Control messages longer than this many characters (an offer of thousands of files) go in pieces:
 * every browser takes a message this long, even written out in UTF-8.
 */
const PIECE = 16_000;
/** The longest control message put back together from pieces. */
const MESSAGE_CHARS = 16 * 1024 * 1024;

export type LinkEnd = "closed" | "unreachable" | "lost";

export type LinkEvents = {
  /** The control channel opened: transfers can use this connection. */
  open(link: Link): void;
  /** It ended; `why` says whether it ever worked. Called once. */
  end(link: Link, why: LinkEnd): void;
  control(link: Link, message: Control): void;
  /** The other side opened a channel for one entry of a transfer. */
  channel(link: Link, channel: RTCDataChannel): void;
};

export class Link {
  readonly peer: string;
  /** Names this attempt in signals, so late answers for an older one are ignored. */
  readonly session: string;
  /** Made by this side's offer, rather than by answering one. */
  readonly offering: boolean;
  readonly pc: RTCPeerConnection;
  private readonly control: RTCDataChannel;
  private readonly events: LinkEvents;
  private readonly signal: (signal: NearbySignal) => Promise<void>;
  state: "connecting" | "open" | "ended" = "connecting";
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Pieces of a long control message received so far. */
  private pieces: string[] = [];
  private pieceChars = 0;

  private constructor(
    peer: string,
    session: string,
    offering: boolean,
    events: LinkEvents,
    signal: (signal: NearbySignal) => Promise<void>,
  ) {
    this.peer = peer;
    this.session = session;
    this.offering = offering;
    this.events = events;
    this.signal = signal;
    this.pc = new RTCPeerConnection({ iceServers: [] });
    // Both sides make the control channel themselves, so neither waits to be told about it.
    this.control = this.pc.createDataChannel("control", { negotiated: true, id: 0 });
    this.control.onopen = () => {
      if (this.state !== "connecting") return;
      clearTimeout(this.timer);
      this.state = "open";
      this.events.open(this);
    };
    this.control.onclose = () => this.end("lost");
    this.control.onmessage = ({ data }) => this.received(data);
    this.pc.ondatachannel = ({ channel }) => {
      if (this.state === "open") this.events.channel(this, channel);
      else channel.close();
    };
    this.pc.onconnectionstatechange = () => {
      const now = this.pc.connectionState;
      if (now === "failed" || now === "closed") this.end("lost");
      else if (now === "disconnected" && this.state === "open") {
        // Wi-Fi roaming or a phone waking can drop the path for a moment; give it time to return.
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.end("lost"), RECOVER_MS);
      } else if (now === "connected" && this.state === "open") clearTimeout(this.timer);
    };
    this.timer = setTimeout(() => this.end("unreachable"), CONNECT_MS);
  }

  /** Starts a connection to `peer` and sends the offer. */
  static offer(peer: string, events: LinkEvents, signal: (signal: NearbySignal) => Promise<void>) {
    const link = new Link(peer, randomId(), true, events, signal);
    void link.start(async () => {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      await gathered(link.pc);
      return { kind: "offer", session: link.session, sdp: link.pc.localDescription!.sdp };
    });
    return link;
  }

  /** Answers `peer`'s offer. */
  static answer(
    peer: string,
    session: string,
    sdp: string,
    events: LinkEvents,
    signal: (signal: NearbySignal) => Promise<void>,
  ) {
    const link = new Link(peer, session, false, events, signal);
    void link.start(async () => {
      await link.pc.setRemoteDescription({ type: "offer", sdp });
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      await gathered(link.pc);
      return { kind: "answer", session: link.session, sdp: link.pc.localDescription!.sdp };
    });
    return link;
  }

  private async start(describe: () => Promise<NearbySignal>) {
    try {
      const signal = await describe();
      if (this.state !== "connecting") return;
      await this.signal(signal);
    } catch {
      // Relay couldn't pass it on (the other side left), or this browser couldn't describe a connection.
      this.end("unreachable");
    }
  }

  /** The other side's answer to this side's offer. */
  async answered(sdp: string) {
    if (!this.offering || this.state !== "connecting" || this.pc.signalingState !== "have-local-offer") return;
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp });
    } catch {
      this.end("unreachable");
    }
  }

  send(message: Control) {
    if (this.state !== "open") return false;
    const text = JSON.stringify(message);
    try {
      if (text.length <= PIECE) this.control.send(text);
      else
        for (let at = 0; at < text.length;) {
          let end = Math.min(at + PIECE, text.length);
          // Never between the two halves of a character outside the basic plane.
          const last = text.charCodeAt(end - 1);
          if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
          this.control.send((end < text.length ? "+" : "=") + text.slice(at, end));
          at = end;
        }
      return true;
    } catch {
      this.end("lost");
      return false;
    }
  }

  /** A control message, or a piece of one: "+" pieces are followed by the last, "=". */
  private received(data: unknown) {
    if (this.state !== "open" || typeof data !== "string") return;
    let text = data;
    if (data[0] === "+" || data[0] === "=") {
      this.pieces.push(data.slice(1));
      this.pieceChars += data.length - 1;
      if (this.pieceChars > MESSAGE_CHARS) return this.end("lost");
      if (data[0] === "+") return;
      text = this.pieces.join("");
      this.pieces = [];
      this.pieceChars = 0;
    }
    const message = parse<Control>(text);
    if (message) this.events.control(this, message);
  }

  /** A new channel for one entry of a transfer. */
  channel(label: string) {
    const channel = this.pc.createDataChannel(label, { ordered: true });
    channel.binaryType = "arraybuffer";
    return channel;
  }

  /** The largest binary message this connection carries. */
  get messageBytes() {
    const max = this.pc.sctp?.maxMessageSize;
    return max && max > 0 ? max : Infinity;
  }

  /**
   * Ends the connection. `tell` lets the other side know through Relay, for when it may still be
   * waiting on an answer rather than on the connection itself.
   */
  close(tell = true) {
    if (this.state === "ended") return;
    if (tell && this.state === "connecting") this.signal({ kind: "bye", session: this.session }).catch(() => {});
    this.end("closed");
  }

  /** The other side said goodbye, or it or this side gave up. */
  end(why: LinkEnd) {
    if (this.state === "ended") return;
    const was = this.state;
    this.state = "ended";
    clearTimeout(this.timer);
    this.control.onopen = this.control.onclose = this.control.onmessage = null;
    this.pc.ondatachannel = this.pc.onconnectionstatechange = null;
    this.pc.close();
    // A connection that never opened didn't reach the other side, whatever ended it.
    this.events.end(this, was === "connecting" && why === "lost" ? "unreachable" : why);
  }
}

/** Resolves once the connection knows its local addresses, or after GATHER_MS with those it has. */
function gathered(pc: RTCPeerConnection) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener("icegatheringstatechange", check);
    check();
  });
}
