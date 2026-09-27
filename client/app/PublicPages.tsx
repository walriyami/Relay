import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleCheck, FilePlus2, FolderPlus, Upload, X } from "lucide-react";
import { ApiError, api, call, type PublicRequest, type PublicShare } from "../api";
import { LIMITS } from "../../shared/model";
import { collectDroppedSelection, dragHasFiles, skippedNotice } from "../drop-selection";
import { autoName, baseName, bytes, plural, until } from "../lib/format";
import { startTransfer, isBusy, uniquePaths, type DraftFile, type Transfer } from "../lib/transfers";
import {
  fromFileList,
  normalizeSelection,
  type PickedDraftFile,
  type PickedFolder,
  type SelectionRename,
} from "../lib/draft";
import { navigate } from "../lib/router";
import { Button, Field, IconButton, Spinner, toast } from "../components/ui";
import { FileTypeIcon } from "../components/Thumbnail";
import { DocumentArt } from "../components/DocumentArt";
import { SHARE_GONE, ShareUnlock, ShareView, shareSummary, useShare } from "../features/incoming/ReceiveView";
import { CodeEntryForm, codeDigits } from "../features/codes/CodeEntry";
import { browserName } from "../features/auth/device-name";
import { AuthFrame } from "../features/auth/Auth";
import { TransferCard, useTransfers } from "../features/send/TransferList";
import { Brand } from "./Brand";

type Width = "narrow" | "medium" | "wide";

