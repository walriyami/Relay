// What the administrator allows a member: the most storage they may use, and the longest they may
// keep uploads and links. No limit is the norm; a limit is something added on purpose, to an
// invitation before it is used or to a member at any time.
import { useRef, useState } from "react";
import { ChevronDown, Clock, HardDrive, Link2 } from "lucide-react";
import { ApiError, api, call, LIMITS, NO_LIMITS, type MemberLimits, type PendingInvite } from "../../api";
import { bytes, dateTime } from "../../lib/format";
import { days, LIMIT_KEEP_DAYS, LIMIT_LINK_DAYS, shortDays, withCurrent } from "../../lib/options";
import { Button, Field, Modal, Segmented } from "../../components/ui";
import { LinkDialog } from "../../components/LinkDialog";
import { ByteSizeField, fromDraft, toDraft, type ByteDraft } from "./ByteSize";

const GB = 1024 ** 3;
const STORAGE_PRESETS = [10 * GB, 50 * GB, 100 * GB];
/** Segmented values can't be null: 0 is "No limit", and -1 a storage size typed in. */
const NONE = 0;
const OTHER = -1;

export const hasLimits = (l: MemberLimits) => l.storage !== null || l.keepDays !== null || l.linkDays !== null;

/** "10 GB · uploads 90 days · links 30 days", or "No limits". */
export function limitsSummary(l: MemberLimits) {
  if (!hasLimits(l)) return "No limits";
  return [
    l.storage !== null && `${bytes(l.storage)} storage`,
    l.keepDays !== null && `file age up to ${days(l.keepDays)}`,
    l.linkDays !== null && `links up to ${days(l.linkDays)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The limits as the form shows them. */
type Draft = { storage: number; custom: ByteDraft; keepDays: number; linkDays: number };
const toForm = (l: MemberLimits): Draft => ({
  storage: l.storage === null ? NONE : STORAGE_PRESETS.includes(l.storage) ? l.storage : OTHER,
  custom: toDraft(l.storage ?? 20 * GB),
  keepDays: l.keepDays ?? NONE,
  linkDays: l.linkDays ?? NONE,
});
/** The limits to save, or null while the typed size isn't one. */
const fromForm = (d: Draft): MemberLimits | null => {
  const storage = d.storage === OTHER ? fromDraft(d.custom) : d.storage || null;
  if (d.storage === OTHER && storage === null) return null;
  return { storage, keepDays: d.keepDays || null, linkDays: d.linkDays || null };
};
const sameLimits = (a: MemberLimits, b: MemberLimits) =>
  a.storage === b.storage && a.keepDays === b.keepDays && a.linkDays === b.linkDays;

const dayOptions = (presets: number[], current: number) => [
  { value: NONE, label: "No limit" },
  ...withCurrent(presets, current || presets[0])
    .filter((n) => n > 0)
    .map((value) => ({ value, label: days(value), short: shortDays(value) })),
];

/** The three limits, each "No limit" or a most. `used` is what the member already keeps, if anyone. */
export type LimitsDraft = Draft;

export function LimitsFields({
  draft,
  onChange,
  used,
  invalid,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  used?: number;
  invalid: boolean;
}) {
  const custom = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const storage = draft.storage === OTHER ? fromDraft(draft.custom) : draft.storage || null;
  return (
    <div className="limits-fields">
      <div className="limit-field">
        <span className="limit-field-title">
          <HardDrive size={16} aria-hidden /> Storage
        </span>
        <Segmented
          label="Storage limit"
          value={draft.storage}
          options={[
            { value: NONE, label: "No limit" },
            ...STORAGE_PRESETS.map((value) => ({ value, label: bytes(value) })),
            { value: OTHER, label: "Other" },
          ]}
          onChange={(value) => {
            set({ storage: value });
            if (value === OTHER) setTimeout(() => custom.current?.querySelector("input")?.focus());
          }}
        />
        {draft.storage === OTHER && (
          <div ref={custom} className="setup-reveal">
            <ByteSizeField
              label="Other storage limit"
              draft={draft.custom}
              onChange={(next) => set({ custom: next })}
              invalid={invalid}
            />
          </div>
        )}
        <span className="field-hint">
          {storage === null
            ? "They can use any free space, shared with everyone."
            : used !== undefined && used > storage
              ? `${bytes(used)} is saved or reserved, above this limit. New uploads are blocked; accepted uploads can finish. Nothing is removed.`
              : "Saved files, Trash and upload reservations count. Accepted uploads can finish if this limit is reduced."}
        </span>
      </div>
      <div className="limit-field">
        <span className="limit-field-title">
          <Clock size={16} aria-hidden /> Maximum file age
        </span>
        <Segmented
          label="Maximum file age"
          value={draft.keepDays}
          options={dayOptions(LIMIT_KEEP_DAYS, draft.keepDays)}
          onChange={(keepDays) => set({ keepDays })}
        />
        <span className="field-hint">
          {draft.keepDays
            ? `Files are deleted forever after at most ${days(draft.keepDays)} from the first saved content, including time in Trash. Tightening also applies to existing files and Trash, with no extra grace period.`
            : "No new maximum age. Existing hard deadlines stay in place."}
        </span>
      </div>
      <div className="limit-field">
        <span className="limit-field-title">
          <Link2 size={16} aria-hidden /> Links
        </span>
        <Segmented
          label="Links work at most"
          value={draft.linkDays}
          options={dayOptions(LIMIT_LINK_DAYS, draft.linkDays)}
          onChange={(linkDays) => set({ linkDays })}
        />
        <span className="field-hint">
          {draft.linkDays
            ? `Shared links and upload-request URLs expire within ${days(draft.linkDays)}.`
            : "Shared links can have no expiry; upload requests always expire."}
        </span>
      </div>
    </div>
  );
}

/** Limits and their form state together, with what to save. */
export function useLimitsForm(initial: MemberLimits) {
  const [draft, setDraft] = useState(() => toForm(initial));
  const [baseline, setBaseline] = useState(initial);
  const limits = fromForm(draft);
  return {
    draft,
    setDraft,
    /** Null while the typed size isn't a size. */
    limits,
    baseline,
    stale: !sameLimits(initial, baseline),
    acceptCurrent: () => setBaseline(initial),
    changed: limits === null || !sameLimits(limits, baseline),
    reset: (next: MemberLimits) => setDraft(toForm(next)),
  };
}

type Created = { token: string; code: string; expires: number; limits: MemberLimits };

/**
 * Creates an invitation, or changes one nobody has used yet: who it is for, and any limits. Limits
 * stay folded away behind one line until asked for.
 */
export function InviteDialog({
  invite,
  onClose,
  onSaved,
  onRefresh,
}: {
  /** The invitation to change; left out to create one. */
  invite?: PendingInvite;
  onClose: () => void;
  onSaved: () => void;
  onRefresh?: () => void;
}) {
  const [note, setNote] = useState(invite?.note ?? "");
  const form = useLimitsForm(invite?.limits ?? NO_LIMITS);
  const [open, setOpen] = useState(!!invite && hasLimits(invite.limits));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  if (created)
    return (
      <LinkDialog
        title="Invitation ready"
        subtitle="Copy or scan this link now. For security, it can’t be shown again after you close this window."
        meta={`Works once · Expires ${dateTime(created.expires)} · ${limitsSummary(created.limits)}`}
        url={`${location.origin}/join/${created.token}`}
        code={created.code}
        codeLabel="Invitation code"
        purpose="invitation"
        onClose={onClose}
      />
    );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (form.stale)
      return setError(
        "Limits changed while this invitation was open. Review the current limits before saving your draft.",
      );
    if (!form.limits) return setError("Enter a storage limit more than zero, or choose No limit.");
    const limits = open ? form.limits : NO_LIMITS;
    setBusy(true);
    try {
      if (invite) {
        await call(api.admin.updateInvite, {
          params: { id: invite.id },
          body: { note: note.trim() || null, limits, expectedLimits: form.baseline },
        });
        onSaved();
        onClose();
      } else {
        const made = await call(api.admin.invite, { body: { note: note.trim() || undefined, limits } });
        onSaved();
        setCreated({ ...made, limits });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) onRefresh?.();
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={invite ? "Edit invitation" : "Invite a member"}
      subtitle={
        invite
          ? "Changes apply when they join. The link and code stay the same."
          : "They get a link and a code to create their own account."
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="invite-form" busy={busy}>
            {invite ? "Save" : "Create invitation"}
          </Button>
        </>
      }
    >
      <form id="invite-form" className="stack" noValidate onSubmit={save}>
        <Field label="Who is it for?" hint="Optional. Only administrators see this.">
          <input
            className="input"
            maxLength={LIMITS.inviteNoteLength}
            autoComplete="off"
            placeholder="A name, or anything to tell invitations apart"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {open ? (
          <div className="limits-panel">
            <div className="limits-panel-head">
              <strong>Limits</strong>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setOpen(false);
                  form.reset(NO_LIMITS);
                }}
              >
                Remove limits
              </button>
            </div>
            <LimitsFields draft={form.draft} onChange={form.setDraft} invalid={form.limits === null} />
          </div>
        ) : (
          <div className="limits-closed">
            <span>
              <strong>No limits.</strong>{" "}
              <span className="muted">
                They can use any free space, and choose how long their uploads and links last.
              </span>
            </span>
            <Button size="sm" icon={<ChevronDown size={16} />} onClick={() => setOpen(true)}>
              Add limits
            </Button>
          </div>
        )}
        {form.stale && (
          <p className="notice" role="alert">
            Limits changed while this invitation was open. Your draft is preserved. Current limits:{" "}
            {limitsSummary(invite?.limits ?? NO_LIMITS)}.{" "}
            <button type="button" className="link" onClick={form.acceptCurrent}>
              Use my draft with these current limits
            </button>
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
