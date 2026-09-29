// Nearby: sending straight from one device to another on the same network, never through Relay and
// never into anyone's Files. Relay only introduces the two devices. A device with Relay open is
// *present*: one tab of each device (see client/lib/nearby/presence.ts) holds its live event stream
// open as its Nearby endpoint. Endpoints that may reach each other exchange a WebRTC offer and answer
// through Relay, and everything after that (names, sizes, bytes) goes over the connection they make.
//
// Who may reach whom, decided by Relay for every signal:
// - a member's own devices, always;
// - two members' devices when both let other members see them and both are on the same network,
//   as Relay sees their addresses;
// - a member's devices and the guests who joined with that member's Nearby code.
//
// No STUN or TURN server is involved, so a connection only ever uses the devices' local addresses:
// where they can't reach each other directly (a network that isolates its devices), it fails rather
// than going anywhere else.

import type { DeviceKind, Id, Time } from "./model.ts";

export const NEARBY = {
  /** Largest offer or answer: a full description with every local candidate fits comfortably. */
  sdpBytes: 16 * 1024,
  /** How long a Nearby code lets people join, and how long they stay joined, before it's renewed. */
  inviteMinutes: 60,
  /** The name a guest gives, shown on the member's devices. */
  guestNameLength: 40,
  /** Guests one Nearby code may admit at a time. */
  guestsPerInvite: 20,
} as const;

/** Sets up or ends one connection attempt between two endpoints. `session` names the attempt. */
export type NearbySignal =
  | { kind: "offer"; session: string; sdp: string }
  | { kind: "answer"; session: string; sdp: string }
  | { kind: "bye"; session: string };

/**
 * What Relay tells an endpoint on its event stream (`event: nearby`):
 * - `signal`: another endpoint's signal, `from` as Relay authenticated it;
 * - `replaced`: another tab of this device became its endpoint, so this one no longer is;
 * - `peers`: for guests, who they can reach changed (members hear it as the `nearby` topic).
 */
export type NearbyEvent = { type: "signal"; from: Id; signal: NearbySignal } | { type: "replaced" } | { type: "peers" };

/**
 * Someone this endpoint may send to.
 * - `device`: one of the member's own devices; listed while signed in, present or not.
 * - `member`: another member's device on the same network, while present.
 * - `guest`: someone who joined with the member's Nearby code, while present.
 * - `host`: for a guest, a device of the member whose code they used, while present.
 */
export type NearbyPeer = {
  id: Id;
  kind: "device" | "member" | "guest" | "host";
  /** The device's name, or the name a guest gave. */
  name: string;
  /** The member it belongs to, for `member` and `host`. */
  owner: string | null;
  deviceKind: DeviceKind;
  /** Has Relay open, so a connection can be tried. */
  present: boolean;
};

export type NearbyInvite = {
  id: Id;
  code: string;
  /** The page a guest opens: /n/<token>. */
  token: string;
  expires: Time;
  /** Everyone who joined with it, newest first; `present` while they have the page open. */
  guests: { id: Id; name: string; kind: DeviceKind; present: boolean }[];
};

/** A member's view. `self` is this device's endpoint id. */
export type NearbyState = {
  self: Id;
  peers: NearbyPeer[];
  invite: NearbyInvite | null;
  /** Other members on the same network can see this member's devices. */
  visible: boolean;
};

/** What a guest's link shows before and after joining. */
export type NearbyGuestState = {
  host: string;
  expires: Time;
  /** Null until this browser has joined. */
  self: { id: Id; name: string; csrf: string } | null;
  peers: NearbyPeer[];
};
