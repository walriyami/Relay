import { useEffect, useState } from "react";
import { Button, Modal, toast } from "../../components/ui";
import { chime, getLocalPrefs } from "../../lib/local-prefs";
import { accept, decline, onNotice, useNearby, type NearbyTransfer } from "../../lib/nearby/engine";
import { notifySystem } from "../activity/ActivityProvider";
import { contents } from "./NearbyTransfers";

const LISTED = 5;

/**
 * Announces Nearby wherever you are: asks about what someone wants to send, and says when things
 * arrive. `view` goes to the Nearby page, when this isn't it.
 */
export function NearbyAlerts({ view }: { view?: () => void }) {
  const { transfers } = useNearby();
  // Offers put off with "Later": they wait on the Nearby page instead.
  const [later, setLater] = useState<string[]>([]);
  useEffect(
    () =>
      onNotice(({ kind, transfer: t }) => {
        const action = view ? { label: "View", onClick: view } : undefined;
        if (kind === "incoming") {
          if (getLocalPrefs().sound) chime();
          notifySystem(`${t.peerName} wants to send you ${contents(t)}.`, `nearby:${t.id}`);
        } else if (kind === "receiving" && view) {
          toast(`Receiving ${contents(t)} from ${t.peerName}`, { key: `nearby:${t.id}`, action });
        } else if (kind === "received") {
          if (getLocalPrefs().sound) chime();
          if (view) toast(`Received ${contents(t)} from ${t.peerName}`, { key: `nearby:${t.id}`, action });
          notifySystem(`Received ${contents(t)} from ${t.peerName}.`, `nearby:${t.id}`, view);
        } else if (kind === "failed") {
          toast(t.reason || "Nearby couldn’t finish receiving this.", { key: `nearby:${t.id}`, tone: "error", action });
        }
      }),
    [view],
  );
  const asking = transfers.filter((t) => t.state === "incoming" && !later.includes(t.id));
  // The oldest first: the list is newest first.
  const t = asking[asking.length - 1];
  if (!t) return null;
  return <Offer key={t.id} t={t} more={asking.length - 1} onLater={() => setLater((l) => [...l, t.id])} />;
}

function Offer({ t, more, onLater }: { t: NearbyTransfer; more: number; onLater: () => void }) {
  const names = t.files.slice(0, LISTED).map((f) => f.path);
  return (
    <Modal
      size="sm"
      title={`${t.peerName} wants to send you ${t.files.length ? plural(t.files.length) : "text"}`}
      subtitle={`${t.files.length ? `${contents(t)}. ` : ""}It comes straight from their device and isn’t saved to Relay.`}
      onClose={onLater}
      footer={
        <>
          <Button onClick={() => decline(t.id)}>Decline</Button>
          <Button variant="primary" data-autofocus onClick={() => void accept(t.id)}>
            Accept
          </Button>
        </>
      }
    >
      {names.length > 0 && (
        <ul className="nearby-offer-files">
          {names.map((name, i) => (
            <li key={i} title={name}>
              {name}
            </li>
          ))}
          {t.files.length > LISTED && <li className="muted">and {(t.files.length - LISTED).toLocaleString()} more</li>}
        </ul>
      )}
      {t.preview && <p className="nearby-offer-text">{t.preview}</p>}
      {more > 0 && (
        <p className="muted small">{more === 1 ? "1 more offer is waiting." : `${more} more offers are waiting.`}</p>
      )}
    </Modal>
  );
}

const plural = (n: number) => (n === 1 ? "a file" : `${n.toLocaleString()} files`);
