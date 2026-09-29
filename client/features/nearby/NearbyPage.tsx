import { useEffect, useState } from "react";
import { Radar, UserPlus } from "lucide-react";
import { api, call } from "../../api";
import type { NearbyPeer } from "../../../shared/nearby";
import { useSession } from "../../app/session";
import { ThisDeviceName } from "../../app/devices";
import { usePageDrop } from "../../components/PageDrop";
import { Button, LoadFailed, Toggle, confirmDialog, toast } from "../../components/ui";
import { send, useNearby, watch } from "../../lib/nearby/engine";
import { reloadPresence, takeOver, usePresence } from "../../lib/nearby/presence";
import { addToSelection, getSelection, setSelectionText, useSelection } from "../../lib/nearby/selection";
import { DestinationRow } from "../send/Composer";
import { InviteDialog } from "./InviteDialog";
import { NearbyComposer, TEXT_CHARS, takeSelection } from "./NearbyComposer";
import { TransferList, sendThroughRelay } from "./NearbyTransfers";
import { PeerRow } from "./Peers";

/** Sends straight to devices on the same network: the member's own, other members', and guests. */
export function NearbyPage() {
  const { me, setMe } = useSession();
  const presence = usePresence();
  const { status } = useNearby();
  const selection = useSelection();
  const [inviting, setInviting] = useState(false);
  const [savingVisible, setSavingVisible] = useState(false);
  const here = presence.role === "here";
  // While the page is open, present devices are connected to ahead of need, to show which can be reached.
  useEffect(() => {
    if (!here) return;
    watch(true);
    return () => watch(false);
  }, [here]);
  const overlay = usePageDrop({
    onFiles: (files, folders) => addToSelection(files, folders),
    onText: (text) => {
      if (getSelection().text.trim()) return false;
      setSelectionText(text.slice(0, TEXT_CHARS));
      window.dispatchEvent(new Event("relay-nearby-text"));
      return true;
    },
    hint: "Then choose who gets it.",
  });
  const ready = selection.items.length > 0 || selection.text.trim().length > 0;
  const peers = presence.state?.peers ?? [];
  const own = peers.filter((p) => p.kind === "device");
  const members = peers.filter((p) => p.kind === "member");
  const guests = peers.filter((p) => p.kind === "guest");
  const invite = presence.state?.invite ?? null;

  function sendTo(peer: NearbyPeer) {
    if (!ready || !here) return;
    const { files, folders, text } = takeSelection();
    send(peer, files, folders, text);
  }
  function relayTo(peer: NearbyPeer) {
    if (!ready) return;
    sendThroughRelay(takeSelection(), peer);
  }
  async function setVisible(visible: boolean) {
    setSavingVisible(true);
    try {
      const { prefs, user } = await call(api.account.update, { body: { prefs: { nearbyVisible: visible } } });
      setMe((current) => ({ ...current, prefs, user }));
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setSavingVisible(false);
    }
  }
  async function chooseHere() {
    if (
      presence.busyElsewhere &&
      !(await confirmDialog({
        title: "Use Nearby in this tab?",
        body: "What’s being sent or received in the other tab stops.",
        confirm: "Use here",
      }))
    )
      return;
    takeOver();
  }

  const row = (peer: NearbyPeer) => (
    <PeerRow
      key={peer.id}
      peer={peer}
      status={status[peer.id] ?? null}
      canSend={ready && here}
      onSend={() => sendTo(peer)}
      onRelay={peer.kind === "device" ? () => relayTo(peer) : undefined}
    />
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Nearby</h1>
          <p className="muted">Send straight to devices on this network. Nothing goes through Relay or into Files.</p>
        </div>
      </div>
      {presence.role === "elsewhere" && (
        <div className="nearby-elsewhere card-surface" role="status">
          <Radar size={20} aria-hidden />
          <div>
            <strong>Nearby is open in another tab</strong>
            <p className="muted">One tab on each device sends and receives. Use this one instead?</p>
          </div>
          <Button variant="primary" onClick={() => void chooseHere()}>
            Use here
          </Button>
        </div>
      )}
      <div className="send-layout nearby-layout">
        <NearbyComposer />
        <aside className="send-panel card-surface" aria-label="Send to">
          <h2 className="send-panel-title">Send to</h2>
          {!ready && <p className="send-panel-summary">Add something, then choose who gets it.</p>}
          {presence.error && !presence.state && (
            <LoadFailed
              banner
              title="Nearby couldn’t be loaded"
              error={presence.error}
              onRetry={() => void reloadPresence()}
            />
          )}
          <h3 className="send-panel-heading">Your devices</h3>
          {own.length ? (
            own.map(row)
          ) : (
            <p className={`send-panel-empty${presence.state ? "" : " waiting"}`}>
              {presence.state ? "Your other signed-in devices show up here." : "Looking for devices…"}
            </p>
          )}
          {members.length > 0 && (
            <>
              <h3 className="send-panel-heading">People nearby</h3>
              {members.map(row)}
            </>
          )}
          {guests.length > 0 && (
            <>
              <h3 className="send-panel-heading">Guests</h3>
              {guests.map(row)}
            </>
          )}
          <DestinationRow
            quiet
            icon={<UserPlus size={18} />}
            label={invite ? "Nearby code" : "Invite someone"}
            detail={
              invite
                ? `${invite.guests.length ? `${invite.guests.length} joined · ` : ""}Show the code`
                : "For someone without an account"
            }
            disabled={false}
            onClick={() => setInviting(true)}
          />
          <div className="nearby-visible">
            <Toggle
              label="Visible to people nearby"
              description="Other members on this network can see your devices and offer to send you things."
              checked={me.prefs.nearbyVisible}
              disabled={savingVisible}
              onChange={(v) => void setVisible(v)}
            />
          </div>
          <ThisDeviceName />
        </aside>
        <div className="send-below">
          <TransferList peers={peers} canRetry={here} relay />
        </div>
      </div>
      {inviting && <InviteDialog invite={invite} onClose={() => setInviting(false)} />}
      {overlay}
    </div>
  );
}
