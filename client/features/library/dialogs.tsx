import { useState } from "react";
import { api, call, type Link } from "../../api";
import { date, until } from "../../lib/format";
import { notifyChange } from "../../lib/live";
import { days, keepOptions } from "../../lib/options";
import { useSession } from "../../app/session";
import { Button, Modal, Segmented, toast, useCloseModal } from "../../components/ui";
import { LinkOptionsFields, linkChoiceProblem, type LinkChoice } from "../../components/LinkOptions";
import { errorToast } from "./actions";

const DAY = 86400000;
type Kept = { id: string; created: number; expires: number | null };

/** How long an item is kept in Files; starts from its current setting, never silently from Forever. */
export function KeepDialog({ item, onClose }: { item: Kept; onClose: () => void }) {
  return (
    <Modal title="Keep in Files for" size="sm" onClose={onClose}>
      <KeepBody item={item} />
    </Modal>
  );
}
function KeepBody({ item }: { item: Kept }) {
  const close = useCloseModal();
  const { me } = useSession();
  // Only the date is stored, and a new choice counts from now, so a dated item has no chosen
  // duration to show: its date is shown instead, and any choice replaces it.
  const current = item.expires ? null : 0;
  const options = keepOptions(null);
  const [value, setValue] = useState<number | null>(current);
  const [busy, setBusy] = useState(false);
  const changed = value !== null && value !== current;
  return (
    <div className="stack keep-dialog">
      <p className="muted">
        {!changed
          ? item.expires
            ? `Moves to Trash on ${date(item.expires)} (${until(item.expires)}).`
            : "Kept until you delete it."
          : value
            ? `Moves to Trash on ${date(Date.now() + value * DAY)}, counted from now.`
            : "Kept until you delete it."}{" "}
        Items in Trash are deleted forever after {days(me.user.trashDays)}, and their links stop working.
      </p>
      <Segmented label="Keep for" value={value ?? -1} options={options} onChange={setValue} />
      <div className="row end">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            if (!changed) return close();
            setBusy(true);
            try {
              await call(api.items.update, { params: { id: item.id }, body: { retentionDays: value || null } });
              notifyChange("items");
              close();
              toast(value ? `Moves to Trash on ${date(Date.now() + value * DAY)}` : "Kept until you delete it");
            } catch (error) {
              errorToast(error);
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * Changes an existing link: how long it works, who can open it, and its note. Only what is changed is
 * sent, so saving never re-dates a link whose expiry was left alone.
 */
export function LinkSettingsDialog({ share, onClose }: { share: Link; onClose: () => void }) {
  const [choice, setChoice] = useState<LinkChoice>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changes: LinkChoice = {
    ...(choice.days !== undefined ? { days: choice.days } : {}),
    ...(choice.password !== undefined ? { password: choice.password } : {}),
    ...(choice.visitorLimit !== undefined && choice.visitorLimit !== share.visitorLimit
      ? { visitorLimit: choice.visitorLimit }
      : {}),
    ...(choice.note !== undefined && choice.note.trim() !== share.note ? { note: choice.note.trim() } : {}),
  };
  const problem = linkChoiceProblem(changes);
  const changed = Object.keys(changes).length > 0;
  async function save() {
    if (!changed) return onClose();
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const saved = await call(api.links.update, { params: { id: share.id }, body: changes });
      notifyChange("links");
      notifyChange("items");
      toast(
        typeof changes.password === "string"
          ? "Password changed. People need the new one to open the link."
          : changes.days === undefined
            ? "Link settings saved"
            : saved.expires === null
              ? "The link now works until you turn it off"
              : `Link now expires ${until(saved.expires)}`,
      );
      onClose();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      size="sm"
      title="Link settings"
      subtitle={share.item?.name}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <LinkOptionsFields
          value={choice}
          current={share}
          onChange={(next) => {
            setChoice(next);
            setError("");
          }}
        />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
