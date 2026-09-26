import { useEffect, useId, useMemo, useState } from "react";
import { Download, LockKeyhole } from "lucide-react";
import { ApiError, LINK_USED_UP, api, call, type LockedShare, type Node, type PublicShare } from "../../api";
import { bytes, plural, until } from "../../lib/format";
import { shareSource } from "../../lib/source";
import { ContentView, downloadContents, filesOf, isSingleFile } from "../../components/ContentView";
import { Button } from "../../components/ui";

export const SHARE_GONE = "This link has expired or was turned off.";

/**
 * A link's share as its page loads it. A link with a password first comes back `locked`, saying only
 * who shared it; `unlock` then opens it here, and the browser stays unlocked for later visits.
 */
export function useShare(token: string) {
  const [state, setState] = useState<{ data?: PublicShare; locked?: LockedShare; error?: string; canRetry?: boolean }>(
    {},
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!token) return;
    let live = true;
    setState({});
    call(api.links.open, { params: { token } })
      .then((open) => live && setState(open.locked ? { locked: open } : { data: open }))
      .catch(
        (error: Error) =>
          live &&
          setState({
            // A link that let in everyone it was for says so; any other 404 or 410 is a link that's gone.
            error:
              error instanceof ApiError && [404, 410].includes(error.status) && error.message !== LINK_USED_UP
                ? SHARE_GONE
                : error.message,
            canRetry: !(error instanceof ApiError && [401, 403, 404, 410].includes(error.status)),
          }),
      );
    return () => {
      live = false;
    };
  }, [token, attempt]);
  const unlock = async (password: string) => {
    const data = await call(api.links.unlock, { params: { token }, body: { password } });
    setState({ data });
  };
  return { ...state, unlock, retry: () => setAttempt((value) => value + 1) };
}

/** The password a locked link asks for before it shows anything. */
export function ShareUnlock({
  locked,
  onUnlock,
  autoFocus = true,
}: {
  locked: LockedShare;
  onUnlock: (password: string) => Promise<void>;
  autoFocus?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  return (
    <form
      className="share-unlock"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!password) return setError("Enter the password.");
        setBusy(true);
        try {
          await onUnlock(password);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <span className="share-unlock-icon" aria-hidden>
        <LockKeyhole size={20} />
      </span>
      <p>
        <strong>{locked.from}</strong> shared this with a password.
      </p>
      <div className="share-unlock-row">
        <input
          className="input"
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="off"
          autoFocus={autoFocus}
          value={password}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setPassword(e.target.value);
            setError("");
          }}
        />
        <Button variant="primary" type="submit" busy={busy}>
          Open
        </Button>
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Who shared it, and what they wrote: quiet, above the contents. */
export function ShareNote({ share }: { share: PublicShare }) {
  if (!share.note) return null;
  return (
    <figure className="share-note">
      <blockquote>{share.note}</blockquote>
      <figcaption className="muted">{share.from}</figcaption>
    </figure>
  );
}

/**
 * "3 files · 2 MB · Expires in 6 days". The size is the files' alone, so it matches the Download
 * button; text is shown inline and isn't downloaded.
 */
export function contentSummary(c: { nodes: Node[]; expires: number | null }) {
  const files = filesOf(c.nodes);
  const parts = [];
  if (files.length) parts.push(`${plural(files.length, "file")} · ${bytes(files.reduce((n, f) => n + f.size, 0))}`);
  if (c.expires) parts.push(`Expires ${until(c.expires)}`);
  return parts.join(" · ");
}
/** "From Sara · 3 files · 2 MB · Expires in 6 days". */
export const shareSummary = (share: PublicShare) =>
  [`From ${share.from}`, contentSummary(share)].filter(Boolean).join(" · ");

/** "Download" for a lone file, "Download all" for anything that arrives as a ZIP. */
export const downloadAllLabel = (nodes: Node[]) => (isSingleFile(nodes) ? "Download" : "Download all");

/** Downloads a link's contents; a link's source already knows its item. */
export const downloadShare = (token: string, share: PublicShare) =>
  downloadContents(shareSource(token), share.nodes, "");

/** A public link's contents on its own page: one Download for everything, then the contents. */
export function ShareView({ token, share }: { token: string; share: PublicShare }) {
  const source = useMemo(() => shareSource(token), [token]);
  const hasDownloads = share.nodes.some((n) => n.kind !== "text");
  return (
    <div className="stack">
      <ShareNote share={share} />
      {hasDownloads && (
        <div className="action-bar">
          <Button variant="primary" icon={<Download size={16} />} onClick={() => downloadShare(token, share)}>
            {downloadAllLabel(share.nodes)}
          </Button>
        </div>
      )}
      <ContentView nodes={share.nodes} source={source} itemId="" />
    </div>
  );
}
