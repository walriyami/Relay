import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, Upload } from "lucide-react";
import { ApiError, api, call, shownText, type PublicRequest, type PublicShare } from "../api";
import { LIMITS } from "../../shared/model";
import { autoName, baseName, bytes, plural, until } from "../lib/format";
import { startTransfer, isBusy, payloadBytes, uniquePaths, type Transfer } from "../lib/transfers";
import {
  draftFiles,
  normalizeSelection,
  type DraftItem,
  type PickedDraftFile,
  type PickedFolder,
  type SelectionRename,
} from "../lib/draft";
import { navigate } from "../lib/router";
import { useExpiryClock } from "../lib/refresh";
import { Button, Field, toast } from "../components/ui";
import { ContentBox } from "../components/ContentBox";
import { usePageDrop } from "../components/PageDrop";
import { composition } from "../features/library/actions";
import { SHARE_GONE, ShareUnlock, ShareView, shareSummary, useShare } from "../features/incoming/ReceiveView";
import { CodeEntryForm, codeDigits } from "../features/codes/CodeEntry";
import { thisDevice } from "../features/auth/device-name";
import { AuthFrame } from "../features/auth/Auth";
import { TransferCard, useTransfers } from "../features/send/TransferList";
import { PublicCard, PublicFrame, PublicLoading, Unavailable } from "../components/PublicFrame";
import { Icon } from "../components/icons";
import { UserText } from "../components/UserText";

// Shared with the Nearby guest page, which imports them from here.
export { PublicFrame, Unavailable };

const hasFiles = (share: PublicShare) => share.nodes.some((n) => n.kind !== "text");
// A text-only share named after its own first line would just repeat the text box.
function shareTitle(share: PublicShare) {
  if (hasFiles(share)) return share.name;
  const text = share.nodes.find((n) => n.kind === "text")?.text || "";
  return share.name === autoName([], text) || share.name === "Text" ? "Shared text" : share.name;
}

const LINK_GONE = "This link has expired or was removed. Ask the person who sent it for a new one.";

export function PublicSharePage({ token }: { token: string }) {
  const { data, locked, error, canRetry, retry, unlock } = useShare(token);
  return (
    <PublicFrame width={error || locked ? "narrow" : data && hasFiles(data) ? "wide" : "medium"}>
      {error ? (
        <Unavailable
          title="Link unavailable"
          action={
            <div className="action-bar">
              {canRetry && <Button onClick={retry}>Retry</Button>}
              <button type="button" className="link" onClick={() => navigate("/pickup")}>
                Have a code?
              </button>
            </div>
          }
        >
          {error === SHARE_GONE ? LINK_GONE : error}
        </Unavailable>
      ) : locked ? (
        <div className="card-surface public-card">
          <ShareUnlock locked={locked} onUnlock={unlock} />
        </div>
      ) : !data ? (
        <PublicLoading />
      ) : (
        <PublicCard title={<UserText>{shareTitle(data)}</UserText>} subtitle={shareSummary(data)}>
          <ShareView token={token} share={data} />
        </PublicCard>
      )}
    </PublicFrame>
  );
}

