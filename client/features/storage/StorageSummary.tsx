// Settings → Storage: how much of their space a member uses, what takes the most, what Trash still
// holds (with a one-tap way to free it), and a way to take everything with them as one ZIP.
import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { api, call, urls, type Me } from "../../api";
import { bytes, percent, plural } from "../../lib/format";
import { notifyChange, useLive } from "../../lib/live";
import { download } from "../../lib/download";
import { timeZone } from "../../lib/source";
import { StorageMeter } from "../../components/StorageMeter";
import { Button, LoadFailed, PageLink, confirmDialog, toast } from "../../components/ui";
import { UserText } from "../../components/UserText";

export function StorageSummary({ me }: { me: Me }) {
  // Every upload, deletion and Trash change moves these numbers.
  const { data, error, reload } = useLive(api.storage, {}, ["items", "account"], null);
  const [emptying, setEmptying] = useState(false);
  const [exporting, setExporting] = useState(false);

  // A refused download would land as a broken file with no reason, so ask the server first.
  async function exportAll() {
    setExporting(true);
    try {
      const url = urls.exportZip(timeZone());
      const response = await fetch(url, { method: "HEAD", credentials: "same-origin" });
      if (response.ok) return download(url);
      toast(
        response.status === 413
          ? "Your notes are too large for one ZIP. Download items one at a time from Files."
          : response.status === 503
            ? "Relay is busy preparing other downloads. Try again in a moment."
            : "The ZIP couldn’t be prepared. Try again in a moment.",
        { tone: "error" },
      );
    } catch {
      toast("Relay couldn’t be reached. Check your connection and try again.", { tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  async function emptyTrash(items: number) {
    if (
      !(await confirmDialog({
        title: "Empty Trash?",
        body: `${plural(items, "item")} will be deleted forever. This can’t be undone.`,
        confirm: "Empty Trash",
        danger: true,
      }))
    )
      return;
    setEmptying(true);
    try {
      const { removed } = await call(api.items.emptyTrash);
      toast(`Trash emptied · ${plural(removed, "item")} deleted`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setEmptying(false);
      notifyChange("items");
    }
  }

  // Each bar is that item's share of everything the member keeps, so the list shows what's worth clearing.
  const total = Math.max(1, (data?.used ?? 0) + (data?.reserved ?? 0));
  return (
    <div className="storage-summary stack">
      <StorageMeter me={me} />
      {error && <LoadFailed banner error={error} onRetry={reload} />}
      {!data ? (
        !error && <div className="storage-summary-skeleton skeleton waiting" aria-hidden />
      ) : (
        <>
          <div className="setting-row">
            <span className="setting-label">
              <strong>Trash</strong>
              <span className="field-hint">
                {data.trash.items
                  ? `${plural(data.trash.items, "item")} · ${bytes(data.trash.bytes)}. Items in Trash still use your space until they’re deleted.`
                  : "Trash is empty."}{" "}
                {data.trash.items > 0 && <PageLink to="/trash">Open Trash</PageLink>}
              </span>
            </span>
            {data.trash.items > 0 && (
              <Button
                className="danger-text"
                icon={<Trash2 size={16} />}
                busy={emptying}
                onClick={() => void emptyTrash(data.trash.items)}
              >
                Empty Trash
              </Button>
            )}
          </div>
          {data.largest.length > 0 && (
            <div className="storage-largest">
              <h3 id="storage-largest">Largest in Files</h3>
              <ol aria-labelledby="storage-largest">
                {data.largest.map((item) => (
                  <li key={item.id}>
                    <PageLink to={`/files/${item.id}`} className="storage-largest-link">
                      <span className="storage-largest-name">
                        <UserText>{item.name}</UserText>
                      </span>
                      <span className="storage-largest-size">
                        {bytes(item.bytes)} · {percent(item.bytes, total)}
                      </span>
                      <span className="storage-largest-bar" aria-hidden>
                        <span style={{ width: `${Math.min(100, (item.bytes / total) * 100)}%` }} />
                      </span>
                    </PageLink>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="setting-row">
            <span className="setting-label">
              <strong>Download all my files</strong>
              <span className="field-hint">
                {data.items
                  ? `One ZIP of the ${plural(data.items, "item")} in Files, not Trash. Large libraries take a while to download.`
                  : "Nothing in Files yet."}
              </span>
            </span>
            <Button
              icon={<Download size={16} />}
              disabled={!data.items}
              busy={exporting}
              onClick={() => void exportAll()}
            >
              Download ZIP
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
