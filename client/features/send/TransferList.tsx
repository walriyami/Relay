import { useSyncExternalStore } from "react";
import type { DeliveryState } from "../../api";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  HardDriveUpload,
  Link2,
  Loader2,
  Monitor,
  Pause,
  Play,
  Plus,
  RotateCcw,
  WifiOff,
  X,
} from "lucide-react";
import {
  canRetryCreate,
  retryCreate,
  cancel,
  defaultLinkDays,
  deleteSaved,
  dismiss,
  isBusy,
  payloadBytes,
  pause,
  resume,
  retarget,
  retryFailed,
  skipFailed,
  snapshot,
  subscribe,
  transfers,
  unsavedBytes,
  type Transfer,
} from "../../lib/transfers";
import { bytes, duration, plural } from "../../lib/format";
import { useConnection, type ConnectionState } from "../../lib/connection";
import { navigate } from "../../lib/router";
import { LinkPanel } from "../../components/LinkPanel";
import { addFilesTo } from "../library/actions";
import { Button, IconButton, ProgressBar, confirmDialog } from "../../components/ui";

export function useTransfers() {
  useSyncExternalStore(subscribe, snapshot);
  return transfers;
}

/** Why a running transfer isn't moving, when it's the connection: whose side it's waiting on, or retrying. */
function waitingFor(t: Transfer, state: ConnectionState) {
  if (["preparing", "uploading", "finishing", "cancelling"].includes(t.status)) {
    if (state === "down") return "Paused · waiting for Relay…";
    if (state === "offline" || state === "no-network") return "Paused · waiting for your connection…";
  }
  if (t.stalled && t.status === "uploading") return "Reconnecting…";
  return "";
}

// Cancelling right after starting loses nothing worth asking about.
const CONFIRM_BYTES = 10 * 1024 ** 2;
const CONFIRM_AFTER = 10_000;

/** Cancels, first asking when that would throw away real progress, and saying exactly what. */
async function confirmCancel(t: Transfer) {
  const lost = unsavedBytes(t);
  if (lost >= CONFIRM_BYTES || (lost > 0 && Date.now() - t.started >= CONFIRM_AFTER)) {
    const kept = t.doneFiles > 0 && !t.guest;
    const ok = await confirmDialog({
      title: `Stop uploading ${t.name}?`,
      body: `${bytes(lost)} uploaded so far will be discarded.${kept ? " What already finished stays in Files." : ""}`,
      confirm: "Stop upload",
      cancel: "Keep uploading",
      danger: true,
    });
    if (!ok) return;
  }
  cancel(t);
}

/**
 * One quiet line for a transfer that keeps running while you compose the next one.
 * "Show" brings it back into the drop box.
 */
export function TransferStrip({
  t,
  answer,
  onShow,
}: {
  t: Transfer;
  /** For a transfer sent to a device, how that device answered it. */
  answer: DeliveryState;
  onShow: () => void;
}) {
  const pct = t.totalBytes ? Math.floor((t.sentBytes / t.totalBytes) * 100) : 0;
  const busy = isBusy(t);
  const waiting = waitingFor(t, useConnection().state);
  const status = waiting
    ? waiting
    : t.status === "done"
      ? doneLabel(t, answer)
      : t.status === "cancelled"
        ? t.cancelled && !t.cancelled.removed && !t.adding
          ? "Cancelled · Part of it was kept in Files"
          : "Cancelled"
        : t.status === "failed"
          ? "Couldn’t finish"
          : t.status === "destination"
            ? destinationFailure(t)
            : t.status === "attention"
              ? "Needs attention"
              : t.status === "paused"
                ? `Paused at ${pct}%`
                : t.status === "uploading"
                  ? `${pct}%`
                  : t.status === "cancelling"
                    ? "Cancelling…"
                    : "Finishing…";
  return (
    <div className={`transfer-strip transfer-strip-${t.status}`} aria-label={`${t.name}: ${status}`} role="group">
      {t.status === "done" ? (
        <CheckCircle2 className="ok" size={16} aria-hidden />
      ) : busy ? (
        <span className="strip-meter" aria-hidden>
          <span style={{ width: `${Math.max(pct, 6)}%` }} />
        </span>
      ) : (
        <CircleAlert className="transfer-x" size={16} aria-hidden />
      )}
      <strong className="transfer-name" title={t.name}>
        {t.name}
      </strong>
      <span className="transfer-line muted">{status}</span>
      <Announce t={t} answer={answer} />
      <Button size="sm" variant="ghost" onClick={onShow}>
        Show
      </Button>
      {busy && t.status !== "cancelling" ? (
        <Button size="sm" variant="ghost" onClick={() => void confirmCancel(t)}>
          Cancel
        </Button>
      ) : !busy ? (
        <IconButton size="sm" label={`Dismiss ${t.name}`} icon={<X size={16} />} onClick={() => dismiss(t)} />
      ) : null}
    </div>
  );
}

