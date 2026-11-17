import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, HardDriveUpload, Link2, PenLine, QrCode } from "lucide-react";
import { useSession } from "../../app/session";
import { ThisDeviceName } from "../../app/devices";
import {
  addSelection,
  clearDraft,
  clearItems,
  draftFiles,
  getDraft,
  removeItem,
  restoreDraft,
  setText,
  useDraft,
} from "../../lib/draft";
import { autoName as nameOf, bytes } from "../../lib/format";
import { days } from "../../lib/options";
import {
  NewLinkOptions,
  NewLinkSummary,
  linkChoiceProblem,
  linkRequest,
  newLinkChoice,
  useLinkChoiceLimit,
} from "../../components/LinkOptions";
import { navigate, scrollMotion } from "../../lib/router";
import { ContentBox, FilePickers } from "../../components/ContentBox";
import {
  addLink,
  contentTop,
  dismiss,
  awaitsChoice,
  isBusy,
  keepInFiles,
  payloadBytes,
  startTransfer,
  type Destination,
  type Transfer,
} from "../../lib/transfers";
import { useLive } from "../../lib/live";
import { useConnection } from "../../lib/connection";
import { LIMITS, api, type Delivery, type Device } from "../../api";
import { Button, LoadFailed, Popover, dismissToastKey } from "../../components/ui";
import { CollectionModal } from "../library/CollectionModal";
import { AddDevice } from "../settings/AddDevice";
import { errorToast, sendItem } from "../library/actions";
import { TransferCard, TransferStrip, useTransfers, type DeviceAnswer } from "./TransferList";
import { OwnDevices } from "./Destinations";
import { PausedUploads } from "./PausedUploads";

const DRAFT_UNDO = "draft-undo";

/** Whether this tab chose "Send something else" (the drop box is free while transfers run). */
let composingKept = false;

/** Where a row sends, remembered when it was chosen before anything was added. */
type Armed = { kind: "save" } | { kind: "link" } | { kind: "device"; device: Device };

const armedName = (a: Armed) => (a.kind === "save" ? "Files" : a.kind === "link" ? "a new link" : a.device.name);

/**
 * The Send page: the drop box and whatever you pass as children (Recent) on the
 * left, and the destinations on the right. A transfer you start shows inside the
 * drop box until you press Done; it also appears in Recent once saved. Choosing a
 * destination before adding anything opens the picker and sends there once chosen.
 */