export function PickupPage() {
  const [token, setToken] = useState<string | null>(null);
  const { data, locked, error, canRetry, retry, unlock } = useShare(token || "");
  // A code in the address is used once; "Another code" then starts from an empty field.
  const [prefilled, setPrefilled] = useState(() => new URLSearchParams(location.search).get("code") ?? "");
  useEffect(() => {
    if (prefilled) history.replaceState(history.state, "", location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a code in the address is cleared once, on load.
  }, []);
  // Someone already signed in is offered their way back, not another sign-in.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    call(api.session.get).then(
      () => setSignedIn(true),
      () => {},
    );
  }, []);
  if (!token)
    return (
      <AuthFrame title="Use a code" subtitle="Type the code someone gave you.">
        <CodeEntryForm
          page
          autoFocus
          initialCode={prefilled}
          onOpen={async (destination, code) => {
            setPrefilled("");
            if (destination.kind === "share") return setToken(destination.path.slice("/s/".length));
            if (destination.kind !== "device") return navigate(destination.path, true);
            try {
              await call(api.session.get);
              toast("This browser is already signed in. Sign out before using a sign-in code here.");
            } catch (error) {
              if (!(error instanceof ApiError && error.status === 401)) throw error;
              // Signed out: the code signs this browser in at once, as it does on the sign-in card.
              await call(api.session.code, { body: { code: codeDigits(code), ...thisDevice() } });
              navigate("/", true);
              return;
            }
          }}
        />
        <div className="auth-alt">
          <button type="button" className="link" onClick={() => navigate("/")}>
            {signedIn ? "Back to Relay" : "Sign in to Relay instead"}
          </button>
        </div>
      </AuthFrame>
    );
  return (
    <PublicFrame width={error || locked ? "narrow" : data && hasFiles(data) ? "wide" : "medium"}>
      {error ? (
        <Unavailable
          title="Link unavailable"
          action={
            <div className="action-bar">
              {canRetry && <Button onClick={retry}>Retry</Button>}
              <Button onClick={() => setToken(null)}>Try another code</Button>
            </div>
          }
        >
          {error === SHARE_GONE ? LINK_GONE : error}
        </Unavailable>
      ) : locked ? (
        <div className="card-surface public-card">
          <ShareUnlock locked={locked} onUnlock={unlock} />
        </div>
      ) : !data ? (
        <PublicLoading />
      ) : (
        <div className="card-surface public-card">
          <div className="between">
            <div className="public-title">
              <h1>
                <UserText>{shareTitle(data)}</UserText>
              </h1>
              <p className="muted">{shareSummary(data)}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setToken(null)}>
              Another code
            </Button>
          </div>
          <ShareView token={token} share={data} />
        </div>
      )}
    </PublicFrame>
  );
}

/** Something picked to send, with what it was renamed to as it was added. */
type Pick = DraftItem & { renames: Omit<SelectionRename, "itemKey">[] };

// The server compares names the way SQLite's NOCASE does: ASCII letters only.
const foldCase = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** The server's rule for a name already taken at the top of a submission: "a (2).txt", "Photos (2)". */
function freeName(name: string, taken: Set<string>, file: boolean) {
  if (!taken.has(foldCase(name))) return name;
  const dot = file ? name.lastIndexOf(".") : -1;
  const stem = (dot > 0 ? name.slice(0, dot) : name).trimEnd();
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(foldCase(candidate))) return candidate;
  }
}
/**
 * Places one upload's top-level entries next to `taken` (the names earlier uploads from this page
 * already hold in the submission) the way the server will, and returns the ones that get a new name.
 */
function place(files: { path: string }[], folders: string[], taken: Set<string>) {
  const renamed: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  const entries = [
    ...files.map((f) => ({ name: f.path.split("/")[0].normalize("NFC"), file: !f.path.includes("/") })),
    ...folders.map((f) => ({ name: f.split("/")[0].normalize("NFC"), file: false })),
  ];
  const placed: string[] = [];
  for (const entry of entries) {
    if (seen.has(foldCase(entry.name))) continue;
    seen.add(foldCase(entry.name));
    const name = freeName(entry.name, taken, entry.file);
    if (name !== entry.name) renamed.push({ from: entry.name, to: name });
    placed.push(name);
  }
  placed.forEach((name) => taken.add(foldCase(name)));
  return renamed;
}
/**
 * Picks that will be saved under another name: two different files with the same name in this
 * upload (the second becomes "a (2).txt"), or a name an earlier upload from this page already used.
 */
