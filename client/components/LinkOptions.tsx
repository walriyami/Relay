import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Eye, EyeOff, Plus, SlidersHorizontal } from "lucide-react";
import { LIMITS, api, type Link } from "../api";
import { ago, dateTime, plural, until } from "../lib/format";
import { useLive } from "../lib/live";
import { days as dayLabel, fromSegment, limitHint, linkLifeOptions, toSegment } from "../lib/options";
import { useSession } from "../app/session";
import { Button, IconButton, Popover, Segmented, Spinner, Toggle } from "./ui";

import { boundedOptions, effectiveExpiry } from "../lib/lifecycle";

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

/** Keep the submitted draft and its preview within a live cap, without restoring discarded choices. */
export function useLinkChoiceLimit<T extends LinkChoice>(choice: T, onChange: (next: T) => void): T {
  const max = useSession().me.user.limits.linkDays;
  const days =
    choice.days === undefined ? undefined : choice.days === null ? max : Math.min(choice.days, max ?? Infinity);
  useEffect(() => {
    if (days !== choice.days) onChange({ ...choice, days });
  }, [choice, days, onChange]);
  return days === choice.days ? choice : { ...choice, days };
}
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
  if (o.visitorLimit) traits.push(o.visitorLimit === 1 ? "One browser" : `${o.visitorLimit} browsers`);
  if (o.note.trim()) traits.push("Note");
  return traits;
}

/**
 * "Expires in 7 days · Password": the next link, described the way an existing one is. It wraps
 * between settings, never inside one.
 */
