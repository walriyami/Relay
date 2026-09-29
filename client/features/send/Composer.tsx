import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clock,
  FileText,
  Folder,
  HardDriveUpload,
  History,
  Link2,
  Loader2,
  Paperclip,
  PenLine,
  Pencil,
  Plus,
  QrCode,
  X,
} from "lucide-react";
import { useOnlineDevices, useSession } from "../../app/session";
import { DeviceIcon, ThisDeviceName, useEditDevice } from "../../app/devices";
import {
  addSelection,
  clearDraft,
  clearItems,
  draftFiles,
  fromFileList,
  getDraft,
  removeItem,
  restoreDraft,
  setText,
  useDraft,
  type DraftItem,
} from "../../lib/draft";
import { autoName as nameOf, bytes, plural } from "../../lib/format";
import { days, durations, KEEP_DAYS } from "../../lib/options";
import {
  NewLinkOptions,
  NewLinkSummary,
  linkChoiceProblem,
  linkRequest,
  newLinkChoice,
  useLinkChoiceLimit,
} from "../../components/LinkOptions";
import { navigate, scrollMotion } from "../../lib/router";
import { DocumentArt } from "../../components/DocumentArt";
import {
  abandonedUploads,
  addLink,
  contentTop,
  dismiss,
  forgetAbandoned,
  awaitsChoice,
  isBusy,
  keepInFiles,
  payloadBytes,
  startTransfer,
  type AbandonedUpload,
  type Destination,
  type Transfer,
} from "../../lib/transfers";
import { useLive } from "../../lib/live";
import { useConnection } from "../../lib/connection";
import { LIMITS, api, type Delivery, type DeliveryState } from "../../api";
import { Thumbnail } from "../../components/Thumbnail";
import { Button, IconButton, LoadFailed, Menu, Popover, dismissToastKey, toast } from "../../components/ui";
import { CollectionModal } from "../library/CollectionModal";
import { AddDevice } from "../settings/AddDevice";
import { allFiles, composition, errorToast, sendItem } from "../library/actions";
import { TransferCard, TransferStrip, useTransfers } from "./TransferList";

// Collapsed selections show a few rows; more on request.
const PREVIEW = 6;
const PAGE = 60;
// Phones and tablets can't drop files or pick folders.
const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

const DRAFT_UNDO = "draft-undo";

/**
 * "4 files, 1 folder" for the picks, plus "and text" when there is text. Folders hide how much they
 * hold, so a selection with folders also counts every file: "1 folder · 1,200 files".
 */
function describePicks(items: DraftItem[], hasText: boolean, fileTotal: number) {
  const files = items.filter((i) => i.kind === "file").length;
  const parts = composition(files, items.length - files, hasText ? 1 : 0);
  return files < items.length && fileTotal ? `${parts} · ${allFiles(fileTotal, files)}` : parts;
}

/** Whether this tab chose "Send something else" (the drop box is free while transfers run). */
let composingKept = false;

/**
 * The Send page: the drop box and whatever you pass as children (Recent) on the
 * left, and the destinations on the right. A transfer you start shows inside the
 * drop box until you press Done; it also appears in Recent once saved.
 */