function renames(items: Pick[], earlier: Transfer[]) {
  const taken = new Set<string>();
  for (const t of earlier)
    place(
      t.tasks.filter((task) => task.status !== "skipped"),
      t.folders,
      taken,
    );
  const { files, folders } = draftFiles(items);
  const sent = uniquePaths(files);
  const result = items.flatMap((item) =>
    item.renames.map((rename) => {
      const from = baseName(rename.from);
      const to = baseName(rename.to);
      return { from: from === to ? rename.from : from, to: from === to ? rename.to : to, path: rename.path };
    }),
  );
  result.push(
    ...sent
      .map((f, i) => ({ from: files[i].path, to: f.path }))
      .filter((r) => r.from !== r.to)
      .map((r) => ({ from: baseName(r.from), to: baseName(r.to), path: r.from })),
  );
  for (const r of place(sent, folders, taken)) result.push({ ...r, path: r.from });
  return result;
}

/**
 * Why what's about to be sent doesn't fit the request, saying how much to remove; null when it fits. A request
 * with no room at all is shown as full instead (see `fullMessage`).
 */
function limitProblem(info: PublicRequest, size: number) {
  if (size <= info.remainingBytes) return null;
  const who = shownText(info.owner) || "The person who asked";
  return `${
    info.storageLimited
      ? `${who} has room for ${bytes(info.remainingBytes)} more right now`
      : info.remainingBytes < info.maxBytes
        ? `This request has room for ${bytes(info.remainingBytes)} more`
        : `This request accepts up to ${bytes(info.maxBytes)}`
  }. Remove ${bytes(size - info.remainingBytes)} to continue.`;
}

/** "This request is full. admin has received the 2 GB it allows." Null while there is room. */
function fullMessage(info: PublicRequest) {
  if (!info.full) return null;
  const who = shownText(info.owner) || "The person who asked";
  return info.remainingBytes === 0 && !info.storageLimited
    ? `This request is full. ${who} has received the ${bytes(info.maxBytes)} it allows.`
    : `This request is full. ${who} can’t receive more with it.`;
}

// Fired when text pasted elsewhere on the page lands in the text box, so the box shows it.
const SHOW_TEXT = "relay-guest-text";

/** "2 files and text", "1 folder", "text": what the Send button sends. */
function sendLabel(items: Pick[], files: number, hasText: boolean) {
  const picks = files ? plural(files, "file") : items.length ? plural(items.length, "folder") : "";
  return [picks, hasText ? "text" : ""].filter(Boolean).join(" and ");
}

