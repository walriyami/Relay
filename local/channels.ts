import type { DataChannel } from "node-datachannel";

// node-datachannel releases a channel's native side only once the channel's close has been reported
// to JavaScript. A channel object collected before then leaves the library a dangling pointer, which
// it follows when that report arrives and again in cleanup(), crashing the process. So each channel
// is held from the moment it exists until its close is reported. Its close handler is set here, and
// only here, since setting another would replace this one.
const held = new Set<DataChannel>();

export function hold(channel: DataChannel, onClosed?: () => void) {
  held.add(channel);
  channel.onClosed(() => {
    held.delete(channel);
    onClosed?.();
  });
}

/** Channels whose close has not been reported yet. */
export const heldChannels = () => held.size;