export function Composer({ children }: { children?: React.ReactNode }) {
  const { me, refreshMe, devices, devicesLoading, devicesError, reloadDevices } = useSession();
  const draft = useDraft();
  const list = useTransfers();
  // True while you compose the next thing; transfers still running show as one-line strips.
  // "Send something else" holds for this tab while its transfers run, not just while Send is shown.
  const [composing, setComposingState] = useState(() => composingKept);
  const setComposing = (next: boolean) => {
    composingKept = next;
    setComposingState(next);
  };
  const [open, setOpen] = useState<string | null>(null);
  const sent = useLive(
    list.some((t) => t.delivery) ? api.deliveries.list : null,
    { query: { direction: "sent" } },
    ["deliveries"],
    [] as Delivery[],
  );
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [linkDraft, setLink] = useState(() => newLinkChoice(me.prefs.linkDays));
  const link = useLinkChoiceLimit(linkDraft, setLink);
  const [linkOptionsOpen, setLinkOptionsOpen] = useState(false);
  // A link was asked for with settings that can't make one (a password still to type).
  const [linkTried, setLinkTried] = useState(false);
  // A destination chosen with nothing added: the picker opened for it.
  const [armed, setArmed] = useState<Armed | null>(null);
  const launch = useRef<Armed | null>(null);
  // The devices the finished item was also sent to from the panel.
  const [also, setAlso] = useState<string[]>([]);
  const [alsoBusy, setAlsoBusy] = useState("");
  useEffect(() => setLink((current) => ({ ...current, days: me.prefs.linkDays })), [me.prefs.linkDays]);
  // The transfer just sent, and the control it was sent from, until focus has settled on it.
  const handoff = useRef<{ id: string; from: Element | null } | null>(null);

  const items = draft.items;
  const hasText = draft.text.trim().length > 0;
  const ready = items.length > 0 || hasText;
  const size = items.reduce((n, i) => n + i.size, 0);
  const showing = list.length > 0 && !composing;
  // The name the transfer will get unless you type one, built from the whole selection.
  // The selection's part is worked out when it changes, not on every keystroke in the text.
  const top = useMemo(() => {
    const { files, folders } = draftFiles(items);
    return contentTop(files, folders);
  }, [items]);
  const autoName = nameOf(top, draft.text);
  // The server refuses a transfer that doesn't fit, so say so before anything is sent.
  const free = me.usage.available;
  const need = payloadBytes(size, draft.text);
  const noSpace = ready && !showing && need > free;
  // Usage moves with every upload and deletion, here or elsewhere; check it when something comes to
  // wait to be sent, and when the server turned one down. The session follows later changes itself.
  const rejected = list.some((t) => t.rejected);
  useEffect(() => {
    if (!(ready && !showing) && !rejected) return;
    void refreshMe().catch(() => {});
  }, [ready, showing, rejected, refreshMe]);
  const allFinished = list.every((t) => !isBusy(t));
  // Nothing is running: each transfer is finished, or saved with only its destination to decide.
  const settled = list.every((t) => !isBusy(t) || awaitsChoice(t));
  // One finished item in the drop box can also go to other places from the panel.
  const finished =
    showing && allFinished && list.length === 1 && list[0].status === "done" && list[0].itemId ? list[0] : null;
  const savedItem = useLive(
    finished?.itemId ? api.items.get : null,
    finished?.itemId ? { params: { id: finished.itemId } } : null,
    ["items"],
    null,
  );
  const finishedItem = savedItem.data?.id === finished?.itemId ? savedItem.data : null;
  const checkingItem = !!finished && !finishedItem;
  const draftLifetime = Math.min(me.user.retentionDays || Infinity, me.user.limits.keepDays ?? Infinity);
  const linkDeadline = finished
    ? finishedItem?.expires
    : Number.isFinite(draftLifetime)
      ? Date.now() + draftLifetime * 86_400_000
      : null;
  useEffect(() => {
    if (!list.length) setComposing(false);
  }, [list.length]);
  useEffect(() => setAlso([]), [finished?.id]);
  // Dropping or pasting something new while a transfer is shown starts the next one.
  useEffect(() => {
    if (ready && showing) startNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  /** Done: finished transfers leave the drop box (they're in Recent); running ones shrink to strips. */
  function startNext() {
    for (const t of [...list]) {
      if (!isBusy(t)) dismiss(t);
      else if (awaitsChoice(t)) void keepInFiles(t);
    }
    setComposing(true);
  }
  const answerOf = (t: Transfer): DeviceAnswer => {
    const d = t.delivery && sent.data.find((x) => x.id === t.delivery!.id);
    if (d && d.state !== "available") return d.state;
    if (d?.delivered) return "delivered";
    const to = t.destination.kind === "device" ? t.destination.device : "";
    return devices.find((x) => x.id === to)?.online ? "sent" : "waiting";
  };

  /** Empties the files, keeping the text; returns how to put them back. */
  function clearFiles() {
    const previous = getDraft();
    clearItems();
    return () => restoreDraft({ ...getDraft(), items: previous.items });
  }
  // On a phone the destinations fold away while it uploads, so the transfer takes focus: the card
  // while it runs, then its main control (Copy link or Done, never the quieter Add files) once it has finished. Where the
  // used destination is still on screen it keeps focus, and anywhere you move focus yourself wins.
  useEffect(() => {
    const h = handoff.current;
    if (!h) return;
    const t = list.find((x) => x.id === h.id);
    const card = document.getElementById(`transfer-${h.id}`);
    if (!t || !card) {
      if (!t) handoff.current = null;
      return;
    }
    const active = document.activeElement;
    const lostFocus =
      !active ||
      active === document.body ||
      !active.isConnected ||
      (active === h.from && !active.getClientRects().length);
    if (!lostFocus && active !== card) {
      // The chosen destination can stay visible while uploading, then disappear when the result
      // replaces it. Keep the handoff pending unless the person deliberately moves focus.
      if (active === h.from && isBusy(t) && !awaitsChoice(t)) return;
      handoff.current = null;
      return;
    }
    if (isBusy(t) && !awaitsChoice(t)) {
      if (active !== card) card.focus({ preventScroll: true });
      return;
    }
    handoff.current = null;
    const main =
      card.querySelector<HTMLElement>(
        ".share-access-copy, .transfer-actions button:not([disabled]):not(.transfer-add)",
      ) ?? card.closest(".composer")?.querySelector<HTMLElement>(".transfer-view-foot .btn");
    (main ?? card).focus({ preventScroll: true });
  });
  function send(destination: Destination) {
    if (!ready || noSpace) return;
    // Undoing a clear makes no sense once the next thing is on its way.
    dismissToastKey(DRAFT_UNDO);
    const { files, folders } = draftFiles(items);
    const t = startTransfer({
      files,
      folders,
      text: draft.text,
      name: name.trim() || null,
      destination,
    });
    reset();
    handoff.current = { id: t.id, from: document.activeElement };
  }
  /** Each new transfer starts from your defaults, not from the last one's choices. */
  function reset() {
    clearDraft();
    setName("");
    setLink(newLinkChoice(me.prefs.linkDays));
    setLinkTried(false);
    setComposing(false);
  }
  /** With nothing added, a destination opens the picker and sends there once something is chosen. */
  function arm(target: Armed) {
    setArmed(target);
    filesInput.current?.click();
  }
  // Something was picked for an armed destination: send it there.
  useEffect(() => {
    const target = launch.current;
    if (!target || !ready) return;
    launch.current = null;
    if (target.kind === "save") send({ kind: "save" });
    else if (target.kind === "link") toLink();
    else toDevice(target.device);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the picked files are in the draft.
  }, [items]);
  // The picker's Cancel puts the destination down again.
  useEffect(() => {
    const input = filesInput.current;
    if (!input || !armed) return;
    const cancel = () => setArmed(null);
    input.addEventListener("cancel", cancel);
    return () => input.removeEventListener("cancel", cancel);
  }, [armed]);
  async function alsoSend(key: string, work: () => Promise<unknown>) {
    setAlsoBusy(key);
    try {
      await work();
      setAlso((a) => [...a, key]);
    } catch (error) {
      errorToast(error);
    } finally {
      setAlsoBusy("");
    }
  }
  function toDevice(d: Device) {
    if (finished) return void alsoSend(d.id, () => sendItem(finished.itemId!, d));
    if (!ready) return arm({ kind: "device", device: d });
    send({ kind: "device", device: d.id, name: d.name });
  }
  function toLink() {
    if (checkingItem) return;
    if (!ready && !finished) return arm({ kind: "link" });
    if (linkChoiceProblem(link)) {
      setLinkTried(true);
      setLinkOptionsOpen(true);
      return;
    }
    if (!finished) return send({ kind: "link", ...linkRequest(link) });
    // The link shows in the drop box like any link transfer.
    void alsoSend("link", () => addLink(finished, linkRequest(link)));
  }

  const fd = finished?.destination;
  const linkDone = !!finished?.link;
  const sentTo = (id: string) => (fd?.kind === "device" && fd.device === id) || also.includes(id);
  // While Relay can't be reached nothing can be sent; choosing what to send carries on.
  const { state: connectionState } = useConnection();
  const cut = connectionState === "offline" || connectionState === "no-network" || connectionState === "down";
  const summary = cut
    ? connectionState === "down"
      ? "Sending is paused until Relay is back. You can keep choosing what to send."
      : "Sending is paused until you’re back online. You can keep choosing what to send."
    : finished
      ? null
      : showing
        ? settled
          ? null
          : "Busy with this transfer. Choose “Send something else” to start another."
        : noSpace
          ? `Not enough space: ${bytes(free)} left, this needs ${bytes(need)}.`
          : null;
  // With nothing added the rows stay usable: each opens the picker for itself.
  const destinationsOff = (showing && !finished) || noSpace || cut;
  // On a phone the destinations sit below the drop box; a bar brings them back into view.
  const panel = useRef<HTMLElement>(null);
  const [panelVisible, setPanelVisible] = useState(true);
  useEffect(() => {
    const el = panel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPanelVisible(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  function showDestinations() {
    panel.current?.scrollIntoView({ behavior: scrollMotion(), block: "start" });
    panel.current
      ?.querySelector<HTMLButtonElement>(".destination:not([aria-disabled='true'])")
      ?.focus({ preventScroll: true });
  }
  return (
    <div className="send-layout">
      <section
        className={`composer card-surface${showing && allFinished ? " is-transfer-settled" : ""}`}
        aria-label="Compose"
      >
        <FilePickers
          files={filesInput}
          folder={folderInput}
          onFiles={(files) => {
            // Picked for a destination chosen first: it goes there once it's in the box.
            if (armed) launch.current = armed;
            setArmed(null);
            addSelection(files);
          }}
          testId="file-input"
          folderTestId="folder-input"
        />
        {showing ? (
          <div className="transfer-view">
            {list.map((t) => (
              <TransferCard
                key={t.id}
                t={t}
                embedded
                free={free}
                answer={answerOf(t)}
                onOpen={() => t.itemId && setOpen(t.itemId)}
                onDismiss={!allFinished && !isBusy(t) ? () => dismiss(t) : undefined}
              />
            ))}
            <div className={`transfer-view-foot${allFinished ? " is-finished" : ""}`}>
              {settled ? (
                <>
                  <span className="muted">
                    {allFinished
                      ? "Drop, paste or add something to send the next thing."
                      : "Everything is saved in Files. Done keeps it there."}
                  </span>
                  <Button onClick={startNext}>Done</Button>
                </>
              ) : (
                <>
                  <span className="muted">Keep this tab open until it finishes.</span>
                  <Button variant="ghost" onClick={() => setComposing(true)}>
                    Send something else
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {list.length > 0 && (
              <div className="transfer-strips" aria-label="Other transfers" role="list">
                {list.map((t) => (
                  <div role="listitem" key={t.id}>
                    <TransferStrip t={t} answer={answerOf(t)} onShow={() => setComposing(false)} />
                  </div>
                ))}
              </div>
            )}
            <PausedUploads onView={(id) => setOpen(id)} />
            {armed && (
              <div className="send-armed" role="status">
                <span>
                  Choose what to send to <strong>{armedName(armed)}</strong>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setArmed(null)}>
                  Cancel
                </Button>
              </div>
            )}
            <ContentBox
              items={items}
              text={draft.text}
              textMax={LIMITS.textBytes}
              onFiles={(files) => addSelection(files)}
              onRemove={removeItem}
              onClearFiles={clearFiles}
              onText={setText}
              textId="composer-text"
              showTextEvent="relay-show-text"
              undoKey={DRAFT_UNDO}
              pickers={{ files: filesInput, folder: folderInput }}
            />
            {ready && (
              <div className="composer-meta" role="group" aria-label="Details">
                <NameChip name={name} placeholder={autoName} onChange={setName} />
              </div>
            )}
            {ready && me.user.limits.keepDays !== null && (
              <p className="field-hint">
                Maximum file age: {days(me.user.limits.keepDays)} from the first saved content, including Trash.
              </p>
            )}
          </>
        )}
      </section>
      {/* Empty drafts keep destinations discoverable. Only a transfer view without a reusable
          finished item folds the mobile panel; send eligibility is enforced by each action. */}
      <aside
        ref={panel}
        className={`send-panel card-surface${showing && !finished ? " is-showing-transfers" : ""}`}
        aria-label="Send to"
      >
        <h2 className="send-panel-title">{finished ? "Also send it to" : "Send to"}</h2>
        {summary && (
          <div
            className={`send-panel-summary${ready && !cut ? "" : " muted"}${cut ? " is-paused" : ""}`}
            aria-live="polite"
          >
            <p>{summary}</p>
            {noSpace && (
              <Button size="sm" onClick={() => navigate("/files")}>
                Free up space
              </Button>
            )}
          </div>
        )}
        {!finished && (
          <DestinationRow
            primary
            icon={<HardDriveUpload size={18} />}
            label="Save to Files"
            detail="Keep it in your Files"
            disabled={destinationsOff}
            onClick={() => (ready ? send({ kind: "save" }) : arm({ kind: "save" }))}
          />
        )}
        {!linkDone && (
          <DestinationRow
            icon={<Link2 size={18} />}
            label="Create link"
            detail={
              checkingItem ? (
                savedItem.error ? (
                  "Couldn’t check this item’s expiry."
                ) : (
                  "Checking item expiry…"
                )
              ) : (
                <NewLinkSummary value={link} itemDeadline={linkDeadline} />
              )
            }
            disabled={destinationsOff || checkingItem}
            busy={alsoBusy === "link"}
            onClick={toLink}
            // The settings can be chosen before there is anything to send; they apply to the next link.
            accessory={
              checkingItem ? (
                savedItem.error ? (
                  <Button size="sm" onClick={savedItem.reload}>
                    Retry
                  </Button>
                ) : null
              ) : (
                <NewLinkOptions
                  value={link}
                  itemDeadline={linkDeadline}
                  onChange={(next) => {
                    setLink(next);
                    setLinkTried(false);
                  }}
                  open={linkOptionsOpen}
                  onOpenChange={setLinkOptionsOpen}
                  attempted={linkTried}
                />
              )
            }
          />
        )}
        <h3 className="send-panel-heading">Your devices</h3>
        {devicesError && !cut && (
          <LoadFailed banner title="Devices couldn’t be loaded" error={devicesError} onRetry={reloadDevices} />
        )}
        {devicesLoading ? (
          <p className="send-panel-empty waiting">Loading devices…</p>
        ) : (
          <OwnDevices disabled={destinationsOff || !!devicesError} sentTo={sentTo} busy={alsoBusy} onSend={toDevice} />
        )}
        <DestinationRow
          quiet
          icon={<QrCode size={18} />}
          label="Add a device"
          detail="Sign in with a QR code or link"
          disabled={cut}
          onClick={() => setAdding(true)}
        />
        <ThisDeviceName />
      </aside>
      {ready && !showing && !panelVisible && (
        <div className="send-jump">
          <Button variant="primary" onClick={showDestinations}>
            Send to… <ChevronDown size={16} aria-hidden />
          </Button>
        </div>
      )}
      {adding && <AddDevice onClose={() => setAdding(false)} />}
      <div className="send-below">{children}</div>
      {open && <CollectionModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function DestinationRow({
  icon,
  label,
  detail,
  disabled,
  primary = false,
  quiet = false,
  done = false,
  busy = false,
  accessory,
  revealAccessory = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail: React.ReactNode;
  disabled: boolean;
  primary?: boolean;
  /** Not a destination: a helper that sits with them (Add a device). */
  quiet?: boolean;
  done?: boolean;
  busy?: boolean;
  /** The row's own control (link settings), in place of the arrow at its end. */
  accessory?: React.ReactNode;
  /** The accessory is secondary (editing a device): it takes the arrow's place only while the row
   *  is hovered or focused, except on touch screens, which can't hover. */
  revealAccessory?: boolean;
  onClick: () => void;
}) {
  // Named by its label; the detail ("Online now", "Sent") is read as its description.
  const id = useId();
  return (
    <div
      className={`destination-wrap${accessory && !revealAccessory ? " has-accessory" : ""}${revealAccessory ? " reveals-accessory" : ""}`}
    >
      <button
        type="button"
        className={`destination${primary ? " is-primary" : ""}${quiet ? " is-quiet" : ""}${done ? " is-done" : ""}`}
        // Unavailable rather than disabled: a destination just used keeps keyboard focus, so focus
        // never falls to the page or jumps to a neighbour that a second Enter would send to.
        aria-disabled={disabled || busy || undefined}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-detail`}
        aria-haspopup={quiet ? "dialog" : undefined}
        aria-busy={busy || undefined}
        onClick={() => {
          if (!disabled && !busy) onClick();
        }}
      >
        <span className="destination-icon" aria-hidden>
          {done ? <Check size={18} /> : icon}
        </span>
        <span className="destination-text">
          <strong id={`${id}-label`}>{label}</strong>
          <small id={`${id}-detail`}>{detail}</small>
        </span>
        {(!accessory || revealAccessory) && <ChevronRight size={16} className="destination-go" aria-hidden />}
      </button>
      {accessory && <div className="destination-accessory">{accessory}</div>}
    </div>
  );
}

/** The item's name: shows the automatic name until you give it one, edited in a small popover. */
function NameChip({
  name,
  placeholder,
  onChange,
}: {
  name: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const custom = name.trim();
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn btn-ghost btn-sm composer-name${custom ? "" : " is-auto"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Name: ${custom || placeholder}`}
        title="Rename"
        onClick={() => setOpen((v) => !v)}
      >
        <PenLine size={14} aria-hidden />
        <span>{custom || placeholder}</span>
      </button>
      {open && (
        <Popover
          anchor={button}
          onClose={() => setOpen(false)}
          label="Name"
          align="start"
          className="name-popover"
          flip
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setOpen(false);
              button.current?.focus();
            }}
          >
            <label className="field-label" htmlFor="composer-name">
              Name
            </label>
            <input
              id="composer-name"
              className="input"
              autoFocus
              value={name}
              maxLength={LIMITS.nameLength}
              placeholder={placeholder}
              onChange={(e) => onChange(e.target.value)}
            />
            <p className="muted small">Leave empty to name it automatically.</p>
          </form>
        </Popover>
      )}
    </>
  );
}