export function NewLinkSummary({ value: c, itemDeadline }: { value: NewLinkChoice; itemDeadline?: number | null }) {
  const max = useSession().me.user.limits.linkDays;
  const expiry = effectiveExpiry(c.days === null ? max : Math.min(c.days, max ?? Infinity), itemDeadline);
  const parts = [
    expiry === null
      ? "Never expires"
      : itemDeadline
        ? `Expires by ${dateTime(expiry)}`
        : `Expires in ${dayLabel(Math.min(c.days ?? Infinity, max ?? Infinity))}`,
    ...linkTraits({ locked: c.password !== null, visitorLimit: c.visitorLimit, note: c.note }),
  ];
  // Each setting keeps the dot after it, so a line only ever breaks at the space that follows.
  return (
    <span>
      {parts.map((part, i) => (
        <Fragment key={part}>
          {i > 0 && " "}
          <span className="link-summary-part">{i < parts.length - 1 ? `${part} ·` : part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** "Expires in 6 days", "Never expires". */
export const linkLife = (expires: number | null, now = Date.now()) =>
  expires === null ? "Never expires" : `Expires ${until(expires, now)}`;

/** "Not opened yet", "Opened by 2 people · 3 downloads · 5 min ago". */
export function linkReach(l: Pick<Link, "visitors" | "downloads" | "lastVisit" | "full">, now = Date.now()) {
  if (!l.visitors) return "Not opened yet";
  const parts = [`Opened by ${plural(l.visitors, "browser")}`];
  if (l.downloads) parts.push(plural(l.downloads, "download"));
  if (l.lastVisit) parts.push(ago(l.lastVisit, now));
  if (l.full) parts.push("no new browsers can open it");
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
  itemDeadline,
  attempted = false,
  actions,
}: {
  value: LinkChoice;
  onChange: (next: LinkChoice) => void;
  current?: Current;
  itemDeadline?: number | null;
  /** Using the options was tried, so what's missing is pointed out where it's missing. */
  attempted?: boolean;
  /** Buttons that end the options, on the line "Add a note" sits on. */
  actions?: ReactNode;
}) {
  const set = (patch: LinkChoice) => onChange({ ...value, ...patch });
  // The longest a link may work, when the administrator set one.
  const max = useSession().me.user.limits.linkDays;
  const [reveal, setReveal] = useState(false);
  const [noteOpen, setNoteOpen] = useState(!!(value.note ?? current?.note));
  const now = Date.now();
  const expiry =
    value.days === undefined
      ? (current?.expires ?? null)
      : effectiveExpiry(value.days === null ? max : Math.min(value.days, max ?? Infinity), itemDeadline, now);
  const life = expiry === null ? "Works until you turn it off." : `Until ${dateTime(expiry)}.`;

  const keptPassword = value.password === undefined && !!current?.locked;
  const hasPassword = value.password === undefined ? !!current?.locked : value.password !== null;
  const limit = value.visitorLimit === undefined ? (current?.visitorLimit ?? null) : value.visitorLimit;
  const seen = current?.visitors ?? 0;
  const note = value.note ?? current?.note ?? "";
  const problem = linkChoiceProblem(value);
  const passwordHint = useId();
  return (
    <div className="link-options">
      <div className="stack-sm">
        <span className="link-option-title">Expires</span>
        <Segmented
          label="Expires"
          value={value.days === undefined ? -1 : toSegment(value.days)}
          options={boundedOptions(linkLifeOptions(value.days, max), itemDeadline, now)}
          onChange={(v) => set({ days: fromSegment(v) })}
        />
        <p className="field-hint">
          {life}
          {itemDeadline != null && ` The item expires on ${dateTime(itemDeadline)}; its links cannot last longer.`}
          {max !== null && ` ${limitHint(max)}`}
        </p>
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
                  aria-invalid={(!!problem && (attempted || !!value.password)) || undefined}
                  aria-describedby={passwordHint}
                  onChange={(e) => set({ password: e.target.value })}
                  autoFocus
                />
                <IconButton
                  label={reveal ? "Hide password" : "Show password"}
                  icon={reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                  onClick={() => setReveal(!reveal)}
                />
              </div>
              {attempted && problem ? (
                <p id={passwordHint} className="field-error" role="alert">
                  {problem}
                </p>
              ) : (
                <p id={passwordHint} className="field-hint">
                  Tell it to the people you share with. It can’t be shown again.
                </p>
              )}
            </div>
          ))}
      </div>

      <Toggle
        label={limit && limit > 1 ? `Only ${limit} browsers` : "One browser only"}
        description={`Visitors are recognised by browser cookies. ${seen ? `The ${seen} previously admitted browser${seen === 1 ? "" : "s"} keep access when the limit is reduced.` : "The first browser to open it keeps access."} Clearing cookies or switching browsers counts as a new visitor. Downloads already started may finish.`}
        checked={limit !== null}
        onChange={(on) => set({ visitorLimit: on ? (limit ?? 1) : null })}
      />

      {noteOpen && (
        <label className="field">
          <span className="link-option-title">Note</span>
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
      )}
      {(!noteOpen || actions) && (
        <div className="link-options-end">
          {!noteOpen && (
            <button type="button" className="link link-option-add" onClick={() => setNoteOpen(true)}>
              <Plus size={14} aria-hidden /> Add a note
            </button>
          )}
          {actions && <div className="link-options-actions">{actions}</div>}
        </div>
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
 * The settings of the next link, behind the button at the end of the Create link row, whose
 * description says what they are. They can be chosen before there is anything to send.
 */
export function NewLinkOptions({
  value,
  onChange,
  open,
  onOpenChange,
  attempted = false,
  itemDeadline,
}: {
  value: NewLinkChoice;
  itemDeadline?: number | null;
  onChange: (next: NewLinkChoice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A link was asked for as set, so what stops it is pointed out. */
  attempted?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const [tried, setTried] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-label="Link settings"
        title="Link settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <SlidersHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <Popover
          anchor={anchor}
          label="Link settings"
          align="end"
          flip
          onClose={close}
          className="link-options-popover"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (!linkChoiceProblem(value)) close();
            }}
          >
            <LinkOptionsFields
              value={value}
              itemDeadline={itemDeadline}
              onChange={(next) => {
                setTried(false);
                onChange({ ...value, ...next });
              }}
              attempted={attempted || tried}
              actions={
                <Button size="sm" variant="primary" type="submit">
                  Done
                </Button>
              }
            />
          </form>
        </Popover>
      )}
    </>
  );
}
