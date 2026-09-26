import { useCallback, useRef, useState } from "react";
import { ChevronDown, Eye, EyeOff, Plus } from "lucide-react";
import { LIMITS, api, type Link } from "../api";
import { ago, date, plural, until } from "../lib/format";
import { useLive } from "../lib/live";
import { days as dayLabel, fromSegment, linkLifeOptions, toSegment } from "../lib/options";
import { Button, IconButton, Popover, Segmented, Spinner, Toggle } from "./ui";

const DAY = 86_400_000;

/**
 * A link's options as chosen on screen. For an existing link, `undefined` leaves a setting as it is;
 * `password` is a new password (null removes it, "" is one still being typed).
 */
export type LinkChoice = {
  days?: number | null;
  password?: string | null;
  visitorLimit?: number | null;
  note?: string;
};
/** What an existing link has, for starting from it. */
type Current = Pick<Link, "expires" | "locked" | "visitorLimit" | "note" | "visitors">;

/** A new link's options: the default lifetime and nothing else. */
export type NewLinkChoice = { days: number | null; password: string | null; visitorLimit: number | null; note: string };
export const newLinkChoice = (days: number | null): NewLinkChoice => ({
  days,
  password: null,
  visitorLimit: null,
  note: "",
});
/** What a new link is created with: only what was set, with the note trimmed. */
export const linkRequest = (c: NewLinkChoice) => ({
  days: c.days,
  ...(c.password !== null ? { password: c.password } : {}),
  ...(c.visitorLimit !== null ? { visitorLimit: c.visitorLimit } : {}),
  ...(c.note.trim() ? { note: c.note.trim() } : {}),
});

/** Why the options can't be used yet; null when they can. */
export function linkChoiceProblem(c: LinkChoice) {
  if (typeof c.password === "string" && c.password.length < LIMITS.linkPasswordMin)
    return c.password ? `Use at least ${LIMITS.linkPasswordMin} characters for the password.` : "Enter a password.";
  return null;
}

/** "Password · One person · Note": what sets a link apart from an open one. */
export function linkTraits(o: { locked: boolean; visitorLimit: number | null; note: string }) {
  const traits: string[] = [];
  if (o.locked) traits.push("Password");
  if (o.visitorLimit) traits.push(o.visitorLimit === 1 ? "One person" : `${o.visitorLimit} people`);
  if (o.note.trim()) traits.push("Note");
  return traits;
}

/** "7 days · Password": a new link's options on the button that opens them. */
export const newLinkSummary = (c: NewLinkChoice) =>
  [
    c.days === null ? "No expiry" : dayLabel(c.days),
    ...linkTraits({ locked: c.password !== null, visitorLimit: c.visitorLimit, note: c.note }),
  ].join(" · ");

/** "Expires in 6 days", "Never expires". */
export const linkLife = (expires: number | null, now = Date.now()) =>
  expires === null ? "Never expires" : `Expires ${until(expires, now)}`;

/** "Not opened yet", "Opened by 2 people · 3 downloads · 5 min ago". */
export function linkReach(l: Pick<Link, "visitors" | "downloads" | "lastVisit" | "full">, now = Date.now()) {
  if (!l.visitors) return "Not opened yet";
  const parts = [`Opened by ${plural(l.visitors, "person", "people")}`];
  if (l.downloads) parts.push(plural(l.downloads, "download"));
  if (l.lastVisit) parts.push(ago(l.lastVisit, now));
  if (l.full) parts.push("nobody new can open it");
  return parts.join(" · ");
}

/**
 * The options for a new or existing link, in the order people think of them: how long it works,
 * then who can open it, then what they read. Only the lifetime is always shown open; the rest are
 * switches or one line until asked for.
 */
