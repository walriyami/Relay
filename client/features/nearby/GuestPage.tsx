import { useEffect, useState } from "react";
import { LogOut, Radar } from "lucide-react";
import type { NearbyPeer } from "../../../shared/nearby";
import { PublicFrame, Unavailable } from "../../app/PublicPages";
import { usePageDrop } from "../../components/PageDrop";
import { Button, Spinner, confirmDialog, toast } from "../../components/ui";
import { deviceKind } from "../../../shared/devices";
import { NEARBY } from "../../../shared/nearby";
import { isActive, send, useNearby, watch } from "../../lib/nearby/engine";
import { guestTakeOver, joinGuest, leaveGuest, startGuest, stopGuest, useGuest } from "../../lib/nearby/guest";
import { addToSelection, getSelection, setSelectionText, useSelection } from "../../lib/nearby/selection";
import { NearbyAlerts } from "./NearbyAlerts";
import { NearbyComposer, TEXT_CHARS, takeSelection } from "./NearbyComposer";
import { TransferCard, TransferList } from "./NearbyTransfers";
import { PeerRow } from "./Peers";

const NAME_KEY = "relay.nearby-name";
function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/** A member's Nearby link, for someone without an account (`/n/<token>`). */
export function NearbyGuestPage({ token }: { token: string }) {
  const guest = useGuest();
  useEffect(() => {
    startGuest(token);
    return stopGuest;
  }, [token]);
  if (guest.phase === "loading")
    return (
      <PublicFrame>
        <Spinner />
      </PublicFrame>
    );
  if (guest.phase === "failed" || guest.phase === "ended")
    return (
      <PublicFrame width="narrow">
        <Unavailable
          title={guest.phase === "ended" ? "Nearby has ended" : "Nearby unavailable"}
          action={
            guest.phase === "failed" && (
              <Button
                onClick={() => {
                  stopGuest();
                  startGuest(token);
                }}
              >
                Try again
              </Button>
            )
          }
        >
          {guest.message || "Ask for a new Nearby code."}
        </Unavailable>
        <Finished />
      </PublicFrame>
    );
  if (guest.phase === "join") return <Join host={guest.info?.host ?? ""} />;
  return <Joined />;
}

function Join({ host }: { host: string }) {
  const [name, setName] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter your name.");
    setBusy(true);
    setError("");
    try {
      await joinGuest(trimmed, deviceKind(navigator.userAgent, navigator.maxTouchPoints));
      try {
        localStorage.setItem(NAME_KEY, trimmed);
      } catch {
        // Asked again next time.
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <PublicFrame width="narrow">
      <div className="card-surface public-card">
        <div className="public-title">
          <span className="nearby-join-icon" aria-hidden>
            <Radar size={22} />
          </span>
          <h1>Nearby with {host}</h1>
          <p className="muted">
            Send files and text straight to {host}’s devices on this network, and get theirs, while this page is open.
            Nothing is stored on Relay.
          </p>
        </div>
        <form className="stack" onSubmit={(e) => void submit(e)}>
          <label className="field-label" htmlFor="nearby-name">
            Your name
          </label>
          <input
            id="nearby-name"
            className="input"
            autoFocus
            autoComplete="name"
            value={name}
            maxLength={NEARBY.guestNameLength}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="field-hint">{host} sees this name next to what you send.</p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" busy={busy}>
            Join
          </Button>
        </form>
      </div>
    </PublicFrame>
  );
}

function Joined() {
  const guest = useGuest();
  const { transfers, status } = useNearby();
  const selection = useSelection();
  const info = guest.info!;
  const here = guest.phase === "joined";
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
  function sendTo(peer: NearbyPeer) {
    if (!ready || !here) return;
    const { files, folders, text } = takeSelection();
    send(peer, files, folders, text);
  }
  async function leave() {
    const busy = transfers.some(isActive);
    const ok = await confirmDialog({
      title: "Leave Nearby?",
      body: busy
        ? `What’s being sent or received stops, and ${info.host}’s devices stop showing you.`
        : `${info.host}’s devices stop showing you. You can join again with the link while it works.`,
      confirm: "Leave",
      danger: busy,
    });
    if (!ok) return;
    await leaveGuest().catch((e: Error) => toast(e.message, { tone: "error" }));
  }
  return (
    <PublicFrame width="wide">
      <div className="page">
        <div className="page-head">
          <div>
            <h1>Nearby with {info.host}</h1>
            <p className="muted">
              You’re {info.self?.name}. Keep this page open to send and receive.
              {!guest.connected && <span className="waiting"> Connecting to Relay…</span>}
            </p>
          </div>
          <Button variant="ghost" icon={<LogOut size={16} aria-hidden />} onClick={() => void leave()}>
            Leave
          </Button>
        </div>
        {guest.phase === "elsewhere" && (
          <div className="nearby-elsewhere card-surface" role="status">
            <Radar size={20} aria-hidden />
            <div>
              <strong>Nearby is open in another tab</strong>
              <p className="muted">Only one tab sends and receives. Use this one instead?</p>
            </div>
            <Button variant="primary" onClick={guestTakeOver}>
              Use here
            </Button>
          </div>
        )}
        <div className="send-layout nearby-layout">
          <NearbyComposer />
          <aside className="send-panel card-surface" aria-label="Send to">
            <h2 className="send-panel-title">Send to</h2>
            {!ready && <p className="send-panel-summary">Add something, then choose who gets it.</p>}
            <h3 className="send-panel-heading">{info.host}’s devices</h3>
            {info.peers.length ? (
              info.peers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  peer={peer}
                  status={status[peer.id] ?? null}
                  canSend={ready && here}
                  onSend={() => sendTo(peer)}
                />
              ))
            ) : (
              <p className="send-panel-empty">{info.host}’s devices show up here while Relay is open on them.</p>
            )}
          </aside>
          <div className="send-below">
            <TransferList peers={info.peers} canRetry={here} />
          </div>
        </div>
      </div>
      <NearbyAlerts />
      {overlay}
    </PublicFrame>
  );
}

/** What arrived before Nearby ended stays to be saved. */
function Finished() {
  const { transfers } = useNearby();
  const kept = transfers.filter((t) => t.state === "done" && t.direction === "in");
  if (!kept.length) return null;
  return (
    <ul className="nearby-transfer-list nearby-kept">
      {kept.map((t) => (
        <TransferCard key={t.id} t={t} />
      ))}
    </ul>
  );
}