/**
 * Announces state changes (started, paused, done, failed) to screen readers without reading out
 * progress numbers that change several times a second.
 */
function Announce({ t, answer = "available" }: { t: Transfer; answer?: DeliveryState }) {
  return (
    <span className="visually-hidden" role="status">
      {phase(t, answer)}
    </span>
  );
}
function phase(t: Transfer, answer: DeliveryState): string {
  switch (t.status) {
    case "preparing":
      return `Preparing ${t.name}`;
    case "uploading":
      return `${goingLabel(t)}: ${t.name}`;
    case "paused":
      return `Paused ${t.name}`;
    case "finishing":
      return `Finishing ${t.name}`;
    case "attention":
      return `Some files in ${t.name} couldn’t upload`;
    case "destination":
      return destinationFailure(t);
    case "done":
      return `${t.name}: ${doneLabel(t, answer)}${t.copied && t.link ? "; copied to clipboard" : ""}`;
    case "cancelling":
      return `Cancelling ${t.name}`;
    case "cancelled":
      return `Cancelled ${t.name}`;
    case "failed":
      return `${t.name} couldn’t finish`;
  }
}

function destinationFailure(t: Transfer) {
  const d = t.destination;
  if (d.kind === "device") return `Saved, but not sent to ${d.name}`;
  if (d.kind === "link") return "Saved, but the link wasn’t created";
  return "Saved, but not finished";
}

/** What the receiving device said: accepted, declined, or nothing yet. Never more than it said. */
const DEVICE_ANSWER: Record<DeliveryState, (device: string) => string> = {
  available: (device) => `Sent to ${device} · not accepted yet`,
  accepted: (device) => `Accepted on ${device}`,
  declined: (device) => `Declined on ${device} · still in Files`,
};

function doneLabel(t: Transfer, answer: DeliveryState) {
  const d = t.destination;
  // A saved or sent item can get a link afterwards; the link is then the news.
  const link = "Link ready";
  if (d.kind === "link") return link;
  if (d.kind === "device") {
    const sent = DEVICE_ANSWER[answer](d.name);
    return t.link ? `${sent} · link ready` : sent;
  }
  if (d.kind === "guest") return "Uploaded";
  if (t.adding) return "Added";
  return t.link ? link : "Saved to Files";
}

/** What is happening while bytes move: "Saving to Files", "Sending to Phone". */
function goingLabel(t: Transfer) {
  const d = t.destination;
  if (d.kind === "link") return "Uploading for a link";
  if (d.kind === "device") return `Sending to ${d.name}`;
  if (d.kind === "guest") return "Uploading";
  if (t.adding) return `Adding to “${t.name}”`;
  return "Saving to Files";
}

