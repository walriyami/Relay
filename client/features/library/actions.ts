import {
  ApiError,
  api,
  call,
  stableId,
  type Device,
  type ItemDetail,
  type ItemSummary,
  type Link,
  type Prefs,
} from "../../api";
import { download } from "../../lib/download";
import { copyText, dateTime, plural } from "../../lib/format";
import { downloadZip, ownerSource } from "../../lib/source";
import { notifyChange } from "../../lib/live";
import { startTransfer, subscribe as onTransfers } from "../../lib/transfers";
import { navigate } from "../../lib/router";
import { confirmDialog, dismissToastKey, promptDialog, toast } from "../../components/ui";

// One set of actions shared by the card "⋯" menu and the item window, so both behave identically.

export function errorToast(error: unknown) {
  toast((error as Error).message || "Something went wrong.", { tone: "error" });
}

export const loadItem = (id: string) => call(api.items.get, { params: { id } });

/** Top-level parts: loose files, folders, and the text (counted once). */
export const itemParts = (c: ItemSummary) => c.topFiles + c.topFolders + (c.texts ? 1 : 0);

/** "2 files, 1 folder and text" */
export function composition(files: number, folders: number, texts: number) {
  const parts: string[] = [];
  if (folders) parts.push(folders === 1 ? "1 folder" : `${folders} folders`);
  if (files) parts.push(files === 1 ? "1 file" : `${files} files`);
  if (texts) parts.push("text");
  if (parts.length < 2) return parts[0] === "text" ? "Text" : parts[0] || "Empty";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Every file, counted through the folders. Beside loose files it says "in all", so
 * "1 folder and 3 files · 1,203 files in all" never reads as a contradiction.
 */
export const allFiles = (total: number, topFiles: number) => `${plural(total, "file")}${topFiles ? " in all" : ""}`;

/** What's inside, in words: "PNG file", "Folder · 120 files", "3 files and text". */
export function itemMeta(c: ItemSummary) {
  const top = c.topFiles + c.topFolders;
  if (!top) return c.texts ? "Text" : "Empty";
  if (top === 1 && !c.texts) {
    if (c.topFolders) return `Folder · ${c.files.toLocaleString()} ${c.files === 1 ? "file" : "files"}`;
    const ext = /\.([a-z0-9]{1,5})$/i.exec(c.preview?.name || c.name)?.[1];
    return ext ? `${ext.toUpperCase()} file` : "File";
  }
  return composition(c.topFiles, c.topFolders, c.texts);
}

/** A lone file at the root downloads as itself; anything else is one streamed ZIP. */
export const singleFile = (c: ItemSummary) => c.files === 1 && !c.topFolders;
export const hasDownloads = (c: Pick<ItemSummary, "files" | "topFolders">) => c.files > 0 || c.topFolders > 0;
export const downloadLabel = (single: boolean) => (single ? "Download" : "Download ZIP");

export async function downloadItem(c: ItemSummary | ItemDetail) {
  if (!hasDownloads(c)) return toast("There are no files or folders to download.");
  if (singleFile(c)) {
    const file =
      "nodes" in c
        ? c.nodes.find((n) => n.kind === "file")
        : c.preview?.kind === "file"
          ? c.preview
          : (await loadItem(c.id)).nodes.find((n) => n.kind === "file");
    if (file) return download(ownerSource.file(file.id), file.name);
  }
  downloadZip(ownerSource, c.id);
}

export async function copyItemText(c: ItemDetail) {
  const text = c.nodes
    .filter((n) => n.kind === "text")
    .map((n) => n.text || "")
    .join("\n\n");
  if (await copyText(text)) toast("Text copied");
  else toast("Couldn’t copy. Open the item and select the text instead.", { tone: "error" });
}

/** Returns the item's active link, creating it once when needed. The caller owns presentation. */
export async function ensureItemLink(c: ItemSummary | ItemDetail, prefs: Prefs): Promise<Link> {
  const links = "links" in c ? c.links : c.linked ? (await loadItem(c.id)).links : [];
  // A link that has let in everyone it was for can't be passed on; a new one is made instead.
  const active = links.find((l) => l.available && !l.full);
  if (active) return active;
  const key = stableId(`link:${c.id}`);
  const created = await call(api.links.create, { body: { id: key.id, item: c.id, days: prefs.linkDays } });
  key.forget();
  notifyChange("links");
  notifyChange("items");
  return created;
}

export async function sendItem(itemId: string, device: Pick<Device, "id" | "name">) {
  const key = stableId(`delivery:${itemId}:${device.id}`);
  try {
    await call(api.deliveries.create, { body: { id: key.id, item: itemId, device: device.id } });
  } catch (e) {
    // The device went offline since the menu was drawn; refresh the list so it disappears.
    if (e instanceof ApiError && e.status === 409) {
      notifyChange("devices");
    }
    throw e;
  }
  key.forget();
  notifyChange("deliveries");
  toast(`Sent to ${device.name}`, { tone: "success" });
}

/**
 * Names the item as a whole. What's inside keeps the names it was sent with; an empty name goes back
 * to one taken from the contents.
 */
export async function renameItem(c: Pick<ItemSummary, "id" | "name" | "autoName">) {
  await promptDialog({
    title: "Rename",
    label: "Name",
    value: c.autoName ? "" : c.name,
    hint: c.autoName ? `Now named after what’s inside: “${c.name}”.` : "Leave it empty to name it after what’s inside.",
    optional: true,
    confirm: "Rename",
    apply: async (value) => {
      const name = value.trim() || null;
      if (name === (c.autoName ? null : c.name)) return;
      await call(api.items.update, { params: { id: c.id }, body: { name } });
      notifyChange("items");
      notifyChange("links");
    },
  });
}

/**
 * Opens the system file picker; resolves with nothing when it is dismissed. The input is attached
 * while open, since Safari can lose the choice made in a detached one.
 */
function pickFiles() {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * Adds files to an item that was already sent, such as the one forgotten beside a large upload.
 * Anyone with a link to it sees them there; nothing already in it changes. Progress shows on the
 * item's card and in Send; how it ended is told here, since the page may be anywhere by then.
 */
export async function addFilesTo(c: Pick<ItemSummary, "id" | "name">) {
  const files = await pickFiles();
  if (!files.length) return;
  const current = await loadItem(c.id);
  if (current.linked || current.hardExpires !== null) {
    const accepted = await confirmDialog({
      title: `Add files to “${current.name}”?`,
      body: [
        `These files will be added to “${current.name}”.`,
        current.linked && "Anyone with a working link can see each file as soon as it is saved.",
        current.hardExpires !== null
          ? `All content in this item is deleted forever by ${dateTime(current.hardExpires)}, including time in Trash. Adding files does not extend this deadline.`
          : "This item has no maximum age deadline.",
      ]
        .filter(Boolean)
        .join(" "),
      confirm: "Add files",
    });
    if (!accepted) return;
  }
  const t = startTransfer({
    files: files.map((file) => ({ file, path: file.name })),
    folders: [],
    text: "",
    name: c.name,
    item: c.id,
    destination: { kind: "save" },
  });
  const count = plural(files.length, "file");
  toast(`Adding ${count} to “${c.name}”…`, { key: `adding:${t.id}` });
  const stop = onTransfers(() => {
    if (t.status === "done") {
      stop();
      toast(`Added ${count} to “${c.name}”`, { key: `adding:${t.id}`, tone: "success" });
    } else if (t.status === "failed" || t.status === "attention" || t.status === "cancelled") {
      stop();
      if (t.status === "cancelled") return dismissToastKey(`adding:${t.id}`);
      toast(t.error || `Couldn’t add ${count} to “${c.name}”.`, {
        key: `adding:${t.id}`,
        tone: "error",
        action: { label: "Show", onClick: () => navigate("/") },
      });
    }
  });
}

/** Undo toasts are keyed by the trashed item, so deleting it forever takes its Undo away too. */
export const undoKey = (itemId: string) => `undo:${itemId}`;

export async function trashItem(c: Pick<ItemSummary, "id" | "name">) {
  await call(api.items.trash, { params: { id: c.id } });
  notifyChange("items");
  toast(`Moved “${c.name}” to Trash`, {
    key: undoKey(c.id),
    action: {
      label: "Undo",
      onClick: () =>
        void call(api.items.restore, { params: { id: c.id } })
          .then(() => notifyChange("items"))
          .catch(errorToast),
    },
  });
}

export async function restoreItem(c: Pick<ItemSummary, "id" | "name">) {
  await call(api.items.restore, { params: { id: c.id } });
  dismissToastKey(undoKey(c.id));
  notifyChange("items");
  toast(`Restored “${c.name}”. Its hard deadline is unchanged.`, { tone: "success" });
}

export async function deleteItemForever(c: Pick<ItemSummary, "id" | "name">) {
  if (
    !(await confirmDialog({
      title: "Delete forever?",
      body: `“${c.name}” will be permanently deleted. This can’t be undone.`,
      confirm: "Delete forever",
      danger: true,
    }))
  )
    return false;
  await call(api.items.remove, { params: { id: c.id } });
  dismissToastKey(undoKey(c.id));
  notifyChange("items");
  toast("Deleted forever");
  return true;
}