export function LinkOptionsFields({
  value,
  onChange,
  current,
}: {
  value: LinkChoice;
  onChange: (next: LinkChoice) => void;
  current?: Current;
}) {
  const set = (patch: LinkChoice) => onChange({ ...value, ...patch });
  const [reveal, setReveal] = useState(false);
  const [noteOpen, setNoteOpen] = useState(!!(value.note ?? current?.note));
  const now = Date.now();
  const life =
    value.days === undefined
      ? current?.expires
        ? `${linkLife(current.expires, now)}, on ${date(current.expires)}. A new choice counts from now.`
        : "Works until you turn it off."
      : value.days === null
        ? "Works until you turn it off."
        : `Until ${date(now + value.days * DAY)}${current ? ", counted from now" : ""}.`;

  const keptPassword = value.password === undefined && !!current?.locked;
  const hasPassword = value.password === undefined ? !!current?.locked : value.password !== null;
  const limit = value.visitorLimit === undefined ? (current?.visitorLimit ?? null) : value.visitorLimit;
  const seen = current?.visitors ?? 0;
  const note = value.note ?? current?.note ?? "";
  const problem = linkChoiceProblem(value);
  return (
    <div className="link-options">
      <div className="stack-sm">
        <span className="field-label">Expires</span>
        <Segmented
          label="Expires"
          value={value.days === undefined ? -1 : toSegment(value.days)}
          options={linkLifeOptions(value.days)}
          onChange={(v) => set({ days: fromSegment(v) })}
        />
        <p className="field-hint">{life}</p>
      </div>

      <div className="link-option">
        <Toggle
          label="Password"
          description="Asked for before anything is shown."
          checked={hasPassword}
          onChange={(on) => {
            setReveal(false);
            // Turning a kept password back on keeps it; a new one starts empty.
            set({
              password: on ? (current?.locked ? undefined : "") : current?.locked ? null : current ? undefined : null,
            });
          }}
        />
        {hasPassword &&
          (keptPassword ? (
            <p className="link-option-detail muted">
              A password is set.{" "}
              <button type="button" className="link" onClick={() => set({ password: "" })}>
                Change it
              </button>
            </p>
          ) : (
            <div className="link-option-detail">
              <div className="input-with-action">
                <input
                  className="input"
                  type={reveal ? "text" : "password"}
                  aria-label="Link password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={LIMITS.linkPasswordMax}
                  placeholder={`At least ${LIMITS.linkPasswordMin} characters`}
                  value={value.password ?? ""}
                  aria-invalid={(!!problem && !!value.password) || undefined}
                  onChange={(e) => set({ password: e.target.value })}
                  autoFocus
                />
                <IconButton
                  label={reveal ? "Hide password" : "Show password"}
                  icon={reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                  onClick={() => setReveal(!reveal)}
                />
              </div>
              <p className="field-hint">Tell it to the people you share with. It can’t be shown again.</p>
            </div>
          ))}
      </div>

      <Toggle
        label={limit && limit > 1 ? `Only ${limit} people` : "One person only"}
        description={
          seen === 0
            ? "The first person to open it keeps access. Nobody else can open it."
            : seen === 1
              ? "The person who opened it keeps access. Nobody else can open it."
              : `The ${seen} people who opened it keep access. Nobody new can open it.`
        }
        checked={limit !== null}
        onChange={(on) => set({ visitorLimit: on ? (limit ?? 1) : null })}
      />

      {noteOpen ? (
        <label className="field">
          <span className="field-label">Note</span>
          <textarea
            className="input"
            rows={2}
            maxLength={LIMITS.linkNoteLength}
            placeholder="What it is, or anything they should know"
            value={note}
            onChange={(e) => set({ note: e.target.value })}
            autoFocus={!note}
          />
          <span className="field-hint">Shown with the files, next to your name.</span>
        </label>
      ) : (
        <button type="button" className="link link-option-add" onClick={() => setNoteOpen(true)}>
          <Plus size={14} aria-hidden /> Add a note
        </button>
      )}
    </div>
  );
}

/**
 * Who opened a link: one line, which opens the list of people (as browsers, by device) when there
 * is anyone to list. Nothing identifying is kept, so a device label is all there is.
 */
export function LinkReach({ link }: { link: Pick<Link, "id" | "visitors" | "downloads" | "lastVisit" | "full"> }) {
  const [open, setOpen] = useState(false);
  const visits = useLive(open ? api.links.visits : null, { params: { id: link.id } }, ["links"], []);
  if (!link.visitors) return <span className="link-reach muted">{linkReach(link)}</span>;
  return (
    <div className="link-reach">
      <button type="button" className="link-reach-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{linkReach(link)}</span>
        <ChevronDown size={14} aria-hidden className="link-reach-chevron" />
      </button>
      {open &&
        (visits.loading && !visits.data.length ? (
          <Spinner label="Loading who opened it" />
        ) : visits.error ? (
          <p className="field-error">{visits.error}</p>
        ) : (
          <ul className="link-visits">
            {visits.data.map((v) => (
              <li key={v.id}>
                <strong>{v.device}</strong>
                <span className="muted">
                  {[
                    `Opened ${ago(v.first)}`,
                    v.downloads ? `downloaded ${v.downloads === 1 ? "once" : `${v.downloads} times`}` : "",
                    v.last - v.first > 60_000 ? `last here ${ago(v.last)}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * The options of the next link, behind one quiet button that says what they are ("7 days ·
 * Password"). They can be chosen before there is anything to send.
 */
export function NewLinkOptions({
  value,
  onChange,
  open,
  onOpenChange,
  error,
}: {
  value: NewLinkChoice;
  onChange: (next: NewLinkChoice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Why the link can't be made as set, shown when trying to. */
  error?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const [tried, setTried] = useState(false);
  const problem = linkChoiceProblem(value);
  const shown = error || (tried ? problem : null);
  const summary = newLinkSummary(value);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn btn-ghost btn-sm link-options-trigger"
        aria-label={`Link options: ${summary}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{summary}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <Popover
          anchor={anchor}
          label="Link options"
          align="start"
          flip
          onClose={close}
          className="link-options-popover"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (!problem) close();
            }}
          >
            <LinkOptionsFields
              value={value}
              onChange={(next) => {
                setTried(false);
                onChange({ ...value, ...next });
              }}
            />
            {shown && (
              <p className="field-error" role="alert">
                {shown}
              </p>
            )}
            <div className="row end">
              <Button size="sm" variant="primary" type="submit">
                Done
              </Button>
            </div>
          </form>
        </Popover>
      )}
    </>
  );
}
