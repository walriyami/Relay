import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, call, urls } from "../../api";
import type { NearbyInvite } from "../../../shared/nearby";
import { DeviceIcon } from "../../app/devices";
import { ShareAccess } from "../../components/ShareAccess";
import { Button, IconButton, Modal, confirmDialog, toast } from "../../components/ui";
import { until } from "../../lib/format";
import { reloadPresence } from "../../lib/nearby/presence";

/**
 * The member's Nearby code: someone without an account opens its link (or enters the code) and can
 * then send to and receive from the member's devices, until the code ends.
 */
export function InviteDialog({ invite, onClose }: { invite: NearbyInvite | null; onClose: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [, tick] = useState(0);
  // Opening the dialog opens a code, unless one is open already.
  useEffect(() => {
    if (invite) return;
    let live = true;
    call(api.nearby.invite)
      .then(() => reloadPresence())
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening.
  }, []);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    try {
      await work();
      await reloadPresence();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy("");
    }
  }
  async function end() {
    const ok = await confirmDialog({
      title: "End this Nearby code?",
      body: invite?.guests.length
        ? "Everyone who joined with it leaves Nearby, and the code and link stop working."
        : "The code and link stop working.",
      confirm: "End code",
      danger: true,
    });
    if (ok) await run("end", () => call(api.nearby.endInvite)).then(onClose);
  }
  return (
    <Modal
      size="sm"
      title="Invite someone"
      subtitle="They can send to your devices, and you to theirs, while both are on this network. They don’t need an account."
      onClose={onClose}
      footer={
        invite && (
          <>
            <Button variant="ghost" busy={busy === "end"} onClick={() => void end()}>
              End code
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : !invite ? (
        <p className="muted waiting">Opening a code…</p>
      ) : (
        <div className="nearby-invite">
          <ShareAccess
            url={urls.nearbyLink(location.origin, invite.token)}
            code={invite.code}
            codeLabel="Nearby code"
            purpose="Nearby link"
            detail={
              <p className="nearby-invite-expiry">
                Ends {until(invite.expires)}
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy === "extend"}
                  onClick={() => void run("extend", () => call(api.nearby.extendInvite))}
                >
                  Extend
                </Button>
              </p>
            }
          />
          <section className="nearby-guests" aria-label="People who joined">
            <h3 className="send-panel-heading">Joined</h3>
            {invite.guests.length ? (
              <ul>
                {invite.guests.map((guest) => (
                  <li key={guest.id}>
                    <DeviceIcon device={{ kind: guest.kind }} size={16} />
                    <span className="nearby-guest-name">{guest.name}</span>
                    <span className="muted">
                      {guest.present ? (
                        <>
                          <span className="online-dot" aria-hidden /> Here now
                        </>
                      ) : (
                        "Away"
                      )}
                    </span>
                    <IconButton
                      size="sm"
                      label={`Remove ${guest.name}`}
                      icon={<X size={15} aria-hidden />}
                      disabled={busy === guest.id}
                      onClick={() =>
                        void run(guest.id, () => call(api.nearby.removeGuest, { params: { id: guest.id } }))
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="send-panel-empty">No one yet. People show up here once they open the link.</p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
