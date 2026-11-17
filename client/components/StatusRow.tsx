import type { ReactNode } from "react";
import { Icon } from "./icons";
import { Thumbnail } from "./Thumbnail";
import { ownerSource } from "../lib/source";
import type { ItemSummary } from "../../shared/model";

/**
 * One row of a list of things you shared or asked for (Links, Requests): a picture, the name with
 * any marker in front of it (so a cut-off name never hides it), and its state as chips. Opening
 * the row and the trailing actions are the caller's.
 */
export function StatusRow({
  media,
  marker,
  title,
  chips,
  inactive = false,
  onOpen,
  disabled,
  opensDialog = false,
  className = "",
  children,
}: {
  media: ReactNode;
  marker?: ReactNode;
  title: string;
  chips: ReactNode;
  inactive?: boolean;
  onOpen: () => void;
  disabled?: boolean;
  opensDialog?: boolean;
  className?: string;
  /** Buttons and menus after the text. */
  children?: ReactNode;
}) {
  return (
    <li className={`list-row status-row ${className}${inactive ? " inactive" : ""}`}>
      <span className="list-icon">{media}</span>
      <button
        type="button"
        className="list-text"
        disabled={disabled}
        aria-haspopup={opensDialog ? "dialog" : undefined}
        onClick={onOpen}
      >
        <strong className="status-row-title">
          {marker}
          <span>{title}</span>
        </strong>
        <span className="chips">{chips}</span>
      </button>
      {children}
    </li>
  );
}

/** A small picture of a shared item: its first image or page, else its kind of file, else a link. */
export function ItemThumb({ item }: { item: ItemSummary | null }) {
  const preview = item?.preview;
  if (!item || !preview || (item.topFolders === 1 && !item.topFiles && !item.texts))
    return item?.topFolders ? (
      <Thumbnail compact entry={{ path: item.name, kind: "folder" }} />
    ) : (
      <Icon.link size={18} aria-hidden />
    );
  // Text is too small to read at this size, so it shows as text's icon.
  return (
    <Thumbnail compact source={ownerSource} entry={preview.kind === "text" ? { ...preview, text: null } : preview} />
  );
}
