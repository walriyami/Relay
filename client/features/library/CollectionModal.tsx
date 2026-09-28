import { useState } from "react";
import { Clock, Download, Link2, MoreHorizontal, Pencil, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { api, type ItemDetail, type Link } from "../../api";
import { ago, bytes, dateTime } from "../../lib/format";
import { ownerSource } from "../../lib/source";
import { useExpiryClock } from "../../lib/refresh";
import { useLive } from "../../lib/live";
import { useOnlineDevices, useSession } from "../../app/session";
import {
  addFilesTo,
  allFiles,
  composition,
  deleteItemForever,
  downloadItem,
  downloadLabel,
  ensureItemLink,
  errorToast,
  itemParts,
  hasDownloads,
  renameItem,
  restoreItem,
  sendItem,
  singleFile,
  trashItem,
} from "./actions";
import { KeepDialog } from "./dialogs";
import { ItemShareDialog } from "./ItemShareDialog";
import { ContentView, isSingleFile } from "../../components/ContentView";
import { Button, LoadFailed, Menu, Modal, Spinner, useCloseModal } from "../../components/ui";

/** The item's own address; opening it (after a reload, or from a shared URL) reopens this popup. */
export const itemAddress = (id: string, trash = false) => `${trash ? "/trash" : "/files"}/${encodeURIComponent(id)}`;

/**
 * The item window. What was sent is immutable, so the window only shows it: a lone file fills the
 * window as a large preview, anything else is a folder browser. Everything that can be done with
 * the item sits in the footer: how long it's kept, sending it on, sharing and downloading it. The
 * item itself can be renamed, and files can join it (not replace or leave it).
 */
export function CollectionModal({ id, onClose, url }: { id: string; onClose: () => void; url?: string }) {
  const {
    data: cached,
    loading,
    error,
    errorStatus,
    reload,
  } = useLive(api.items.get, { params: { id } }, ["items", "links"], null);
  // An authoritative denial invalidates cached content and its actions. Temporary outages keep
  // the preview available, with an explicit recovery path.
  const unavailable = errorStatus !== null && [401, 403, 404, 410].includes(errorStatus);
  const data = unavailable ? null : cached;
  const single = !!data && isSingleFile(data.nodes);
  return (
    <Modal
      size="xl"
      className={`item-window${single ? " is-single" : ""}`}
      url={url ?? itemAddress(id)}
      title={data ? data.name : error ? "Unavailable" : "Loading…"}
      subtitle={data ? summary(data) : undefined}
      onClose={onClose}
      footer={data ? data.trashed ? <TrashFooter c={data} /> : <ItemFooter c={data} /> : undefined}
    >
      {error && !unavailable && data && <LoadFailed error={error} onRetry={reload} banner />}
      {data?.uploading && (
        <p className="notice neutral" role="status">
          Wait for the uploads to finish before sharing or sending.
        </p>
      )}
      {data ? (
        <ContentView key={data.id} nodes={data.nodes} source={ownerSource} itemId={data.id} fill={single} />
      ) : unavailable ? (
        <p className="muted" role="status">
          {error || "This item is no longer available."}
        </p>
      ) : loading ? (
        <Spinner />
      ) : (
        <LoadFailed error={error || "This item could not be loaded."} onRetry={reload} />
      )}
    </Modal>
  );
}

function summary(c: ItemDetail) {
  const parts = [];
  if (itemParts(c) > 1 || c.topFolders) parts.push(composition(c.topFiles, c.topFolders, c.texts));
  if (c.files) parts.push(`${c.topFolders ? allFiles(c.files, c.topFiles) + " · " : ""}${bytes(c.bytes)}`);
  parts.push(`Added ${ago(c.created)}`);
  if (c.trashed && c.purgeAt !== null) parts.push(`Deleted forever on ${dateTime(c.purgeAt)}`);
  else if (c.firstSavedAt === null) parts.push("Clock starts with the first saved content");
  else if (c.expires) parts.push(`Moves to Trash ${dateTime(c.expires)}`);
  if (!c.trashed && c.hardExpires !== null) parts.push(`Deleted forever by ${dateTime(c.hardExpires)}`);
  return parts.join(" · ");
}

function ItemFooter({ c }: { c: ItemDetail }) {
  const close = useCloseModal();
  const devices = useOnlineDevices();
  const { me } = useSession();
  const [keeping, setKeeping] = useState(false);
  const [sharing, setSharing] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);
  async function share() {
    setBusy(true);
    try {
      setSharing(await ensureItemLink(c, me.prefs));
    } catch (error) {
      errorToast(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="modal-foot-start">
        <Menu
          label="More actions"
          size="md"
          align="start"
          trigger={
            <>
              <MoreHorizontal size={18} aria-hidden />
              <span>More</span>
            </>
          }
          items={[
            { label: "Rename…", icon: <Pencil size={16} />, onSelect: () => void renameItem(c).catch(errorToast) },
            { label: "Add files…", icon: <Plus size={16} />, onSelect: () => void addFilesTo(c).catch(errorToast) },
            { label: "Move to Trash after…", icon: <Clock size={16} />, onSelect: () => setKeeping(true) },
            ...(c.uploading ? [] : devices).map((device) => ({
              label: `Send to ${device.name}`,
              icon: <Send size={16} />,
              onSelect: () => void sendItem(c.id, device).catch(errorToast),
            })),
            {
              label: "Move to Trash",
              icon: <Trash2 size={16} />,
              danger: true,
              separator: true,
              onSelect: () => void trashItem(c).then(close).catch(errorToast),
            },
          ]}
        />
      </div>
      <Button icon={<Link2 size={16} />} busy={busy} disabled={c.uploading} onClick={() => void share()}>
        Share
      </Button>
      {hasDownloads(c) && (
        <Button variant="primary" icon={<Download size={16} />} onClick={() => void downloadItem(c).catch(errorToast)}>
          {downloadLabel(singleFile(c))}
        </Button>
      )}
      {keeping && <KeepDialog item={c} onClose={() => setKeeping(false)} />}
      {sharing && <ItemShareDialog share={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}

/** Trash is read-only: an item there can be looked at, restored or deleted for good. */
function TrashFooter({ c }: { c: ItemDetail }) {
  const close = useCloseModal();
  const [busy, setBusy] = useState("");
  const now = useExpiryClock([c.hardExpires ?? Infinity, c.purgeAt ?? Infinity]);
  const expired = Math.min(c.hardExpires ?? Infinity, c.purgeAt ?? Infinity) <= now;
  async function run(label: string, work: () => Promise<unknown>) {
    setBusy(label);
    try {
      await work();
    } catch (error) {
      errorToast(error);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="modal-foot-start">
        <Button
          variant="danger"
          icon={<Trash2 size={16} />}
          busy={busy === "delete"}
          onClick={() => void run("delete", async () => (await deleteItemForever(c)) && close())}
        >
          Delete forever
        </Button>
      </div>
      <Button
        variant="primary"
        icon={<RotateCcw size={16} />}
        busy={busy === "restore"}
        disabled={expired}
        onClick={() => void run("restore", () => restoreItem(c).then(close))}
      >
        Restore
      </Button>
    </>
  );
}
