import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Download, RotateCcw, Share, X } from "lucide-react";
import { Thumbnail } from "../../components/Thumbnail";
import { Button, CopyButton, IconButton, ProgressBar, toast } from "../../components/ui";
import { bytes, duration, plural } from "../../lib/format";
import type { NearbyPeer } from "../../../shared/nearby";
import {
  accept,
  cancel,
  decline,
  dismiss,
  isActive,
  isOver,
  payloadOf,
  send,
  useNearby,
  type NearbyTransfer,
} from "../../lib/nearby/engine";
import { canShare, downloadFile, downloadZip, share, touch } from "../../lib/nearby/save";
import { navigate } from "../../lib/router";
import { startTransfer } from "../../lib/transfers";

type Payload = { files: { file: File; path: string }[]; folders: string[]; text: string };

/** Sends through Relay as Send would, to one of the member's own devices, and shows it there. */
export function sendThroughRelay(payload: Payload, device: { id: string; name: string }) {
  startTransfer({
    files: payload.files,
    folders: payload.folders,
    text: payload.text,
    name: null,
    destination: { kind: "device", device: device.id, name: device.name },
  });
  navigate("/");
}

/**
 * Everything sent and received here, newest first. A send that didn't go through can be tried
 * again while its peer is present and `canRetry`, or, to the member's own devices, sent through
 * Relay when `relay`.
 */
export function TransferList({
  peers,
  canRetry,
  relay = false,
}: {
  peers: NearbyPeer[];
  canRetry: boolean;
  relay?: boolean;
}) {
  const { transfers } = useNearby();
  if (!transfers.length) return null;
  const finished = transfers.filter(isOver);
  return (
    <section className="section" aria-labelledby="nearby-transfers-title">
      <div className="section-head">
        <h2 id="nearby-transfers-title">Transfers</h2>
        {finished.length > 1 && (
          <Button size="sm" variant="ghost" onClick={() => finished.forEach((t) => dismiss(t.id))}>
            Clear finished
          </Button>
        )}
      </div>
      <ul className="nearby-transfer-list">
        {transfers.map((t) => {
          const peer = peers.find((p) => p.id === t.peer);
          return (
            <TransferCard
              key={t.id}
              t={t}
              again={canRetry && peer?.present ? peer : undefined}
              relay={relay && peer?.kind === "device" ? peer : undefined}
            />
          );
        })}
      </ul>
    </section>
  );
}

/** "3 files · 12 MB", "Text", "2 files and text · 4 MB". */
export function contents(t: Pick<NearbyTransfer, "files" | "textBytes" | "bytes">) {
  const files = t.files.length;
  const what = files ? `${plural(files, "file")}${t.textBytes ? " and text" : ""}` : "Text";
  return files ? `${what} · ${bytes(t.bytes)}` : what;
}

function statusOf(t: NearbyTransfer) {
  const left = t.speed > 0 ? duration((t.bytes - t.moved) / t.speed) : "";
  switch (t.state) {
    case "connecting":
      return <span className="waiting">Connecting to {t.peerName}…</span>;
    case "asking":
      return <span className="waiting">Waiting for {t.peerName} to accept…</span>;
    case "incoming":
      return "Wants to send you this";
    case "running":
      return (
        <>
          {bytes(t.moved)} of {bytes(t.bytes)}
          {t.speed > 0 && ` · ${bytes(t.speed)}/s`}
          {left && ` · ${left} left`}
        </>
      );
    case "reconnecting":
      return <span className="waiting">Connection dropped. Reconnecting…</span>;
    case "done":
      return t.direction === "out" ? "Sent" : "Received";
    default:
      return t.reason;
  }
}

