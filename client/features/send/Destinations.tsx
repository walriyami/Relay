// Send's list of the member's own devices. Send goes through Relay and keeps a copy in Files, so
// every signed-in device is a place to send, open or not: one that's away gets it when it next opens Relay.
import { useState } from "react";
import { Pencil } from "lucide-react";
import type { Device } from "../../api";
import { DeviceIcon, useEditDevice } from "../../app/devices";
import { useSession } from "../../app/session";
import { Button, IconButton } from "../../components/ui";
import { ago } from "../../lib/format";
import { DestinationRow } from "./Composer";

/** Devices not seen for this long fold away under "Show more": most are old browsers. */
const STALE_MS = 14 * 86_400_000;

/** The member's other signed-in devices, the ones seen lately first. */
export function useSendableDevices() {
  const { devices } = useSession();
  const now = Date.now();
  const all = devices
    .filter((d) => d.signedIn && !d.current)
    .sort((a, b) => Number(b.online) - Number(a.online) || b.seen - a.seen);
  const recent = all.filter((d) => d.online || now - d.seen < STALE_MS);
  return { recent, stale: all.filter((d) => !recent.includes(d)) };
}

/** Whether the device has Relay open now, or when it last did. */
function deviceDetail(d: Device, sent: boolean) {
  // A device that's away doesn't have it yet: it waits in Files until the device opens Relay.
  if (sent) return d.online ? "Sent" : "Waiting for it to open Relay";
  if (d.online)
    return (
      <>
        <span className="online-dot" aria-hidden /> Online now
      </>
    );
  // `seen` moves while it has Relay open, so a moment ago means it was just closed.
  return Date.now() - d.seen < 5 * 60_000 ? "Away · gets it when it opens Relay" : `Away · last open ${ago(d.seen)}`;
}

export function OwnDevices({
  disabled,
  sentTo,
  busy,
  onSend,
}: {
  disabled: boolean;
  sentTo: (id: string) => boolean;
  busy: string;
  onSend: (device: Device) => void;
}) {
  const { recent, stale } = useSendableDevices();
  const [more, setMore] = useState(false);
  const editDevice = useEditDevice();
  const shown = more ? [...recent, ...stale] : recent;
  if (!shown.length && !stale.length)
    return <p className="send-panel-empty">Sign in to Relay on your phone or another computer to send to it.</p>;
  return (
    <>
      <p className="send-panel-note muted">
        Kept in your Files. A device that’s away gets it when it next opens Relay.
      </p>
      {shown.map((d) => (
        <DestinationRow
          key={d.id}
          icon={<DeviceIcon device={d} />}
          label={d.name}
          detail={deviceDetail(d, sentTo(d.id))}
          disabled={disabled || sentTo(d.id)}
          done={sentTo(d.id)}
          busy={busy === d.id}
          onClick={() => onSend(d)}
          revealAccessory
          accessory={
            <IconButton
              size="sm"
              label={`Edit ${d.name}`}
              icon={<Pencil size={15} aria-hidden />}
              onClick={(event) => {
                // Safari doesn't focus a clicked button; the editor returns focus to what had it.
                event.currentTarget.focus();
                editDevice(d);
              }}
            />
          }
        />
      ))}
      {stale.length > 0 && (
        <Button size="sm" variant="ghost" className="send-panel-more" onClick={() => setMore((m) => !m)}>
          {more ? "Show fewer" : `Show ${stale.length} not seen lately`}
        </Button>
      )}
    </>
  );
}
