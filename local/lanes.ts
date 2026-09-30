import type { DataChannel, PeerConnection } from "node-datachannel";
import { LANES, type Lane, type Mux } from "../shared/lanes.ts";
import { hold } from "./channels.ts";

// Lanes (see shared/lanes.ts) as node-datachannel has them: the helper's side, and the stand-in
// browser that tests drive it with.

/**
 * `pc`'s lane: its negotiated channel. Creating it makes node-datachannel offer, unless `pc` already
 * has the offer it answers. `onClosed` runs when the channel's close is reported.
 */
export function laneChannel(pc: PeerConnection, onClosed: () => void) {
  const channel = pc.createDataChannel("lane", { negotiated: true, id: 0 });
  hold(channel, onClosed);
  return channel;
}

/** The lane `channel` is, to send on. */
export function laneOf(channel: DataChannel): Lane {
  return {
    send(data) {
      // False only means the message waits behind others; a closed channel throws.
      if (typeof data === "string") channel.sendMessage(data);
      else channel.sendMessageBinary(data);
    },
    // A closed channel throws here too; it counts as full until its close takes it out of use.
    buffered: () => {
      try {
        return channel.bufferedAmount();
      } catch {
        return Infinity;
      }
    },
  };
}

/** Whatever arrives on `channel` goes to `mux`, which hears when the channel has room again. */
export function feed(mux: Mux, channel: DataChannel) {
  channel.setBufferedAmountLowThreshold(LANES.laneBytes / 2);
  channel.onBufferedAmountLow(() => mux.drained());
  channel.onMessage((message) => mux.receive(message));
}

/** Resolves once `pc` knows its own candidates; without STUN servers that is at once. */
export function gathered(pc: PeerConnection) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gathering candidates took too long.")), 3000);
    const check = () => {
      if (pc.gatheringState() !== "complete") return false;
      clearTimeout(timer);
      resolve();
      return true;
    };
    if (!check()) pc.onGatheringStateChange(() => void check());
  });
}
