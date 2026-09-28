import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { Id, Node } from "../api";
import { bytes, plural } from "../lib/format";
import type { ContentSource } from "../lib/source";
import { Thumbnail } from "./Thumbnail";
import { Button, InlineEmpty } from "./ui";

/** A folder with the files anywhere beneath it. */
export type FolderInfo = { node: Node; files: number; size: number };
const PAGE = 90;
// One collator compares as localeCompare does, without resolving the locale on every comparison.
const collator = new Intl.Collator();
const byName = (a: Node, b: Node) => collator.compare(a.name, b.name);

// Folder-aware grid of files, built from the node tree. Text nodes are shown elsewhere as inline blocks.
export function EntryBrowser({
  nodes,
  source,
  onOpen,
  fileAction,
  folderAction,
  folder,
  setFolder,
  rootLabel = "All files",
  root = null,
}: {
  nodes: Node[];
  source: ContentSource;
  onOpen: (node: Node, siblings: Node[]) => void;
  /** A control on each file tile, such as its download button. */
  fileAction?: (node: Node) => ReactNode;
  folderAction?: (folder: FolderInfo) => ReactNode;
  /** The folder being shown; null is the item root. */
  folder: Id | null;
  setFolder: (folder: Id | null) => void;
  /** Breadcrumb name for the top level, e.g. the item's title. */
  rootLabel?: string;
  /** Folder shown as the top level, so an item that is one folder opens inside it. */
  root?: Id | null;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { byId, children, totals } = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map<Id | null, Node[]>();
    const totals = new Map<Id, { files: number; size: number }>();
    for (const n of nodes) {
      if (n.kind === "text") continue;
      const list = children.get(n.parent) || [];
      list.push(n);
      children.set(n.parent, list);
      if (n.kind !== "file") continue;
      for (let at = n.parent; at; at = byId.get(at)?.parent ?? null) {
        const total = totals.get(at) || { files: 0, size: 0 };
        total.files++;
        total.size += n.size;
        totals.set(at, total);
      }
    }
    return { byId, children, totals };
  }, [nodes]);
  // A folder that is no longer there (the item was reloaded without it) falls back to the top level.
  const current = folder && byId.has(folder) ? folder : root;
  // Sorted once per folder shown, not on every render: a folder can hold thousands of files.
  const { folders, files } = useMemo(() => {
    const inside = children.get(current) || [];
    return {
      folders: inside.filter((n) => n.kind === "folder").sort(byName),
      files: inside.filter((n) => n.kind === "file").sort(byName),
    };
  }, [children, current]);
  const crumbs: Node[] = [];
  for (let at = current; at && at !== root; at = byId.get(at)?.parent ?? null) crumbs.unshift(byId.get(at)!);
  const items = [...folders, ...files];
  const shown = items.slice(0, limit);
  if (!items.length && current === null) return null;
  const open = (id: Id | null) => {
    setLimit(PAGE);
    setFolder(id);
  };
  return (
    <div className="entry-browser">
      {crumbs.length > 0 && (
        <div className="entry-head">
          <Crumbs crumbs={crumbs} root={root} rootLabel={rootLabel} open={open} />
        </div>
      )}
      <div className="tile-grid" role="list">
        {shown.map((node) => {
          if (node.kind === "folder") {
            const total = totals.get(node.id) || { files: 0, size: 0 };
            return (
              <div key={node.id} className="tile" role="listitem">
                <button type="button" className="tile-open" onClick={() => open(node.id)}>
                  <div className="tile-media">
                    <div className="thumb thumb-folder">
                      <div className="thumb-icon">
                        <Folder size={32} />
                      </div>
                    </div>
                  </div>
                  <span className="tile-name" title={node.name}>
                    {node.name}
                  </span>
                  <span className="tile-meta">
                    {plural(total.files, "file")} · {bytes(total.size)}
                  </span>
                </button>
                {folderAction && <div className="tile-action">{folderAction({ node, ...total })}</div>}
              </div>
            );
          }
          return (
            <div key={node.id} className="tile" role="listitem">
              <button type="button" className="tile-open" onClick={() => onOpen(node, files)}>
                <div className="tile-media">
                  <Thumbnail entry={node} source={source} />
                </div>
                <span className="tile-name" title={node.name}>
                  {node.name}
                </span>
                <span className="tile-meta">{bytes(node.size)}</span>
              </button>
              {fileAction && <div className="tile-action">{fileAction(node)}</div>}
            </div>
          );
        })}
      </div>
      {items.length > limit && (
        <div className="row center">
          <Button onClick={() => setLimit(limit + PAGE * 2)}>
            Show more ({(items.length - limit).toLocaleString()} left)
          </Button>
        </div>
      )}
      {!items.length && (
        <InlineEmpty icon={<FolderOpen size={20} />} title="This folder is empty">
          It was sent without any files in it.
        </InlineEmpty>
      )}
    </div>
  );
}

function Crumbs({
  crumbs,
  root,
  rootLabel,
  open,
}: {
  crumbs: Node[];
  root: Id | null;
  rootLabel: string;
  open: (id: Id | null) => void;
}) {
  return (
    <nav className="crumbs" aria-label="Folder">
      <button type="button" onClick={() => open(root)}>
        {rootLabel}
      </button>
      {crumbs.map((node, i) => (
        <span key={node.id} className="crumb">
          <ChevronRight size={14} aria-hidden />
          {i === crumbs.length - 1 ? (
            <span aria-current="page">{node.name}</span>
          ) : (
            <button type="button" onClick={() => open(node.id)}>
              {node.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
