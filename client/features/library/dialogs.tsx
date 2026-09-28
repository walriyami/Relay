import { useEffect, useState } from "react";
import { api, call, type ItemSummary, type Link } from "../../api";
import { dateTime, until } from "../../lib/format";
import { notifyChange } from "../../lib/live";
import { days, keepOptions } from "../../lib/options";
import { useSession } from "../../app/session";
import { Button, Modal, Segmented, toast, useCloseModal } from "../../components/ui";
import {
  LinkOptionsFields,
  linkChoiceProblem,
  useLinkChoiceLimit,
  type LinkChoice,
} from "../../components/LinkOptions";
import { errorToast } from "./actions";

import { boundedOptions, effectiveExpiry } from "../../lib/lifecycle";
import { useExpiryClock } from "../../lib/refresh";
type Kept = Pick<ItemSummary, "id" | "expires" | "firstSavedAt" | "maxAgeDays" | "hardExpires">;

/** When an item moves to Trash; starts from its current setting, never silently from "Never". */
export function KeepDialog({ item, onClose }: { item: Kept; onClose: () => void }) {
  return (
    <Modal title="Move to Trash after" size="sm" onClose={onClose}>
      <KeepBody item={item} />
    </Modal>
  );
}
function KeepBody({ item }: { item: Kept }) {
  const close = useCloseModal();
  const { me } = useSession();
  // Only the date is stored, and a new choice counts from now, so a dated item has no chosen
  // duration to show: its date is shown instead, and any choice replaces it.
  const current = item.expires || item.firstSavedAt === null ? null : 0;
  const max =
    item.maxAgeDays === null ? me.user.limits.keepDays : Math.min(item.maxAgeDays, me.user.limits.keepDays ?? Infinity);
  const now = useExpiryClock([item.expires ?? Infinity, item.hardExpires ?? Infinity]);
  const expired = item.firstSavedAt !== null && item.expires !== null && item.expires <= now;
  const options = boundedOptions(keepOptions(null, max), item.hardExpires, now);
  const [chosen, setValue] = useState<number | null>(current);
  const value = chosen === null ? null : max === null ? chosen : Math.min(chosen || Infinity, max);
  useEffect(() => {
    if (value !== chosen) setValue(value);
  }, [value, chosen]);
  const [busy, setBusy] = useState(false);
  const changed = value !== null && value !== current;
  return (
    <div className="stack keep-dialog">
      <p className="muted">
        {item.firstSavedAt === null
          ? "The clock starts when the first content is saved."
          : expired
            ? "This item has expired and cannot be renewed."
            : (() => {
                const expiry = changed ? effectiveExpiry(value || null, item.hardExpires, now) : item.expires;
                return expiry ? `Moves to Trash on ${dateTime(expiry)}.` : "Kept until you delete it.";
              })()}{" "}
        {item.hardExpires !== null
          ? `Deleted forever by ${dateTime(item.hardExpires)}, including time in Trash. Renewal and restore cannot extend this deadline.`
          : max !== null
            ? `Maximum total age is ${days(max)} from the first saved content, including Trash.`
            : `Trash is kept for up to ${days(me.user.trashDays)}.`}
      </p>
      {!expired && <Segmented label="Move to Trash after" value={value ?? -1} options={options} onChange={setValue} />}
      <div className="row end">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={expired}
          onClick={async () => {
            if (!changed) return close();
            setBusy(true);
            try {
              const saved = await call(api.items.update, {
                params: { id: item.id },
                body: { retentionDays: value || null },
              });
              notifyChange("items");
              close();
              toast(
                saved.firstSavedAt === null
                  ? "Saved. The clock starts with the first saved content."
                  : saved.expires
                    ? `Moves to Trash on ${dateTime(saved.expires)}`
                    : "Kept until you delete it",
              );
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
  const [draft, setChoice] = useState<LinkChoice>({});
  const choice = useLinkChoiceLimit(draft, setChoice);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
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
    if (!share.available || Math.min(share.expires ?? Infinity, share.item?.expires ?? Infinity) <= Date.now()) {
      toast("This link is no longer available.");
      return onClose();
    }
    if (!changed) return onClose();
    if (problem) return setAttempted(true);
    setBusy(true);
    try {
      const saved = await call(api.links.update, { params: { id: share.id }, body: changes });
      notifyChange("links");
      notifyChange("items");
      const expiry = Math.min(saved.expires ?? Infinity, saved.item?.expires ?? Infinity);
      toast(
        [
          typeof changes.password === "string" ? "Password changed." : "Link settings saved.",
          !saved.available
            ? "This link is no longer available."
            : expiry <= Date.now()
              ? "This link has expired."
              : Number.isFinite(expiry)
                ? `Expires on ${dateTime(expiry)} (${until(expiry)}).`
                : "Works until you turn it off.",
        ].join(" "),
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
          itemDeadline={share.item?.expires}
          attempted={attempted}
          onChange={(next) => {
            setChoice(next);
            setAttempted(false);
          }}
        />
      </form>
    </Modal>
  );
}
