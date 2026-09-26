import { Link2Off, SlidersHorizontal } from "lucide-react";
import type { Link } from "../api";
import { shareUrl } from "../lib/format";
import { useExpiryClock } from "../lib/refresh";
import { Button, Modal } from "./ui";
import { LinkDialog } from "./LinkDialog";
import { LinkReach, linkLife, linkTraits } from "./LinkOptions";

/** "Expires in 6 days · Password · One person": how a link works, in one line. */
export const linkSummary = (share: Link, now = Date.now()) =>
  [linkLife(share.expires, now), ...linkTraits(share)].join(" · ");

/** The full handoff for an existing or newly created file share, with who has opened it. */
export function FileShareDialog({
  share,
  subtitle,
  onClose,
  onSettings,
  onRevoke,
}: {
  share: Link;
  subtitle?: string;
  onClose: () => void;
  onSettings?: () => void;
  onRevoke?: () => void;
}) {
  const now = useExpiryClock([share.expires ?? Infinity, share.item?.expires ?? Infinity]);
  if ((share.expires !== null && share.expires <= now) || (share.item?.expires && share.item.expires <= now)) {
    return (
      <Modal size="sm" title="Share expired" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
        <p role="status">
          This share is no longer available. Open the item in Files to manage its retention and sharing.
        </p>
      </Modal>
    );
  }
  return (
    <LinkDialog
      title={share.item?.name || "Share file"}
      subtitle={
        subtitle ||
        (share.locked ? "People need the password to open it." : "Anyone with the link or pickup code can open it.")
      }
      meta={
        <>
          <span>{linkSummary(share, now)}</span>
          <LinkReach link={share} />
        </>
      }
      url={shareUrl(share.token)}
      purpose="file share"
      code={share.code}
      onClose={onClose}
      actions={
        <>
          {onSettings && (
            <Button size="sm" variant="ghost" icon={<SlidersHorizontal size={16} />} onClick={onSettings}>
              Link settings
            </Button>
          )}
          {onRevoke && (
            <Button size="sm" variant="ghost" icon={<Link2Off size={16} />} onClick={onRevoke}>
              Turn off link
            </Button>
          )}
        </>
      }
    />
  );
}
