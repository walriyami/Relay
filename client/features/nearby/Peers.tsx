import type { NearbyPeer } from "../../../shared/nearby";
import { DeviceIcon } from "../../app/devices";
import { Button } from "../../components/ui";
import type { PeerStatus } from "../../lib/nearby/engine";
import { DestinationRow } from "../send/Composer";

/** Who a peer is, as its row names it: a person for other members' devices, a device otherwise. */
export function peerLabel(peer: NearbyPeer) {
  return peer.kind === "member" && peer.owner ? peer.owner : peer.name;
}

/** Whether a peer can be sent to now, in words. */
function statusLine(peer: NearbyPeer, status: PeerStatus) {
  // A member's device is named by its owner, so the line says which device; a host's devices are
  // listed under their owner's name already.
  const who = peer.kind === "member" ? `${peer.name} · ` : peer.kind === "guest" ? "Guest · " : "";
  if (!peer.present) return <>{who}Open Relay on it to send</>;
  if (status === "ready")
    return (
      <>
        <span className="online-dot" aria-hidden /> {who}Ready
      </>
    );
  if (status === "unreachable") return <>{who}Not reachable on this network</>;
  return <span className="waiting">{who}Connecting…</span>;
}

/**
 * One device or person to send to. Only present ones can be sent to; an own device Nearby can't
 * reach offers to send through Relay instead.
 */
export function PeerRow({
  peer,
  status,
  canSend,
  onSend,
  onRelay,
}: {
  peer: NearbyPeer;
  status: PeerStatus;
  /** Something is chosen to send. */
  canSend: boolean;
  onSend: () => void;
  /** Sends through Relay instead, when Nearby can't reach it. */
  onRelay?: () => void;
}) {
  const relay = onRelay && peer.present && status === "unreachable";
  return (
    <DestinationRow
      icon={<DeviceIcon device={{ kind: peer.deviceKind }} />}
      label={peerLabel(peer)}
      detail={statusLine(peer, status)}
      disabled={!canSend || !peer.present}
      onClick={onSend}
      accessory={
        relay ? (
          <Button size="sm" disabled={!canSend} onClick={onRelay}>
            Send via Relay
          </Button>
        ) : undefined
      }
    />
  );
}
