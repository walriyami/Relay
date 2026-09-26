import { useEffect, useState } from "react";
import { api, call, type Link } from "../../api";
import { FileShareDialog } from "../../components/FileShareDialog";
import { confirmDialog, toast } from "../../components/ui";
import { notifyChange, useLive } from "../../lib/live";
import { errorToast } from "./actions";
import { LinkSettingsDialog } from "./dialogs";

/** Why a link that was on screen stopped working. */
function stopped(s: Link) {
  if (s.revoked) return "This link was turned off.";
  if (s.expires !== null && s.expires <= Date.now()) return "This link has expired.";
  return "This link stopped working because its item left Files.";
}

/**
 * An item's share handoff that follows the link as it changes elsewhere: new settings and each new
 * person who opens it show at once,
 * and once the link stops working (turned off in another tab, expired, item trashed) the dialog
 * closes and says why, so a dead link or code is never offered for copying.
 */
export function ItemShareDialog({ share, onClose }: { share: Link; onClose: () => void }) {
  const { data } = useLive(api.links.list, {}, ["links", "items"], []);
  const [editing, setEditing] = useState(false);
  // A link created a moment ago may not be in the list yet; until then, show what we have.
  const live = data.find((l) => l.id === share.id) ?? share;
  const dead = !live.available;
  useEffect(() => {
    if (!dead) return;
    toast(stopped(live));
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dead]);
  async function revoke() {
    const ok = await confirmDialog({
      title: "Turn off this link?",
      body: "People with the link or code will no longer be able to open it. Your files stay in Files.",
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
