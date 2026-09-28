// "Make it yours": a member's own choices, asked once when they join and again of the administrator
// at first start. Each is what Settings asks later, within the limits the member was given.
import { useState, type ReactNode } from "react";
import { Check, Clock, Link2, Trash2, UserRound } from "lucide-react";
import { api, call, type Me } from "../../api";
import { LIMITS } from "../../../shared/model";
import type { SetMe } from "../../app/session";
import { fromSegment, keepOptions, limitHint, linkLifeOptions, toSegment, trashOptions } from "../../lib/options";
import { setTransferPrefs } from "../../lib/transfers";
import { Button, Segmented } from "../../components/ui";
import { Question, StepTitle } from "./Walkthrough";

export function YoursStep({
  me,
  setMe,
  resumed,
  storage,
  check,
  finish,
  onSaved,
}: {
  me: Me;
  setMe: SetMe;
  /** Opened again after leaving part way: says the account is made and only choices are left. */
  resumed: boolean;
  /** The last line of the card: how much space there is. */
  storage: ReactNode;
  /** Whether what `storage` asks is ready to save; false once it has said why not. */
  check?: () => boolean;
  /** Runs after the choices are saved, before moving on. */
  finish?: () => Promise<void>;
  onSaved: () => void;
}) {
  const { limits } = me.user;
  const [name, setName] = useState(me.user.name ?? "");
  const [retention, setRetention] = useState(toSegment(me.user.retentionDays));
  const [linkDays, setLinkDays] = useState(toSegment(me.prefs.linkDays));
  const [trashDays, setTrashDays] = useState(me.user.trashDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (check && !check()) return;
    // Only what changed is sent; choosing nothing new is fine too.
    const body = {
      ...(name.trim() !== (me.user.name ?? "") && { name: name.trim() || null }),
      ...(fromSegment(retention) !== me.user.retentionDays && { retentionDays: fromSegment(retention) }),
      ...(trashDays !== me.user.trashDays && { trashDays }),
      ...(fromSegment(linkDays) !== me.prefs.linkDays && { prefs: { linkDays: fromSegment(linkDays) } }),
    };
    setBusy(true);
    try {
      if (Object.keys(body).length) {
        const { prefs, user } = await call(api.account.update, { body });
        setMe((current) => ({ ...current, prefs, user }));
        setTransferPrefs(prefs);
      }
      await finish?.();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      {resumed && (
        <p className="setup-welcome-back" role="status">
          <Check size={16} aria-hidden /> Welcome back. A few choices are left.
        </p>
      )}
      <StepTitle>Make it yours</StepTitle>
      <p className="setup-lead">These work well for most people. Change what you like, now or any time in Settings.</p>
      <form className="setup-card card-surface setup-questions" noValidate onSubmit={save}>
        <Question
          icon={<UserRound size={18} />}
          title="Your name"
          htmlFor="yours-name"
          hint={`People you share with see this. Leave it empty to show your username, ${me.user.username}.`}
        >
          <input
            id="yours-name"
            className="input"
            autoComplete="name"
            maxLength={LIMITS.displayNameLength}
            placeholder={me.user.username}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Question>
        <Question
          icon={<Link2 size={18} />}
          title="Links expire after"
          hint={
            limits.linkDays === null
              ? "You can still choose differently for any link when you share it."
              : `You can choose a shorter time for any link. ${limitHint(limits.linkDays)}`
          }
        >
          <Segmented
            label="Links expire after"
            value={linkDays}
            options={linkLifeOptions(fromSegment(linkDays), limits.linkDays)}
            onChange={setLinkDays}
          />
        </Question>
        <Question
          icon={<Clock size={18} />}
          title="Move uploads to Trash after"
          hint={
            limits.keepDays === null
              ? "Never keeps them until you delete them."
              : `Counted from when each upload arrives. ${limitHint(limits.keepDays)}`
          }
        >
          <Segmented
            label="Move uploads to Trash after"
            value={retention}
            options={keepOptions(fromSegment(retention), limits.keepDays)}
            onChange={setRetention}
          />
        </Question>
        <Question
          icon={<Trash2 size={18} />}
          title="Empty Trash after"
          hint="Until then, anything in Trash can be restored."
        >
          <Segmented
            label="Empty Trash after"
            value={trashDays}
            options={trashOptions(trashDays)}
            onChange={setTrashDays}
          />
        </Question>
        {storage}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="setup-cta" busy={busy}>
          Save and continue
        </Button>
      </form>
    </>
  );
}