// Someone asked for files or text. The guest adds them, reviews what's there, then presses Send.
export function GuestUpload({ token }: { token: string }) {
  const [info, setInfo] = useState<PublicRequest | null>(null);
  const [error, setError] = useState("");
  const now = useExpiryClock([info?.expires ?? Infinity]);
  const expired = !!info && info.expires <= now;
  const [items, setItems] = useState<Pick[]>([]);
  const [text, setText] = useState("");
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [sender, setSender] = useState("");
  const all = useTransfers().filter((t) => t.guest === token);
  const transfers = all.filter((t) => !seen.has(t.id));
  const finished = transfers.filter((t) => t.status === "done").length;
  const failed = transfers.filter((t) => t.status === "failed").length;
  // The owner can edit the request at any time. Reloaded after each finished or failed upload, and
  // when the page comes back into view, so the name, room left and closing time are current.
  const [looked, setLooked] = useState(0);
  const loaded = useRef(false);
  loaded.current = !!info;
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setLooked((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  useEffect(() => {
    let current = true;
    call(api.requests.open, { params: { token } })
      .then((next) => {
        if (!current) return;
        setInfo(next);
        setError("");
      })
      .catch((e: Error) => {
        if (!current) return;
        const gone = e instanceof ApiError && (e.status === 404 || e.status === 410);
        // A failed refresh keeps the page as it was; only a first load shows the error.
        if (gone) setError("gone");
        else if (!loaded.current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [token, finished, failed, looked]);
  function add(files: PickedDraftFile[], folders: PickedFolder[] = []) {
    // A file picker or folder read may return after the deadline, before its timer runs.
    if (!requestOpen()) return;
    setItems((current) => {
      const normalized = normalizeSelection(
        files,
        folders,
        current.map((item) => item.name),
      );
      const next = normalized.items.map((item): Pick => ({
        ...item,
        renames: normalized.renames
          .filter((rename) => rename.itemKey === item.key)
          .map(({ itemKey: _, ...rename }) => rename),
      }));
      return [...current, ...next];
    });
  }
  const count = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length), 0);
  const size = items.reduce((n, i) => n + i.size, 0);
  const hasText = text.trim().length > 0;
  const ready = items.length > 0 || hasText;
  // The server counts a visitor's text in bytes, and how many files and folders one send may list:
  // say so here rather than let Send be refused.
  const entries = items.reduce((n, i) => n + (i.kind === "file" ? 1 : i.files.length + i.folders.length), 0);
  const sendProblem =
    entries > LIMITS.visitorEntriesPerTransfer
      ? `Send up to ${LIMITS.visitorEntriesPerTransfer.toLocaleString("en-US")} files and folders at a time. Remove some to continue.`
      : hasText && new TextEncoder().encode(text).length > LIMITS.textBytes
        ? "This text is too long to send. Shorten it to continue."
        : null;
  const limitMessage = sendProblem ?? (info && limitProblem(info, payloadBytes(size, text)));
  const busy = transfers.some(isBusy);
  const done = transfers.filter((t) => t.status === "done");
  const full = info && !busy ? fullMessage(info) : null;
  const sent = !busy && done.length > 0 && (!ready || !!full);
  // Earlier uploads from this page, oldest first: their names are already taken in the submission.
  const renamed = useMemo(
    () => renames(items, all.filter((t) => t.status === "done").reverse()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when a transfer's status changes, not on every progress tick.
    [items, all.map((t) => `${t.id}:${t.status}`).join()],
  );
  // Dropping or pasting anywhere on the page adds to what will be sent, so a near miss never opens
  // the file in place of this page. While the request is full or just answered, drops are refused.
  const accepting = () => !!info && !error && !sent && !full && info.expires > Date.now();
  const overlay = usePageDrop({
    accepts: accepting,
    onFiles: (files, folders) => add(files, folders),
    onText: (pasted) => {
      if (text.trim()) return false;
      setText(pasted.slice(0, LIMITS.textBytes));
      window.dispatchEvent(new Event(SHOW_TEXT));
      return true;
    },
    hint: "Nothing is sent until you press Send.",
  });
  function requestOpen() {
    if (!info || error) return false;
    if (info.expires > Date.now()) return true;
    setError("gone");
    return false;
  }
  function upload() {
    if (!requestOpen() || !ready) return;
    const { files, folders } = draftFiles(items);
    startTransfer({
      files,
      folders,
      text: hasText ? text : "",
      name: null,
      destination: { kind: "guest" },
      guest: token,
      sender: sender.trim() || undefined,
    });
    setItems([]);
    setText("");
  }
  if (error || expired)
    return (
      <PublicFrame width={transfers.length ? "medium" : "narrow"}>
        <Unavailable
          title="Request unavailable"
          icon={<Icon.request size={22} />}
          action={<Button onClick={() => setLooked((n) => n + 1)}>Try again</Button>}
        >
          {error === "gone" || expired
            ? "This request has closed or was removed. Ask the person who sent it for a new link."
            : error}
        </Unavailable>
        {transfers.length > 0 && (
          <div className="transfer-list">
            {busy && <p className="muted">Uploads already accepted can still finish.</p>}
            {transfers.map((t) => (
              <TransferCard key={t.id} t={t} onOpen={() => {}} />
            ))}
          </div>
        )}
      </PublicFrame>
    );
  if (!info)
    return (
      <PublicFrame>
        <PublicLoading />
      </PublicFrame>
    );
  const delivered = done.reduce((n, t) => n + t.doneFiles, 0);
  const deliveredTexts = done.filter((t) => t.text.trim()).length;
  const deliveredBytes = done.reduce((n, t) => n + payloadBytes(t.totalBytes, t.text), 0);
  return (
    <PublicFrame>
      <div className="card-surface public-card">
        <div className="public-title">
          {info.owner && (
            <p className="request-owner">
              <UserText>{info.owner}</UserText> is asking for
            </p>
          )}
          <h1>
            <UserText>{info.name}</UserText>
          </h1>
          {info.description && (
            <p className="request-description">
              <UserText>{info.description}</UserText>
            </p>
          )}
          <p className="muted">
            Up to {bytes(info.maxBytes)} · Closes {until(info.expires)}
          </p>
        </div>
        {sent ? (
          <div className="guest-sent" role="status">
            <span className="guest-sent-icon">
              <CircleCheck size={28} aria-hidden />
            </span>
            <h2>Sent</h2>
            <p className="muted">
              {composition(delivered, 0, deliveredTexts)} · {bytes(deliveredBytes)} sent
              {info.owner && (
                <>
                  {" "}
                  to <UserText>{info.owner}</UserText>
                </>
              )}
              . You can close this page.
            </p>
            {full ? (
              <p className="muted">{full}</p>
            ) : (
              <Button
                onClick={() => {
                  setSeen((prev) => new Set([...prev, ...transfers.map((t) => t.id)]));
                }}
              >
                Send more
              </Button>
            )}
          </div>
        ) : full ? (
          <div className="guest-full" role="status">
            <p>{full}</p>
            <p className="muted">
              If you have more to send, ask {info.owner ? <UserText>{info.owner}</UserText> : "them"} for a new request
              link.
            </p>
          </div>
        ) : (
          <>
            <div className="composer guest-composer">
              <ContentBox
                items={items}
                text={text}
                textMax={LIMITS.textBytes}
                onFiles={(files) => add(files)}
                onRemove={(key) => setItems((current) => current.filter((item) => item.key !== key))}
                onClearFiles={() => {
                  const previous = items;
                  setItems([]);
                  return () => setItems((current) => [...previous, ...current]);
                }}
                onText={setText}
                textId="guest-text"
                showTextEvent={SHOW_TEXT}
                undoKey="guest-undo"
                fileInputTestId="guest-file-input"
              />
            </div>
            {renamed.length > 0 && (
              <ul className="guest-renames muted" aria-label="Renamed files">
                {renamed.slice(0, 5).map((r) => (
                  <li key={r.path}>
                    <UserText>{r.from}</UserText> will be saved as <UserText>{r.to}</UserText>
                  </li>
                ))}
                {renamed.length > 5 && <li>and {plural(renamed.length - 5, "more file")} renamed the same way</li>}
              </ul>
            )}
            {limitMessage && (
              <p className="field-error" role="alert">
                {limitMessage}
              </p>
            )}
            {ready && (
              <Field
                label="Your name (optional)"
                hint={`So ${shownText(info.owner) || "they"} can tell who sent this.`}
              >
                <input
                  className="input"
                  autoComplete="name"
                  maxLength={LIMITS.senderLength}
                  value={sender}
                  onChange={(e) => setSender(e.target.value)}
                />
              </Field>
            )}
            {ready && (
              <div className="row end">
                <Button
                  variant="primary"
                  icon={<Upload size={16} />}
                  disabled={!!limitMessage || busy}
                  onClick={upload}
                >
                  Send {sendLabel(items, count, hasText)}
                </Button>
              </div>
            )}
            {transfers.some((t) => t.status !== "done") && (
              <div className="transfer-list">
                {transfers
                  .filter((t) => t.status !== "done")
                  .map((t) => (
                    <TransferCard key={t.id} t={t} onOpen={() => {}} />
                  ))}
              </div>
            )}
          </>
        )}
      </div>
      {overlay}
    </PublicFrame>
  );
}