export function TransferCard({
  t,
  answer = "available",
  onOpen,
  embedded = false,
  onDismiss,
  free,
}: {
  t: Transfer;
  /** For a transfer sent to a device, how that device answered it. */
  answer?: DeliveryState;
  onOpen: () => void;
  /** Shown inside the drop box, which has its own Done button. */
  embedded?: boolean;
  /** In the drop box, a finished transfer beside running ones can be put away on its own. */
  onDismiss?: () => void;
  /** Your free storage, when you can free up more; a refusal for space then says how much. */
  free?: number;
}) {
  const files = t.tasks.length;
  const pct = t.totalBytes ? Math.floor((t.sentBytes / t.totalBytes) * 100) : 0;
  const waiting = waitingFor(t, useConnection().state);
  // No time estimate while nothing moves.
  const remaining = t.speed > 0 && !waiting ? (t.totalBytes - t.sentBytes) / t.speed : NaN;
  const terminal = ["done", "cancelled", "failed"].includes(t.status);
  const need = payloadBytes(t.totalBytes, t.text);
  const d = t.destination;
  let status: React.ReactNode = null;
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (t.status === "preparing") {
    status = waiting || (files ? `Preparing ${plural(files, "file")}…` : "Saving…");
    // Same buttons in the same places as while uploading, so Cancel never moves under the pointer.
    actions = (
      <>
        <Button size="sm" icon={<Pause size={16} />} disabled>
          Pause
        </Button>
        <Button size="sm" onClick={() => void confirmCancel(t)}>
          Cancel
        </Button>
      </>
    );
  } else if (t.status === "uploading" || t.status === "paused") {
    status =
      t.status === "paused"
        ? `Paused at ${pct}%`
        : waiting
          ? `${waiting} · ${pct}%`
          : t.sentBytes === 0
            ? `${goingLabel(t)} · starting…`
            : `${goingLabel(t)} · ${pct}% · ${bytes(t.sentBytes)} of ${bytes(t.totalBytes)}${remaining >= 0 ? ` · ${duration(remaining)} left` : ""}`;
    actions = (
      <>
        {t.status === "paused" ? (
          <Button size="sm" icon={<Play size={16} />} onClick={() => resume(t)}>
            Resume
          </Button>
        ) : (
          <Button size="sm" icon={<Pause size={16} />} onClick={() => pause(t)}>
            Pause
          </Button>
        )}
        <Button size="sm" onClick={() => void confirmCancel(t)}>
          Cancel
        </Button>
      </>
    );
  } else if (t.status === "finishing") {
    status = waiting
      ? waiting
      : d.kind === "link"
        ? "Creating link…"
        : d.kind === "device"
          ? `Sending to ${d.name}…`
          : "Finishing…";
    actions = (
      <Button size="sm" onClick={() => cancel(t)}>
        Cancel
      </Button>
    );
  } else if (t.status === "cancelling") {
    status = waiting || "Cancelling…";
  } else if (t.status === "attention") {
    status = `${plural(t.failedFiles, "file")} couldn’t upload`;
    body = (
      <p className="transfer-note error">
        <CircleAlert size={16} aria-hidden /> {t.firstError || "The upload was interrupted."}
      </p>
    );
    actions = (
      <>
        <Button size="sm" variant="primary" icon={<RotateCcw size={16} />} onClick={() => retryFailed(t)}>
          Retry
        </Button>
        {t.doneFiles > 0 || t.text.trim() ? (
          <Button size="sm" onClick={() => void skipFailed(t)}>
            Continue without them
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void confirmCancel(t)}>
          Cancel
        </Button>
      </>
    );
  } else if (t.status === "destination") {
    status = destinationFailure(t);
    body = (
      <p className="transfer-note error">
        <CircleAlert size={16} aria-hidden /> {t.error || "The last step didn’t finish."}{" "}
        {t.guest ? "Everything uploaded has been received." : "Everything uploaded is already in Files."}
      </p>
    );
    actions = (
      <>
        <Button size="sm" variant="primary" icon={<RotateCcw size={16} />} onClick={() => retarget(t)}>
          Try again
        </Button>
        {d.kind !== "link" && d.kind !== "guest" && (
          <Button
            size="sm"
            icon={<Link2 size={16} />}
            onClick={() => retarget(t, { kind: "link", days: defaultLinkDays() })}
          >
            Create a link instead
          </Button>
        )}
        {d.kind === "device" || d.kind === "link" ? (
          <Button size="sm" onClick={() => retarget(t, { kind: "save" })}>
            Just keep it in Files
          </Button>
        ) : null}
      </>
    );
  } else if (t.status === "done") {
    status = doneLabel(t, answer);
    if (t.link) body = <LinkPanel share={t.link} />;
    // Something forgotten joins what was just sent (and any link to it) instead of needing a second link.
    if (embedded && !t.guest && t.itemId)
      actions = (
        <Button
          size="sm"
          variant="ghost"
          className="transfer-add"
          icon={<Plus size={16} />}
          onClick={() => void addFilesTo({ id: t.itemId!, name: t.name })}
        >
          Add files
        </Button>
      );
  } else if (t.status === "cancelled") {
    const c = t.cancelled;
    if (t.adding)
      // The item was there before and stays; only files that finished joined it.
      status = c?.saved ? `Cancelled · ${plural(c.saved, "finished file")} joined it` : "Cancelled · nothing was added";
    else if (!c || c.removed) status = "Cancelled · nothing was kept";
    else {
      // Say "it" when a single finished file was kept.
      const one = c.saved === 1;
      status = one ? "Cancelled · 1 finished file was kept in Files" : "Cancelled · Part of it was kept in Files";
      if (!t.guest)
        actions = (
          <>
            <Button size="sm" onClick={onOpen}>
              {one ? "View it" : "View them"}
            </Button>
            <Button size="sm" variant="danger" busy={c.deleting} onClick={() => void deleteSaved(t)}>
              {one ? "Delete it" : "Delete them"}
            </Button>
          </>
        );
    }
  } else if (t.status === "failed" && t.rejected && free !== undefined && (t.rejected === 507 || need > free)) {
    // Retrying can't help until something is deleted, and there's no upload to keep a tab open for.
    status = "Not enough space";
    body = (
      <p className="transfer-note error">
        <CircleAlert size={16} aria-hidden />{" "}
        {t.rejected === 507 ? t.error : `You have ${bytes(free)} free; this needs ${bytes(need)}.`}
      </p>
    );
    actions = (
      <Button size="sm" variant="primary" onClick={() => navigate("/files")}>
        Free up space
      </Button>
    );
  } else if (t.status === "failed") {
    status = "Couldn’t finish";
    body = (
      <p className="transfer-note error">
        <CircleAlert size={16} aria-hidden /> {t.error}
      </p>
    );
    if (canRetryCreate(t) || t.cancelRequested)
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={() => (t.cancelRequested ? cancel(t) : retryCreate(t))}>
            Retry
          </Button>
          {!t.cancelRequested && (
            <Button size="sm" onClick={() => cancel(t)}>
              Cancel
            </Button>
          )}
        </>
      );
  }
  const showProgress = ["uploading", "paused", "preparing", "attention"].includes(t.status) && files > 0;
  if (embedded)
    return (
      <TransferHero
        t={t}
        status={status}
        body={body}
        actions={actions}
        showProgress={showProgress}
        pct={pct}
        remaining={remaining}
        waiting={waiting}
        answer={answer}
        onDismiss={onDismiss}
      />
    );
  // Finished transfers collapse to one quiet line so the page doesn't fill up with big cards.
  if (terminal && !body && !embedded)
    return (
      <article
        id={`transfer-${t.id}`}
        className={`transfer card-surface transfer-compact transfer-${t.status}`}
        aria-label={t.name}
      >
        {t.status === "done" ? (
          <CheckCircle2 className="ok" size={18} aria-hidden />
        ) : (
          <X className="transfer-x" size={18} aria-hidden />
        )}
        <strong className="transfer-name" title={t.name}>
          {t.name}
        </strong>
        <span className="transfer-line muted">
          {status}
          {files > 0 && t.status === "done" ? ` · ${plural(t.doneFiles, "file")} · ${bytes(t.totalBytes)}` : ""}
        </span>
        <Announce t={t} answer={answer} />
        {actions && <div className="row transfer-actions">{actions}</div>}
        <IconButton size="sm" label="Dismiss" icon={<X size={16} />} onClick={() => dismiss(t)} />
      </article>
    );
  return (
    <article
      id={`transfer-${t.id}`}
      className={`transfer${embedded ? " transfer-embedded" : " card-surface"} transfer-${t.status}`}
      aria-label={t.name}
    >
      <div className="transfer-head">
        <div className="transfer-title">
          {t.status === "done" && <CheckCircle2 className="ok" size={embedded ? 22 : 18} aria-hidden />}
          <strong title={t.name}>{t.name}</strong>
        </div>
        {terminal && !embedded && (
          <IconButton size="sm" label="Dismiss" icon={<X size={16} />} onClick={() => dismiss(t)} />
        )}
      </div>
      {showProgress && <ProgressBar value={t.sentBytes} max={t.totalBytes} label={`Progress for ${t.name}`} />}
      <Announce t={t} answer={answer} />
      <div className="transfer-status">
        <span>{status}</span>
        {showProgress && files > 1 && (
          <span className="muted">
            {t.doneFiles.toLocaleString()} of {plural(files, "file")}
          </span>
        )}
        {!showProgress && files > 0 && t.status === "done" && (
          <span className="muted">
            {plural(t.doneFiles, "file")} · {bytes(t.totalBytes)}
          </span>
        )}
      </div>
      {body}
      {actions && <div className="row transfer-actions">{actions}</div>}
    </article>
  );
}

