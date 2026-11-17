/**
 * One icon per idea, so the same action looks the same on every screen. Use `<Icon.share size={16} />`
 * rather than importing a Lucide icon directly when the icon stands for one of these ideas.
 *
 * Sizes: 16 in buttons and menus, 18 in list rows, 20 in navigation, 28 in empty states.
 */
import {
  CircleCheck,
  Clock,
  Copy,
  Download,
  Ellipsis,
  FolderInput,
  FolderOpen,
  Link2,
  Link2Off,
  LockKeyhole,
  Pencil,
  Plus,
  RotateCcw,
  Share,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";

export const Icon = {
  /** A share link, and the Links section. */
  link: Link2,
  /** Turning a link off. */
  linkOff: Link2Off,
  /** Sharing something: opens the link, QR code and code. */
  share: Share,
  /** A request for files, and the Requests section. */
  request: FolderInput,
  /** Choosing files to send or upload, and drop targets. */
  upload: Upload,
  download: Download,
  copy: Copy,
  /** Opening an item or folder. */
  open: FolderOpen,
  rename: Pencil,
  add: Plus,
  close: X,
  more: Ellipsis,
  /** Settings of one thing (a link, a request). */
  options: SlidersHorizontal,
  trash: Trash2,
  restore: RotateCcw,
  /** Time: when a link expires, when an item is deleted. */
  time: Clock,
  /** A password protects it. */
  locked: LockKeyhole,
  /** Done, sent, saved. */
  done: CircleCheck,
};
