import { urls } from "../api";
import { download } from "./download";

// Where content comes from: the owner's library (deliveries too — they are the owner's own items)
// or a public link token (links and pickup codes).
export type ContentSource = {
  token?: string;
  file(nodeId: string, inline?: boolean): string;
  thumb(nodeId: string, size: "s" | "l"): string;
  zip(itemId: string, folderId?: string): string;
};
export const ownerSource: ContentSource = {
  file: (id, inline) => urls.nodeContent(id, { inline }),
  thumb: (id, size) => urls.nodeThumbnail(id, size),
  zip: (item, folder) => urls.itemZip(item, folder),
};
export const shareSource = (token: string): ContentSource => ({
  token,
  file: (id, inline) => urls.shareContent(token, id, { inline }),
  thumb: (id, size) => urls.shareThumbnail(token, id, size),
  zip: (_item, folder) => urls.shareZip(token, folder),
});

/** ZIPs stream straight from the server (with resumable ranges); nothing is prepared first. */
export function downloadZip(source: ContentSource, itemId: string, folderId?: string) {
  download(source.zip(itemId, folderId));
}
