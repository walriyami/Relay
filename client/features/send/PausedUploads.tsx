import { useRef, useState } from "react";
import { History } from "lucide-react";
import type { PausedTransfer } from "../../../shared/model";
import { Button, confirmDialog } from "../../components/ui";
import { bytes, plural, until } from "../../lib/format";
import { continueUpload, discardPaused, match, usePaused, type Match } from "../../lib/paused";
import { UserText } from "../../components/UserText";

/**
 * Uploads an earlier page left unfinished (a reload, a closed tab, a phone that slept), each offered
 * back: choosing the same files again sends only what is missing.
 */
export function PausedUploads({ onView }: { onView: (itemId: string) => void }) {
  const paused = usePaused();
  if (!paused.length) return null;
  return (
    <>
      {paused.map((p) => (
        <PausedUpload key={p.id} p={p} onView={onView} />
      ))}
    </>
  );
}

function PausedUpload({ p, onView }: { p: PausedTransfer; onView: (itemId: string) => void }) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<Match | null>(null);
  const unfinished = p.files.filter((f) => !f.done);
  const done = p.files.length - unfinished.length;
  const total = p.files.reduce((n, f) => n + f.size, 0);
  const held = p.files.reduce((n, f) => n + f.offset, 0);
  const folders = !p.adding && unfinished.some((f) => f.path.includes("/"));
  const kept = p.adding || done > 0 || p.text;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message || "That didn’t work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const chosen = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    void run(async () => {
      const result = await match(p, files, found?.chosen);
      if (!result.missing.length) await continueUpload(p, result.chosen);
      else setFound(result);
    });
  };
  const stop = async () => {
    const ok = await confirmDialog({
      title: `Stop uploading ${p.name}?`,
      body: `${plural(unfinished.length, "unfinished file")} will be removed.${kept ? " What already finished stays in Files." : ""}`,
      confirm: "Stop upload",
      cancel: "Keep it",
      danger: true,
    });
    if (ok) void run(() => discardPaused(p));
  };

  const names = (list: string[]) =>
    list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
  const canSkip = !!found && (found.chosen.size > 0 || done > 0 || p.text);
  return (
    <div className="stopped-notice" role="status" aria-busy={busy || undefined}>
      <History size={18} aria-hidden />
      <div>
        <strong>
          <UserText>{p.name}</UserText> is paused
        </strong>
        {found ? (
          <p className="muted">
            {`Found ${found.chosen.size} of ${unfinished.length}. Not found: ${names(found.missing.map((f) => f.path.slice(f.path.lastIndexOf("/") + 1)))}.`}
            {found.different.length > 0 &&
              ` ${names(found.different)} ${found.different.length === 1 ? "isn’t" : "aren’t"} the same as the one being uploaded.`}
          </p>
        ) : (
          <p className="muted">
            {p.files.length === 1
              ? `${bytes(held)} of ${bytes(total)} uploaded. `
              : `${done} of ${p.files.length} files uploaded · ${bytes(held)} of ${bytes(total)}. `}
            Choose the same {unfinished.length === 1 ? "file" : "files"} again to finish; what’s uploaded won’t be sent
            again. Unfinished files are removed {until(p.keptUntil)}.
          </p>
        )}
        {error && <p className="transfer-note error">{error}</p>}
        <div className="stopped-notice-actions">
          <Button size="sm" variant="primary" busy={busy} onClick={() => filesInput.current?.click()}>
            {found ? "Choose more" : "Choose files"}
          </Button>
          {folders && (
            <Button size="sm" disabled={busy} onClick={() => folderInput.current?.click()}>
              Choose folder
            </Button>
          )}
          {found && canSkip && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  continueUpload(
                    p,
                    found.chosen,
                    found.missing.map((f) => f.upload),
                  ),
                )
              }
            >
              Continue without them
            </Button>
          )}
          {kept && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onView(p.itemId)}>
              View in Files
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>
            Stop upload
          </Button>
        </div>
      </div>
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          chosen(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          chosen(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