/**
 * The transfer inside the drop box: where it's going, what it is, and one large measure of progress,
 * laid out in the same space the drop box had so the page doesn't jump when you press Send.
 */
function TransferHero({
  t,
  status,
  body,
  actions,
  showProgress,
  pct,
  remaining,
  waiting,
  answer,
  onDismiss,
}: {
  t: Transfer;
  answer: DeliveryState;
  onDismiss?: () => void;
  status: React.ReactNode;
  body: React.ReactNode;
  actions: React.ReactNode;
  showProgress: boolean;
  pct: number;
  remaining: number;
  waiting: string;
}) {
  const files = t.tasks.length;
  const d = t.destination;
  const tone =
    t.status === "done"
      ? "done"
      : t.status === "failed" || t.status === "attention" || t.status === "destination"
        ? "error"
        : t.status === "cancelled"
          ? "off"
          : t.status === "paused" || waiting
            ? "paused"
            : "busy";
  const icon =
    tone === "done" ? (
      <CheckCircle2 size={16} />
    ) : tone === "error" ? (
      <CircleAlert size={16} />
    ) : tone === "off" ? (
      <Ban size={16} />
    ) : waiting ? (
      <WifiOff size={16} />
    ) : tone === "paused" ? (
      <Pause size={16} />
    ) : t.status === "uploading" && t.sentBytes > 0 ? (
      d.kind === "link" ? (
        <Link2 size={16} />
      ) : d.kind === "device" ? (
        <Monitor size={16} />
      ) : (
        <HardDriveUpload size={16} />
      )
    ) : (
      <Loader2 size={16} className="spin" />
    );
  // While bytes move, the headline is where it's going and the numbers get their own line.
  const moving = t.status === "uploading" && t.sentBytes > 0 && !waiting;
  const headline = waiting || (moving ? goingLabel(t) : status);
  const hasShareHandoff = t.status === "done" && !!t.link;
  const detail = showProgress
    ? [
        t.sentBytes > 0 && `${bytes(t.sentBytes)} of ${bytes(t.totalBytes)}`,
        t.status === "uploading" && remaining >= 0 && `${duration(remaining)} left`,
        files > 1 && `${t.doneFiles.toLocaleString()} of ${plural(files, "file")}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : t.status === "done" && files > 0
      ? `${plural(t.doneFiles, "file")} · ${bytes(t.totalBytes)}`
      : "";
  return (
    <article
      id={`transfer-${t.id}`}
      className={`transfer transfer-embedded transfer-${t.status}`}
      aria-label={t.name}
      tabIndex={-1}
    >
      {onDismiss && (
        <IconButton
          size="sm"
          className="transfer-hero-dismiss"
          label={`Dismiss ${t.name}`}
          icon={<X size={16} />}
          onClick={onDismiss}
        />
      )}
      {!hasShareHandoff && (
        <div className={`transfer-eyebrow tone-${tone}`}>
          <span className="transfer-eyebrow-icon" aria-hidden>
            {icon}
          </span>
          <span>{headline}</span>
        </div>
      )}
      <Announce t={t} answer={answer} />
      <strong className="transfer-hero-name" title={t.name}>
        {t.name}
      </strong>
      {showProgress ? (
        <div className="transfer-meter">
          <div className="transfer-numbers">
            <span className="transfer-pct">
              {pct}
              <small>%</small>
            </span>
            {detail && <span className="muted">{detail}</span>}
          </div>
          <ProgressBar value={t.sentBytes} max={t.totalBytes} label={`Progress for ${t.name}`} minVisible />
        </div>
      ) : (
        detail && <span className="transfer-hero-detail muted">{detail}</span>
      )}
      {body}
      {actions && <div className="row transfer-actions">{actions}</div>}
    </article>
  );
}