export function Composer({ children }: { children?: React.ReactNode }) {
  const { me, refreshMe, devicesLoading, devicesError, reloadDevices } = useSession();
  const devices = useOnlineDevices();
  const editDevice = useEditDevice();
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
  const defaultKeep = me.user.retentionDays || 0;
  const [keep, setKeep] = useState(defaultKeep);
  const [shown, setShown] = useState(PREVIEW);
  // One frame, two modes: files (the drop area and picks) or the one text box.
  // Text kept from before a reload opens where it was typed.
  const [mode, setMode] = useState<"files" | "text">(() =>
    getDraft().text && !getDraft().items.length ? "text" : "files",
  );
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState("");
  // The devices the finished item was also sent to from the panel.
  const [also, setAlso] = useState<string[]>([]);
  const [alsoBusy, setAlsoBusy] = useState("");
  useEffect(() => setLink((current) => ({ ...current, days: me.prefs.linkDays })), [me.prefs.linkDays]);
  useEffect(() => setKeep(defaultKeep), [defaultKeep]);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const focusText = useRef(false);
  // The transfer just sent, and the control it was sent from, until focus has settled on it.
  const handoff = useRef<{ id: string; from: Element | null } | null>(null);
  function switchMode(next: "files" | "text") {
    setMode(next);
    if (next !== "text") return;
    // The text box takes focus once it is shown, unless focus has moved on by then.
    const from = document.activeElement;
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === from || !now || now === document.body) textArea.current?.focus();
    });
  }
  // Text pasted elsewhere on the page opens the text box so you can see it landed.
  useEffect(() => {
    const show = () => switchMode("text");
    window.addEventListener("relay-show-text", show);
    return () => window.removeEventListener("relay-show-text", show);
  }, []);

  const items = draft.items;
  const hasText = draft.text.trim().length > 0;
  const ready = items.length > 0 || hasText;
  const size = items.reduce((n, i) => n + i.size, 0);
  const fileTotal = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length), 0);
  const showing = list.length > 0 && !composing;
  // The name the transfer will get unless you type one, built from the whole selection.
  // The selection's part is worked out when it changes, not on every keystroke in the text.
  const top = useMemo(() => {
    const { files, folders } = draftFiles(items);
    return contentTop(files, folders);
  }, [items]);
  const autoName = nameOf(top, draft.text);
  // What a reload or leaving the page stopped last time; said in place of an empty drop box until
  // you add something or dismiss it.
  const stopped = abandonedUploads();
  useEffect(() => {
    if (ready) forgetAbandoned();
  }, [ready]);
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
  const draftLifetime = Math.min(keep || Infinity, me.user.limits.keepDays ?? Infinity);
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
  // New picks bring the files back into view.
  const count = useRef(items.length);
  useEffect(() => {
    if (!items.length) setShown(PREVIEW);
    if (items.length > count.current) setMode("files");
    count.current = items.length;
  }, [items.length]);

  /** Done: finished transfers leave the drop box (they're in Recent); running ones shrink to strips. */
  function startNext() {
    for (const t of [...list]) {
      if (!isBusy(t)) dismiss(t);
      else if (awaitsChoice(t)) void keepInFiles(t);
    }
    setComposing(true);
  }
  const answerOf = (t: Transfer): DeliveryState =>
    (t.delivery && sent.data.find((d) => d.id === t.delivery!.id)?.state) || "available";

  function pick(files: FileList | null, folder: boolean) {
    if (!files?.length) return;
    addSelection(fromFileList(files, folder));
  }
  function clearFiles() {
    const previous = getDraft();
    clearItems();
    toast("Files cleared", {
      key: DRAFT_UNDO,
      action: { label: "Undo", onClick: () => restoreDraft({ ...getDraft(), items: previous.items }) },
    });
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
  useEffect(() => {
    if (pasting || !focusText.current) return;
    focusText.current = false;
    textArea.current?.focus();
  }, [pasting]);
  async function paste() {
    setPasteError("");
    setPasting(true);
    const el = textArea.current;
    const text = draft.text;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    try {
      const clip = await navigator.clipboard.readText();
      setText((text.slice(0, start) + clip + text.slice(end)).slice(0, LIMITS.textBytes));
      requestAnimationFrame(() => {
        textArea.current?.focus();
        textArea.current?.setSelectionRange(start + clip.length, start + clip.length);
      });
    } catch {
      setPasteError("This browser won’t let Relay read the clipboard. Paste into the box with ⌘V or Ctrl+V.");
      // The box is read-only while pasting; it takes focus once it can be typed in again.
      focusText.current = true;
    } finally {
      setPasting(false);
    }
  }
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
      retentionDays: keep === defaultKeep ? undefined : keep || null,
    });
    // Each new transfer starts from your defaults, not from the last one's choices.
    clearDraft();
    setName("");
    setLink(newLinkChoice(me.prefs.linkDays));
    setLinkTried(false);
    setKeep(defaultKeep);
    setMode("files");
    setComposing(false);
    handoff.current = { id: t.id, from: document.activeElement };
  }
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
  function toDevice(d: { id: string; name: string }) {
    if (finished) void alsoSend(d.id, () => sendItem(finished.itemId!, d));
    else send({ kind: "device", device: d.id, name: d.name });
  }
  function toLink() {
    if (checkingItem) return;
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
  const canSend = finished ? true : ready && !showing;
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
          : ready
            ? null
            : "Add something, then choose where it goes.";
  const destinationsOff = !canSend || noSpace || cut;
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
        <input
          ref={filesInput}
          type="file"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          data-testid="file-input"
          onChange={(e) => {
            pick(e.target.files, false);
            e.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          aria-hidden
          tabIndex={-1}
          data-testid="folder-input"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            pick(e.target.files, true);
            e.target.value = "";
          }}
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
            {stopped && (
              <StoppedNotice
                stopped={stopped}
                onChoose={() => filesInput.current?.click()}
                onView={(id) => setOpen(id)}
              />
            )}
            <div className="composer-head">
              <span className={`composer-summary${ready ? "" : " muted"}`}>
                {ready
                  ? `${describePicks(items, hasText, fileTotal)}${size ? ` · ${bytes(size)}` : ""}`
                  : "Nothing added yet"}
              </span>
              <div className="composer-mode" role="group" aria-label="Content type" data-mode={mode}>
                <button type="button" aria-pressed={mode === "files"} onClick={() => switchMode("files")}>
                  Files
                  {fileTotal > 0 && <span className="composer-mode-count">{fileTotal.toLocaleString()}</span>}
                </button>
                <button type="button" aria-pressed={mode === "text"} onClick={() => switchMode("text")}>
                  Text
                  {hasText && <span className="composer-mode-dot" aria-label="has text" />}
                </button>
              </div>
            </div>
            <div className="composer-pane" hidden={mode !== "files"}>
              {items.length === 0 ? (
                <button type="button" className="composer-drop" onClick={() => filesInput.current?.click()}>
                  <DocumentArt />
                  <strong>{touch ? "Choose files to send" : "Drop files or folders"}</strong>
                  <span className="composer-browse">Browse files</span>
                </button>
              ) : (
                <ul className="selection-list" aria-label="Selected items">
                  {items.slice(0, shown).map((item) => (
                    <SelectionRow key={item.key} item={item} onRemove={() => removeItem(item.key)} />
                  ))}
                  {items.length > shown && (
                    <li className="selection-more">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShown(shown === PREVIEW ? PAGE : items.length)}
                      >
                        {shown === PREVIEW && items.length > PAGE
                          ? `Show ${PAGE - PREVIEW} more`
                          : `Show all ${items.length.toLocaleString()}`}
                      </Button>
                    </li>
                  )}
                </ul>
              )}
              <div className={`composer-tools${items.length ? "" : " is-centered"}`}>
                {items.length > 0 && (
                  <button type="button" onClick={() => filesInput.current?.click()}>
                    <Plus size={15} aria-hidden /> Add files
                  </button>
                )}
                {!touch && (
                  <button type="button" onClick={() => folderInput.current?.click()}>
                    <Folder size={15} aria-hidden /> {items.length ? "Add folder" : "Choose folder"}
                  </button>
                )}
                {items.length > 0 && (
                  <button type="button" className="composer-tools-end" onClick={clearFiles}>
                    <X size={15} aria-hidden /> Clear
                  </button>
                )}
              </div>
              {hasText && (
                <div className="composer-peek">
                  <FileText size={16} aria-hidden />
                  <span>{draft.text.trim().split("\n")[0]}</span>
                  <button type="button" onClick={() => switchMode("text")}>
                    Edit text
                  </button>
                </div>
              )}
            </div>
            <div className="composer-pane composer-write" hidden={mode !== "text"}>
              <label className="visually-hidden" htmlFor="composer-text">
                Text
              </label>
              <textarea
                id="composer-text"
                ref={textArea}
                placeholder="Write or paste text…"
                value={draft.text}
                maxLength={LIMITS.textBytes}
                readOnly={pasting}
                aria-busy={pasting || undefined}
                spellCheck
                onChange={(e) => {
                  setText(e.target.value);
                  setPasteError("");
                }}
              />
              <div className="composer-tools">
                <button
                  type="button"
                  // Unavailable rather than disabled, so focus stays here while the browser asks.
                  aria-disabled={pasting || undefined}
                  onClick={() => !pasting && void paste()}
                >
                  {pasting ? <Loader2 size={15} className="spin" aria-hidden /> : <Clipboard size={15} aria-hidden />}{" "}
                  Paste
                </button>
                <button
                  type="button"
                  disabled={!draft.text.length}
                  onClick={() => {
                    const previous = draft.text;
                    setText("");
                    setPasteError("");
                    textArea.current?.focus();
                    toast("Text cleared", {
                      key: DRAFT_UNDO,
                      action: { label: "Undo", onClick: () => setText(previous) },
                    });
                  }}
                >
                  <X size={15} aria-hidden /> Clear
                </button>
              </div>
              {pasteError && (
                <p className="field-error" role="alert">
                  {pasteError}
                </p>
              )}
              {items.length > 0 && (
                <div className="composer-peek">
                  <Paperclip size={16} aria-hidden />
                  <span>
                    {describePicks(items, false, fileTotal)} · {bytes(size)}
                  </span>
                  <button type="button" onClick={() => switchMode("files")}>
                    Show files
                  </button>
                </div>
              )}
            </div>
            {ready && (
              <div className="composer-meta" role="group" aria-label="Details">
                <NameChip name={name} placeholder={autoName} onChange={setName} />
                <Menu
                  label="Move to Trash after"
                  trigger={
                    <>
                      <Clock size={14} aria-hidden />
                      <span>{keep ? `Trash after ${days(keep)}` : "Keep until deleted"}</span>
                      <ChevronDown size={14} aria-hidden />
                    </>
                  }
                  items={durations(KEEP_DAYS, defaultKeep, me.user.limits.keepDays).map((v) => ({
                    label: v ? days(v) : "Never",
                    icon: v === keep ? <Check size={16} /> : <span className="menu-icon-gap" />,
                    onSelect: () => setKeep(v),
                  }))}
                />
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
            onClick={() => send({ kind: "save" })}
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
        {devices.length && !cut ? (
          devices.map((d) => (
            <DestinationRow
              key={d.id}
              icon={<DeviceIcon device={d} />}
              label={d.name}
              detail={
                sentTo(d.id) ? (
                  "Sent"
                ) : (
                  <>
                    <span className="online-dot" aria-hidden /> Online now
                  </>
                )
              }
              disabled={destinationsOff || !!devicesError || sentTo(d.id)}
              done={sentTo(d.id)}
              busy={alsoBusy === d.id}
              onClick={() => toDevice(d)}
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
          ))
        ) : (
          <p className={`send-panel-empty${!cut && devicesLoading ? " waiting" : ""}`}>
            {cut
              ? "Your devices show up here once you’re connected."
              : devicesLoading
                ? "Loading devices…"
                : devicesError
                  ? "Device availability is unknown. Retry to refresh."
                  : "Devices show up here while Relay is open on them."}
          </p>
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

/** Says what leaving or reloading the page stopped, and offers to pick it again. */
function StoppedNotice({
  stopped,
  onChoose,
  onView,
}: {
  stopped: { uploads: AbandonedUpload[]; reloaded: boolean };
  onChoose: () => void;
  onView: (itemId: string) => void;
}) {
  const { uploads, reloaded } = stopped;
  const when = reloaded ? "when the page reloaded" : "when you left the page";
  const kept = uploads.filter((u) => u.itemId);
  return (
    <div className="stopped-notice" role="status">
      <History size={18} aria-hidden />
      <div>
        <strong>
          {uploads.length === 1
            ? `Your upload of ${uploads[0].name} stopped ${when}.`
            : `${uploads.length} uploads stopped ${when}.`}
        </strong>
        <p className="muted">
          {uploads.length === 1 ? "Choose it again to send it." : "Choose them again to send them."}
          {kept.length > 0 && " What finished uploading is in Files."}
        </p>
        <div className="stopped-notice-actions">
          <Button size="sm" variant="primary" onClick={onChoose}>
            Choose again
          </Button>
          {kept.length === 1 && (
            <Button size="sm" variant="ghost" onClick={() => onView(kept[0].itemId!)}>
              View in Files
            </Button>
          )}
          {kept.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => navigate("/files")}>
              View in Files
            </Button>
          )}
        </div>
      </div>
      <IconButton size="sm" label="Dismiss" icon={<X size={16} />} onClick={forgetAbandoned} />
    </div>
  );
}

export function SelectionRow({ item, onRemove }: { item: DraftItem; onRemove: () => void }) {
  return (
    <li className="selection-row">
      {item.kind === "folder" ? (
        <div className="thumb thumb-compact thumb-folder">
          <div className="thumb-icon">
            <Folder size={20} />
          </div>
        </div>
      ) : (
        <Thumbnail compact file={item.file} entry={{ path: item.path, mime: item.file.type, size: item.size }} />
      )}
      <div className="selection-text">
        <span className="selection-name" title={item.name}>
          {item.name}
        </span>
        <span className="muted">
          {item.kind === "folder" ? `Folder · ${plural(item.files.length, "file")} · ` : ""}
          {bytes(item.size)}
        </span>
      </div>
      <IconButton size="sm" label={`Remove ${item.name}`} icon={<X size={16} />} onClick={onRemove} />
    </li>
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
