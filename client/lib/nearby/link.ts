import { NEARBY, type NearbySignal } from "../../../shared/nearby";
import type { Mux } from "../../../shared/lanes";
import { describe, Lanes } from "../lanes";
import { randomId, type Control } from "./protocol";

// One connection to another Nearby endpoint, made of lanes (see shared/lanes.ts). There are no STUN
// or TURN servers: the two browsers only try each other's local addresses, so a connection either
// stays on the network or never forms. The first lane's whole description goes in one offer and one
// answer, candidates included, which keeps signalling to two messages through Relay; the other lanes
// are offered and answered on the first.

/** Devices on one network connect in a second or two; a network that isolates them never does. */
const CONNECT_MS = 12_000;
/** A connection that lost its path gets this long to find it again before it counts as lost. */
const RECOVER_MS = 10_000;
/** The longest control message put back together from pieces: an offer of thousands of files. */
const MESSAGE_CHARS = 16 * 1024 * 1024;

export type LinkEnd = "closed" | "unreachable" | "lost";

export type LinkEvents = {
  /** The first lane opened: transfers can use this connection. */
  open(link: Link): void;
  /** It ended; `why` says whether it ever worked. Called once. */
  end(link: Link, why: LinkEnd): void;
  control(link: Link, message: Control): void;
  /** Bytes arrived for a stream this side hasn't opened (see Mux). */
  stream(link: Link, stream: number): void;
};

export class Link {
  readonly peer: string;
  /** Names this attempt in signals, so late answers for an older one are ignored. */
  readonly session: string;
  /** Made by this side's offer, rather than by answering one. */
  readonly offering: boolean;
  private readonly pc: RTCPeerConnection;
  private lanes: Lanes | null = null;
  private readonly events: LinkEvents;
  private readonly signal: (signal: NearbySignal) => Promise<void>;
  state: "connecting" | "open" | "ended" = "connecting";
  private timer: ReturnType<typeof setTimeout> | undefined;

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
    // Both sides make the first lane's channel themselves, so neither waits to be told about it.
    const channel = this.pc.createDataChannel("lane", { negotiated: true, id: 0 });
    channel.onopen = () => {
      if (this.state !== "connecting") return;
      clearTimeout(this.timer);
      this.state = "open";
      this.lanes = new Lanes(
        this.pc,
        channel,
        {
          control: (message) => this.events.control(this, message as Control),
          open: (stream) => this.events.stream(this, stream),
          state: (state) => {
            clearTimeout(this.timer);
            if (state === "failed") this.end("lost");
            // Wi-Fi roaming or a phone waking can drop the path for a moment; give it time to return.
            else if (state === "disconnected") this.timer = setTimeout(() => this.end("lost"), RECOVER_MS);
          },
        },
        { maxMessage: MESSAGE_CHARS, sdpBytes: NEARBY.sdpBytes },
      );
      if (this.offering) void this.lanes.offer();
      this.events.open(this);
    };
    channel.onclose = () => this.end("lost");
    // Nothing but the lanes' own channels is expected.
    this.pc.ondatachannel = ({ channel: other }) => other.close();
    this.pc.onconnectionstatechange = () => {
      const now = this.pc.connectionState;
      if (now === "failed" || now === "closed") this.end("lost");
    };
    this.timer = setTimeout(() => this.end("unreachable"), CONNECT_MS);
  }

  /** Starts a connection to `peer` and sends the offer. */
  static offer(peer: string, events: LinkEvents, signal: (signal: NearbySignal) => Promise<void>) {
    const link = new Link(peer, randomId(), true, events, signal);
    void link.start(async () => ({ kind: "offer", session: link.session, sdp: await describe(link.pc) }));
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
    void link.start(async () => ({ kind: "answer", session: link.session, sdp: await describe(link.pc, sdp) }));
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
    return this.state === "open" && !!this.lanes?.mux.send(message);
  }

  /** Streams to and from the other side; null until open. */
  get mux(): Mux | null {
    return this.state === "open" ? this.lanes!.mux : null;
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
    this.pc.ondatachannel = this.pc.onconnectionstatechange = null;
    // Closing the lanes closes the first too; one that never opened has only the first.
    this.lanes?.close();
    this.pc.close();
    // A connection that never opened didn't reach the other side, whatever ended it.
    this.events.end(this, was === "connecting" && why === "lost" ? "unreachable" : why);
  }
}
