import { useEffect, useState } from "react";
import { api, call, type Link } from "../../api";
import { FileShareDialog } from "../../components/FileShareDialog";
import { confirmDialog, toast } from "../../components/ui";
import { notifyChange } from "../../lib/live";
import { useLiveLink } from "../../lib/live-link";
import { useExpiryClock } from "../../lib/refresh";
import { linkDeadline, linkUnavailableReason } from "../../lib/link-availability";
import { errorToast } from "./actions";
import { LinkSettingsDialog } from "./dialogs";

/**
 * An item's share handoff that follows the link as it changes elsewhere: new settings and each new
 * person who opens it show at once,
 * and once the link stops working (turned off in another tab, expired, item trashed) the dialog
 * closes and says why, so a dead link or code is never offered for copying.
 */
export function ItemShareDialog({ share, onClose }: { share: Link; onClose: () => void }) {
  const { link: live, removed } = useLiveLink(share);
  const [editing, setEditing] = useState(false);
  const deadline = linkDeadline(live);
  const now = useExpiryClock([deadline]);
  const stopped = removed ? "This link is no longer available." : linkUnavailableReason(live, now);
  const dead = stopped !== null;
  useEffect(() => {
    if (!dead) return;
    toast(stopped);
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dead]);
  async function revoke() {
    const ok = await confirmDialog({
      title: "Turn off this link?",
      body: "People with the link or code will no longer be able to open it. Downloads already started may finish. Your files stay in Files.",
      confirm: "Turn off link",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(api.links.revoke, { params: { id: live.id } });
      onClose();
      notifyChange("links");
      notifyChange("items");
      toast("Link turned off");
    } catch (error) {
      errorToast(error);
    }
  }
  if (dead) return null;
  return (
    <>
      <FileShareDialog
        share={live}
        onClose={onClose}
        onSettings={() => setEditing(true)}
        onRevoke={() => void revoke()}
      />
      {editing && <LinkSettingsDialog share={live} onClose={() => setEditing(false)} />}
    </>
  );
}
