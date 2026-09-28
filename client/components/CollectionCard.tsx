import { useState, useSyncExternalStore } from "react";
import {
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Inbox,
  Layers,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import type { ItemSummary, Link, SearchMatch } from "../api";
import { ago, bytes } from "../lib/format";
import { isOnline } from "../lib/connection";
import { ownerSource } from "../lib/source";
import { snapshot, subscribe, transferFor, type Transfer } from "../lib/transfers";
import { useOnlineDevices, useSession } from "../app/session";
import { DeviceIcon } from "../app/devices";
import {
  addFilesTo,
  copyItemText,
  deleteItemForever,
  downloadItem,
  downloadLabel,
  errorToast,
  itemMeta,
  hasDownloads,
  itemParts,
  loadItem,
  renameItem,
  restoreItem,
  sendItem,
  ensureItemLink,
  singleFile,
  trashItem,
} from "../features/library/actions";
import { KeepDialog } from "../features/library/dialogs";
import { ItemShareDialog } from "../features/library/ItemShareDialog";
import { Thumbnail } from "./Thumbnail";
import { Menu, type MenuItem } from "./ui";

/** "Gone in 12 days": Trash keeps items for the owner's chosen number of days. */
function trashLeft(purgeAt: number) {
  const days = Math.ceil((purgeAt - Date.now()) / 86400000);
  const text = days <= 0 ? "Gone today" : days === 1 ? "Gone in 1 day" : `Gone in ${days} days`;
  return { text, soon: days < 3 };
}

const noSubscribe = () => () => {};
const noSnapshot = () => 0;

/** The upload running in this tab for an item, kept current as it moves; undefined otherwise. */
function useLocalTransfer(item: ItemSummary) {
  const watch = item.uploading;
  useSyncExternalStore(watch ? subscribe : noSubscribe, watch ? snapshot : noSnapshot);
  return watch ? transferFor(item.id) : undefined;
}

/** "Uploading · 4%" for an upload in this tab, which knows how far along it is. */
function uploadState(t: Transfer) {
  const pct = t.totalBytes ? Math.floor((t.sentBytes / t.totalBytes) * 100) : 0;
  const state =
    t.status === "paused"
      ? "Paused"
      : t.status === "attention"
        ? "Needs attention"
        : !isOnline()
          ? "Paused"
          : "Uploading";
  return { pct, text: `${state} · ${pct}%` };
}

/** Search words marked inside `text`, matched as the search does: ignoring case. */
function Marked({ text, query }: { text: string; query?: string }) {
  const words = (query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

/** Why a search found this item, when its name alone doesn't say. */
function MatchLine({ match, query }: { match: SearchMatch; query?: string }) {
  return match.in === "text" ? (
    <span className="card-meta card-match card-match-text" title={match.text}>
      <Marked text={match.text} query={query} />
    </span>
  ) : (
    <span className="card-meta card-match" title={match.text}>
      Contains <Marked text={match.text} query={query} />
    </span>
  );
}

export function CollectionCard({
  item: listed,
  onOpen,
  trash = false,
  query,
  selecting = false,
  selected = false,
  onToggle,
  selectionDisabled = false,
}: {
  item: ItemSummary & { match?: SearchMatch };
  onOpen: () => void;
  trash?: boolean;
  /** The search that found it, to mark in what matched. */
  query?: string;
  /** While choosing items for one action, the card is a switch: clicking it picks it. */
  selecting?: boolean;
  selected?: boolean;
  /** `range` picks everything since the last card picked (Shift-click). */
  onToggle?: (range: boolean) => void;
  selectionDisabled?: boolean;
}) {
  // While this tab uploads it, the card describes the whole transfer rather than the part that has
  // arrived, so its name and counts don't grow file by file. Files added to an item already there
  // only move the progress; its name and counts stay what they are until the files arrive.
  const found = useLocalTransfer(listed);
  const local = found && !trash ? found : undefined;
  const item: ItemSummary =
    local && !local.adding
      ? {
          ...listed,
          name: local.name,
          topFiles: local.parts.files,
          topFolders: local.parts.folders,
          texts: local.text.trim() ? 1 : 0,
          files: local.tasks.length,
        }
      : listed;
  const progress = local ? uploadState(local) : null;
  const parts = itemParts(item);
  // Another tab, device or a guest is uploading it, and nothing has arrived yet.
  const arriving = item.uploading && !local && !parts;
  const meta = arriving
    ? item.requestId
      ? "A guest is uploading"
      : "Uploading from another tab or device"
    : itemMeta(item);
  const left = trash && item.purgeAt !== null ? trashLeft(item.purgeAt) : null;
  // Still uploading: say so, so nobody shares half of it by mistake.
  const detail = progress
    ? progress.text
    : item.uploading && !trash
      ? `Uploading · started ${ago(item.created)}`
      : [item.files ? bytes(item.bytes) : "", left ? left.text : ago(item.created)].filter(Boolean).join(" · ");
  // A lone folder shows as a folder, not as whichever file happens to be first inside it.
  const onlyFolder = item.topFolders === 1 && !item.topFiles && !item.texts;
  const preview = item.preview;
  return (
    <div
      className={`card collection-card${trash ? " is-trash" : ""}${selecting ? " is-selecting" : ""}${selecting && selected ? " is-selected" : ""}`}
    >
      <button
        type="button"
        className="card-open"
        onClick={(event) => (selecting ? onToggle?.(event.shiftKey) : onOpen())}
        aria-pressed={selecting ? selected : undefined}
        disabled={selecting && selectionDisabled}
        aria-label={[
          item.name,
          meta,
          detail,
          item.requestId && "Received through a request",
          listed.match && (listed.match.in === "text" ? `Text: ${listed.match.text}` : `Contains ${listed.match.text}`),
        ]
          .filter(Boolean)
          .join(". ")}
        title={selecting ? undefined : item.name}
      >
        <div className={`card-media${parts > 1 ? " is-stack" : ""}`}>
          {selecting && (
            <span className="card-check" aria-hidden>
              <Check size={14} strokeWidth={3} />
            </span>
          )}
          {item.mosaic.length > 1 ? (
            <div className={`mosaic mosaic-${Math.min(item.mosaic.length, 4)}`}>
              {item.mosaic.slice(0, 4).map((n) => (
                <Thumbnail key={n.id} compact source={ownerSource} entry={n} />
              ))}
            </div>
          ) : preview && !onlyFolder ? (
            // A text item previews as a short, bounded excerpt, as the product contract describes.
            <Thumbnail
              source={ownerSource}
              entry={preview.kind === "text" ? { ...preview, text: item.textExcerpt } : preview}
            />
          ) : item.uploading && !onlyFolder ? (
            <div className="thumb thumb-uploading" aria-hidden>
              <div className="thumb-icon">
                <Upload size={28} />
              </div>
            </div>
          ) : (
            <Thumbnail entry={{ path: item.name, kind: "folder" }} />
          )}
          {progress && (
            <span className="card-progress" aria-hidden>
              <span style={{ width: `${Math.max(progress.pct, 3)}%` }} />
            </span>
          )}
          {((item.linked && !trash) || parts > 1 || item.requestId) && (
            <span className="card-badges">
              {item.requestId && (
                <span className="card-badge" title="Received through a request">
                  <Inbox size={13} aria-hidden />
                </span>
              )}
              {item.linked && !trash && (
                <span className="card-badge card-badge-link" title="Has an active link">
                  <Link2 size={13} aria-label="Has an active link" />
                </span>
              )}
              {parts > 1 && (
                <span className="card-badge" title={meta}>
                  <Layers size={12} aria-hidden /> {parts}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="card-body">
          <span className="card-title">{item.name}</span>
          <span className="card-meta">{meta}</span>
          <span className={`card-meta${left?.soon ? " danger" : ""}`}>{detail}</span>
          {listed.match && <MatchLine match={listed.match} query={query} />}
        </div>
      </button>
      {!selecting && (
        <div className="card-menu">
          <CardMenu item={item} trash={trash} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

function CardMenu({ item, trash, onOpen }: { item: ItemSummary; trash: boolean; onOpen: () => void }) {
  const { me } = useSession();
  const devices = useOnlineDevices();
  const [keeping, setKeeping] = useState(false);
  const [sharing, setSharing] = useState<Link | null>(null);
  const run = (work: () => Promise<unknown>) => () => void work().catch(errorToast);
  const items: MenuItem[] =
    item.uploading && !trash
      ? [{ label: "Open", icon: <ExternalLink size={16} />, onSelect: onOpen }]
      : trash
        ? [
            ...(Math.min(item.hardExpires ?? Infinity, item.purgeAt ?? Infinity) > Date.now()
              ? [{ label: "Restore", icon: <RotateCcw size={16} />, onSelect: run(() => restoreItem(item)) }]
              : []),
            {
              label: "Delete forever",
              icon: <Trash2 size={16} />,
              danger: true,
              separator: true,
              onSelect: run(() => deleteItemForever(item)),
            },
          ]
        : [
            { label: "Open", icon: <ExternalLink size={16} />, onSelect: onOpen },
            ...(hasDownloads(item)
              ? [
                  {
                    label: downloadLabel(singleFile(item)),
                    icon: <Download size={16} />,
                    onSelect: run(() => downloadItem(item)),
                  },
                ]
              : []),
            ...(item.texts
              ? [
                  {
                    label: "Copy text",
                    icon: <Copy size={16} />,
                    onSelect: run(async () => copyItemText(await loadItem(item.id))),
                  },
                ]
              : []),
            {
              label: "Share",
              icon: <Link2 size={16} />,
              onSelect: run(async () => {
                setSharing(await ensureItemLink(item, me.prefs));
              }),
            },
            ...devices.map((d) => ({
              label: `Send to ${d.name}`,
              icon: <DeviceIcon device={d} size={16} />,
              onSelect: run(() => sendItem(item.id, d)),
            })),
            { label: "Rename…", icon: <Pencil size={16} />, separator: true, onSelect: run(() => renameItem(item)) },
            { label: "Add files…", icon: <Plus size={16} />, onSelect: run(() => addFilesTo(item)) },
            { label: "Move to Trash after…", icon: <Clock size={16} />, onSelect: () => setKeeping(true) },
            {
              label: "Move to Trash",
              icon: <Trash2 size={16} />,
              danger: true,
              separator: true,
              onSelect: run(() => trashItem(item)),
            },
          ];
  return (
    <>
      <Menu label={`Actions for ${item.name}`} items={items} />
      {keeping && <KeepDialog item={item} onClose={() => setKeeping(false)} />}
      {sharing && <ItemShareDialog share={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}

export function CardGrid({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="card-grid" role="list" aria-label={label}>
      {children}
    </div>
  );
}
export function CardSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="card-grid waiting" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton-card">
          <div className="card-media skeleton" />
          <div className="card-body">
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}
