import { useMemo, useState } from "react";
import { Download, FolderDown, FolderOpen } from "lucide-react";
import type { Node } from "../api";
import { downloadUrl } from "../lib/format";
import { downloadZip, type ContentSource } from "../lib/source";
import { EntryBrowser } from "./EntryBrowser";
import { FilePreview, PreviewViewer } from "./PreviewViewer";
import { TextBlock } from "./TextBlock";
import { IconButton, InlineEmpty } from "./ui";

/** The files of an item, text excluded: text is shown inline and never downloaded. */
export const filesOf = (nodes: Node[]) => nodes.filter((n) => n.kind === "file");
/** One file with no folders downloads as itself; anything else is one streamed ZIP. */
export const isSingleFile = (nodes: Node[]) => filesOf(nodes).length === 1 && !nodes.some((n) => n.kind === "folder");

/** Downloads everything an item holds in place: a lone file as itself, anything else as a ZIP. */
export function downloadContents(source: ContentSource, nodes: Node[], itemId: string) {
  const files = filesOf(nodes);
  if (isSingleFile(nodes)) downloadUrl(source.file(files[0].id), files[0].name);
  else downloadZip(source, itemId);
}

/**
 * What an item holds, as the item window, the receive popup and a shared link all show it. A single
 * file gets the whole stage as a large preview; anything else is its text above a folder browser
 * whose files open in the viewer. With `fill`, the stage takes the height its container gives it.
 */
export function ContentView({
  nodes,
  source,
  itemId,
  fill = false,
}: {
  nodes: Node[];
  source: ContentSource;
  /** The item behind the nodes, for folder ZIPs; a link's source already knows its item. */
  itemId: string;
  fill?: boolean;
}) {
  // Contents that are exactly one folder open inside it; the breadcrumb starts at its name.
  const rootNode = useMemo(() => {
    const top = nodes.filter((n) => n.parent === null && n.kind !== "text");
    return top.length === 1 && top[0].kind === "folder" ? top[0] : undefined;
  }, [nodes]);
  const root = rootNode?.id ?? null;
  const [folder, setFolder] = useState(root);
  const [viewing, setViewing] = useState<{ list: Node[]; index: number } | null>(null);
  const texts = nodes.filter((n) => n.kind === "text");
  const single = isSingleFile(nodes) ? filesOf(nodes)[0] : undefined;

  if (!nodes.length)
    return (
      <InlineEmpty icon={<FolderOpen size={20} />} title="This item is empty">
        There are no files or text in it.
      </InlineEmpty>
    );
  return (
    <div className={`content-view${fill ? " is-fill" : ""}${single ? " is-single" : ""}`}>
      {texts.map((t) => (
        <TextBlock key={t.id} text={t.text || ""} />
      ))}
      {single ? (
        <section className={`content-stage${fill ? " preview-fill" : ""}`} aria-label={`Preview of ${single.name}`}>
          <FilePreview key={single.id} entry={single} source={source} />
        </section>
      ) : (
        <EntryBrowser
          nodes={nodes}
          source={source}
          folder={folder}
          setFolder={setFolder}
          root={root}
          rootLabel={rootNode?.name}
          onOpen={(node, list) => setViewing({ list, index: list.indexOf(node) })}
          fileAction={(node) => (
            <IconButton
              size="sm"
              label={`Download ${node.name}`}
              icon={<Download size={16} />}
              onClick={() => downloadUrl(source.file(node.id), node.name)}
            />
          )}
          folderAction={({ node }) => (
            <IconButton
              size="sm"
              label={`Download ${node.name} as ZIP`}
              icon={<FolderDown size={16} />}
              onClick={() => downloadZip(source, itemId, node.id)}
            />
          )}
        />
      )}
      {viewing && (
        <PreviewViewer entries={viewing.list} start={viewing.index} source={source} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