/** Where a transfer's files go when saved as one archive: its only folder, or who sent it. */
function archiveName(t: NearbyTransfer) {
  const roots = new Set(t.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  const [only] = roots;
  if (roots.size === 1 && only) return only;
  return `From ${t.peerName} ${new Date(t.started).toISOString().slice(0, 10)}`;
}

async function save(t: NearbyTransfer) {
  const files = t.received ?? [];
  if (!files.length) return;
  // Photos and videos go to the share sheet, which saves them to the library.
  if (canShare(files) && (await share(files))) return;
  if (files.length === 1) downloadFile(files[0], files[0].name);
  else
    downloadZip(
      files.map((file, i) => ({ path: t.files[i].path, file, crc: t.crcs![i], modified: t.files[i].modified })),
      t.folders,
      archiveName(t),
    );
}

const SHOWN = 4;

function Received({ t }: { t: NearbyTransfer }) {
  const [all, setAll] = useState(false);
  const files = t.received ?? [];
  const shown = all ? files : files.slice(0, SHOWN);
  return (
    <>
      {files.length > 0 && (
        <ul className="nearby-files" aria-label="Files received">
          {shown.map((file, i) => (
            <li key={i}>
              <Thumbnail compact file={file} entry={{ path: t.files[i].path, mime: file.type, size: file.size }} />
              <span className="nearby-file-name" title={t.files[i].path}>
                {t.files[i].path}
              </span>
              <span className="muted">{bytes(file.size)}</span>
              {!touch && (
                <IconButton
                  size="sm"
                  label={`Download ${file.name}`}
                  icon={<Download size={15} aria-hidden />}
                  onClick={() => downloadFile(file, file.name)}
                />
              )}
            </li>
          ))}
          {files.length > shown.length && (
            <li className="nearby-files-more">
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                Show all {files.length.toLocaleString()}
              </Button>
            </li>
          )}
        </ul>
      )}
      {t.text !== null && <SharedText text={t.text} />}
    </>
  );
}

function SharedText({ text }: { text: string }) {
  return (
    <div className="nearby-text">
      <pre>{text}</pre>
      <CopyButton value={text} label="Copy text" size="sm" />
    </div>
  );
}

export function TransferCard({ t, again, relay }: { t: NearbyTransfer; again?: NearbyPeer; relay?: NearbyPeer }) {
  // What didn't go through, sent again the same way or through Relay.
  const redo = (how: (payload: Payload) => void) => {
    const payload = payloadOf(t.id);
    if (!payload) return;
    dismiss(t.id);
    how(payload);
  };
  const active = isActive(t);
  const tone =
    t.state === "done"
      ? "done"
      : t.state === "failed"
        ? "failed"
        : active || t.state === "incoming"
          ? "active"
          : "ended";
  const moving = t.state === "running" || t.state === "reconnecting";
  const failed = t.state === "failed" || t.state === "declined" || t.state === "cancelled";
  return (
    <li
      className={`nearby-transfer card-surface is-${tone}`}
      aria-label={`${t.direction === "out" ? "To" : "From"} ${t.peerName}`}
    >
      <div className="nearby-transfer-head">
        <span className="nearby-transfer-icon" aria-hidden>
          {t.state === "done" ? (
            <Check size={16} />
          ) : t.direction === "out" ? (
            <ArrowUpRight size={16} />
          ) : (
            <ArrowDownLeft size={16} />
          )}
        </span>
        <div className="nearby-transfer-title">
          <strong>
            {t.direction === "out" ? "To" : "From"} {t.peerName}
          </strong>
          <span className="muted">{contents(t)}</span>
        </div>
        {active ? (
          <Button size="sm" variant="ghost" onClick={() => cancel(t.id)}>
            Cancel
          </Button>
        ) : (
          t.state !== "incoming" && (
            <IconButton size="sm" label="Dismiss" icon={<X size={16} aria-hidden />} onClick={() => dismiss(t.id)} />
          )
        )}
      </div>
      {moving && (
        <ProgressBar
          value={t.moved}
          max={t.bytes}
          label={`${t.direction === "out" ? "Sending" : "Receiving"} progress`}
        />
      )}
      <p
        className={`nearby-transfer-status${t.state === "failed" ? " is-error" : ""}`}
        role={t.state === "failed" ? "alert" : undefined}
      >
        {statusOf(t)}
      </p>
      {t.direction === "out" && t.preview && !t.files.length && (
        <p className="nearby-transfer-preview muted">{t.preview}</p>
      )}
      {t.state === "incoming" && (
        <>
          {t.preview && <p className="nearby-transfer-preview">{t.preview}</p>}
          <div className="row nearby-transfer-actions">
            <Button variant="primary" size="sm" onClick={() => void accept(t.id)}>
              Accept
            </Button>
            <Button size="sm" onClick={() => decline(t.id)}>
              Decline
            </Button>
          </div>
        </>
      )}
      {t.state === "done" && t.direction === "in" && (
        <>
          <Received t={t} />
          {(t.received?.length ?? 0) > 0 && (
            <div className="row nearby-transfer-actions">
              <Button
                variant="primary"
                size="sm"
                icon={touch ? <Share size={15} aria-hidden /> : <Download size={15} aria-hidden />}
                onClick={() =>
                  void save(t).catch(() => toast("These files couldn’t be saved. Try again.", { tone: "error" }))
                }
              >
                {touch ? "Save" : t.received!.length === 1 ? "Download" : "Download all"}
              </Button>
            </div>
          )}
        </>
      )}
      {failed && t.direction === "out" && (again || relay) && (
        <div className="row nearby-transfer-actions">
          {again && (
            <Button
              size="sm"
              icon={<RotateCcw size={15} aria-hidden />}
              onClick={() => redo((p) => send(again, p.files, p.folders, p.text))}
            >
              Try again
            </Button>
          )}
          {relay && (
            <Button size="sm" onClick={() => redo((p) => sendThroughRelay(p, relay))}>
              Send via Relay
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