function PublicFrame({ children, width = "medium" }: { children: ReactNode; width?: Width }) {
  return (
    <div className="public">
      <header className={`public-head ${width}`}>
        <Brand />
      </header>
      <main className={`public-main ${width}`} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

const hasFiles = (share: PublicShare) => share.nodes.some((n) => n.kind !== "text");
// A text-only share named after its own first line would just repeat the text box.
function shareTitle(share: PublicShare) {
  if (hasFiles(share)) return share.name;
  const text = share.nodes.find((n) => n.kind === "text")?.text || "";
  return share.name === autoName([], text) || share.name === "Text" ? "Shared text" : share.name;
}

function Unavailable({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card-surface public-card">
      <div className="public-title">
        <h1>{title}</h1>
        <p className="muted">{children}</p>
      </div>
      {action}
    </div>
  );
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
                Have a pickup code?
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
        <Spinner />
      ) : (
        <div className="card-surface public-card">
          <div className="public-title">
            <h1>{shareTitle(data)}</h1>
            <p className="muted">{shareSummary(data)}</p>
          </div>
          <ShareView token={token} share={data} />
        </div>
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
      <AuthFrame title="Use a code" subtitle="Enter any Relay code to open its destination.">
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
              await call(api.session.code, { body: { code: codeDigits(code), deviceName: browserName() } });
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
        <Spinner />
      ) : (
        <div className="card-surface public-card">
          <div className="between">
            <div className="public-title">
              <h1>{shareTitle(data)}</h1>
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

type Pick = {
  key: string;
  files: DraftFile[];
  folders: string[];
  name: string;
  size: number;
  folder: boolean;
  renames: Omit<SelectionRename, "itemKey">[];
};

// The server compares names the way SQLite's NOCASE does: ASCII letters only.
const foldCase = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** The server's rule for a name already taken at the top of a submission: "a (2).txt", "Photos (2)". */
function freeName(name: string, taken: Set<string>, file: boolean) {
  if (!taken.has(foldCase(name))) return name;
  const dot = file ? name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
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
function renames(picks: Pick[], earlier: Transfer[]) {
  const taken = new Set<string>();
  for (const t of earlier)
    place(
      t.tasks.filter((task) => task.status !== "skipped"),
      t.folders,
      taken,
    );
  const files = picks.flatMap((p) => p.files);
  const sent = uniquePaths(files);
  const result = picks.flatMap((pick) =>
    pick.renames.map((rename) => {
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
  for (const r of place(
    sent,
    picks.flatMap((p) => p.folders),
    taken,
  ))
    result.push({ ...r, path: r.from });
  return result;
}

/**
 * Why the current picks don't fit the request, saying what to remove; null when they fit. A request
 * with no room at all is shown as full instead (see `fullMessage`).
 */
function limitProblem(info: PublicRequest, size: number) {
  if (size <= info.remainingBytes) return null;
  return `${
    info.remainingBytes < info.maxBytes
      ? `This request has room for ${bytes(info.remainingBytes)} more`
      : `This request accepts up to ${bytes(info.maxBytes)}`
  }. Remove ${bytes(size - info.remainingBytes)} to continue.`;
}

/** "This request is full. admin has received the 2 GB it allows." Null while there is room. */
function fullMessage(info: PublicRequest) {
  if (!info.full) return null;
  const who = info.owner || "The person who asked";
  return info.remainingBytes === 0
    ? `This request is full. ${who} has received the ${bytes(info.maxBytes)} it allows.`
    : `This request is full. ${who} can’t receive more files with it.`;
}

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

// Someone asked for files. The guest picks them, reviews the list, then presses Upload.
export function GuestUpload({ token }: { token: string }) {
  const [info, setInfo] = useState<PublicRequest | null>(null);
  const [error, setError] = useState("");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [dragging, setDragging] = useState(false);
  // Files found so far while a dropped folder is read; null when not reading.
  const [reading, setReading] = useState<number | null>(null);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [sender, setSender] = useState("");
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
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
    setPicks((current) => {
      const normalized = normalizeSelection(
        files,
        folders,
        current.map((pick) => pick.name),
      );
      const renamedByItem = new Map<string, Omit<SelectionRename, "itemKey">[]>();
      for (const rename of normalized.renames) {
        const entries = renamedByItem.get(rename.itemKey) ?? [];
        entries.push(rename);
        renamedByItem.set(rename.itemKey, entries);
      }
      const next = normalized.items.map((item): Pick => ({
        key: item.key,
        name: item.name,
        size: item.size,
        files: item.kind === "file" ? [{ file: item.file, path: item.path }] : item.files,
        folders: item.kind === "file" ? [] : item.folders,
        folder: item.kind === "folder",
        renames: renamedByItem.get(item.key) ?? [],
      }));
      return [...current, ...next];
    });
  }
  const count = picks.reduce((n, p) => n + p.files.length, 0);
  const size = picks.reduce((n, p) => n + p.size, 0);
  const limitMessage = info && limitProblem(info, size);
  const busy = transfers.some(isBusy);
  const done = transfers.filter((t) => t.status === "done");
  const full = info && !busy ? fullMessage(info) : null;
  const sent = !busy && done.length > 0 && (!picks.length || !!full);
  // Earlier uploads from this page, oldest first: their names are already taken in the submission.
  const renamed = useMemo(
    () => renames(picks, all.filter((t) => t.status === "done").reverse()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when a transfer's status changes, not on every progress tick.
    [picks, all.map((t) => `${t.id}:${t.status}`).join()],
  );
  // Dropping anywhere on the page adds to the list, so a near miss never opens the file in place of
  // this page. While the request is full or just answered, drops are refused rather than lost.
  const accepting = useRef(false);
  accepting.current = !!info && !sent && !full;
  const addDropped = useRef(add);
  addDropped.current = add;
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(accepting.current);
    };
    const over = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = accepting.current ? "copy" : "none";
    };
    const leave = (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = async (event: DragEvent) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (!accepting.current) return;
      setReading(0);
      const selection = await collectDroppedSelection(event.dataTransfer!.items, setReading);
      setReading(null);
      addDropped.current(selection.files, selection.folders);
      if (selection.skipped) toast(skippedNotice(selection.skipped), { tone: "error" });
    };
    const onDrop = (event: DragEvent) => void drop(event);
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
  function upload() {
    if (!info || !count) return;
    startTransfer({
      files: picks.flatMap((p) => p.files),
      folders: picks.flatMap((p) => p.folders),
      text: "",
      name: null,
      destination: { kind: "guest" },
      guest: token,
      sender: sender.trim() || undefined,
    });
    setPicks([]);
  }
  if (error)
    return (
      <PublicFrame width="narrow">
        <Unavailable
          title="Request unavailable"
          action={<Button onClick={() => setLooked((n) => n + 1)}>Try again</Button>}
        >
          {error === "gone"
            ? "This request has closed or was removed. Ask the person who sent it for a new link."
            : error}
        </Unavailable>
      </PublicFrame>
    );
  if (!info)
    return (
      <PublicFrame>
        <Spinner />
      </PublicFrame>
    );
  const pickers = (
    <>
      <input
        ref={filesInput}
        data-testid="guest-file-input"
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add(fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          if (e.target.files) add(fromFileList(e.target.files, true));
          e.target.value = "";
        }}
      />
    </>
  );
  const addButtons = (size: "sm" | "md") => (
    <>
      <Button
        size={size}
        variant={size === "sm" ? "ghost" : "secondary"}
        icon={<FilePlus2 size={16} />}
        onClick={() => filesInput.current?.click()}
      >
        Add files
      </Button>
      {/* Phones have no folder picker worth offering, as on the Send page. */}
      {!coarse() && (
        <Button
          size={size}
          variant={size === "sm" ? "ghost" : "secondary"}
          icon={<FolderPlus size={16} />}
          onClick={() => folderInput.current?.click()}
        >
          Add folder
        </Button>
      )}
    </>
  );
  const delivered = done.reduce((n, t) => n + t.doneFiles, 0);
  const deliveredBytes = done.reduce((n, t) => n + t.totalBytes, 0);
  return (
    <PublicFrame>
      <div className="card-surface public-card">
        <div className="public-title">
          {info.owner && <p className="request-owner">{info.owner} is asking for files</p>}
          <h1>{info.name}</h1>
          {info.description && <p className="request-description">{info.description}</p>}
          <p className="muted">
            Up to {bytes(info.maxBytes)} · Closes {until(info.expires)}
          </p>
        </div>
        {sent ? (
          <div className="guest-sent" role="status">
            <span className="guest-sent-icon">
              <CircleCheck size={28} aria-hidden />
            </span>
            <h2>Files sent</h2>
            <p className="muted">
              {plural(delivered, "file")} · {bytes(deliveredBytes)} uploaded{info.owner ? ` for ${info.owner}` : ""}.
              You can close this page.
            </p>
            {full ? (
              <p className="muted">{full}</p>
            ) : (
              <Button
                onClick={() => {
                  setSeen((prev) => new Set([...prev, ...transfers.map((t) => t.id)]));
                }}
              >
                Send more files
              </Button>
            )}
          </div>
        ) : full ? (
          <div className="guest-full" role="status">
            <p>{full}</p>
            <p className="muted">If you have more to send, ask {info.owner || "them"} for a new request link.</p>
          </div>
        ) : (
          <>
            {picks.length > 0 || busy ? (
              <div className={`guest-add ${dragging ? "dragging" : ""}`}>
                {reading !== null ? (
                  <span className="muted" role="status">
                    {reading ? `Reading… ${plural(reading, "file")} so far` : "Reading what you dropped…"}
                  </span>
                ) : picks.length > 0 ? (
                  <strong>
                    {plural(count, "file")}
                    <span className="muted"> · {bytes(size)}</span>
                  </strong>
                ) : (
                  <span className="muted">Add more while this uploads</span>
                )}
                <span className="row">{addButtons("sm")}</span>
                {pickers}
              </div>
            ) : (
              <div className={`dropzone ${dragging ? "dragging" : ""}`}>
                <DocumentArt />
                <div role={reading === null ? undefined : "status"}>
                  <strong>
                    {reading !== null
                      ? "Reading what you dropped…"
                      : dragging
                        ? "Drop to add"
                        : coarse()
                          ? "Choose files to send"
                          : "Drop files or folders here"}
                  </strong>
                  <span>
                    {reading
                      ? `${plural(reading, "file")} found so far`
                      : "You’ll see the list before anything uploads."}
                  </span>
                </div>
                <div className="row center">{addButtons("md")}</div>
                {pickers}
              </div>
            )}
            {picks.length > 0 && (
              <ul className="selection-list">
                {picks.map((p) => (
                  <li key={p.key} className="selection-row">
                    <div className={`thumb thumb-compact ${p.folder ? "thumb-folder" : ""}`}>
                      <div className="thumb-icon">
                        <FileTypeIcon path={p.name} kind={p.folder ? "folder" : "file"} size={20} />
                      </div>
                    </div>
                    <div className="selection-text">
                      <span className="selection-name" title={p.name}>
                        {p.name}
                      </span>
                      <span className="muted">
                        {p.folder ? `Folder · ${plural(p.files.length, "file")} · ` : ""}
                        {bytes(p.size)}
                      </span>
                    </div>
                    <IconButton
                      size="sm"
                      label={`Remove ${p.name}`}
                      icon={<X size={16} />}
                      onClick={() => setPicks((all) => all.filter((x) => x.key !== p.key))}
                    />
                  </li>
                ))}
              </ul>
            )}
            {renamed.length > 0 && (
              <ul className="guest-renames muted" aria-label="Renamed files">
                {renamed.slice(0, 5).map((r) => (
                  <li key={r.path}>
                    {r.from} will be saved as {r.to}
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
            {picks.length > 0 && (
              <Field label="Your name (optional)" hint={`So ${info.owner || "they"} can tell who sent these.`}>
                <input
                  className="input"
                  autoComplete="name"
                  maxLength={LIMITS.senderLength}
                  value={sender}
                  onChange={(e) => setSender(e.target.value)}
                />
              </Field>
            )}
            {picks.length > 0 && (
              <div className="row end">
                <Button
                  variant="primary"
                  icon={<Upload size={16} />}
                  disabled={!count || !!limitMessage || busy}
                  onClick={upload}
                >
                  Upload {plural(count, "file")}
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
    </PublicFrame>
  );
}
