import { useEffect, useRef, useState } from "react";
import { Pencil, UserMinus, UserPlus } from "lucide-react";
import {
  ApiError,
  api,
  call,
  displayName,
  LIMITS,
  type AdminMember,
  type AdminOverview as Overview,
  type LimitsApplied,
  type MemberLimits,
  type PendingInvite,
} from "../../api";
import { USERNAME } from "../../../shared/model";
import { useSession } from "../../app/session";
import { ago, bytes, dateTime, plural } from "../../lib/format";
import { storageSummary } from "../../components/StorageMeter";
import { notifyChange, useLive } from "../../lib/live";
import { usePeriodicRefresh } from "../../lib/refresh";
import { navigate, useRoute } from "../../lib/router";
import { days } from "../../lib/options";
import {
  Button,
  CopyButton,
  Field,
  InlineEmpty,
  LoadFailed,
  Modal,
  PageLink,
  ProgressBar,
  Spinner,
  Toggle,
  confirmDialog,
  promptDialog,
  toast,
} from "../../components/ui";
import { ByteSizeField, changedBytes, toDraft } from "./ByteSize";
import { AdminOverview, HealthNotice } from "./AdminOverview";
import { InviteDialog, LimitsFields, limitsSummary, useLimitsForm } from "./Limits";
import { UserText } from "../../components/UserText";

const errorToast = (e: unknown) => toast((e as Error).message, { tone: "error" });

const TABS = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/members", label: "Members" },
  { to: "/admin/settings", label: "Settings" },
] as const;

/** Only reachable by the administrator: the app shows members "Page not found" instead. */
export function AdminPage() {
  const route = useRoute().replace(/\/+$/, "");
  const tab = TABS.find((t) => t.to === route);
  // Storage and member usage move with every upload; a join or suspension changes "account".
  const { data, error, reload } = useLive(api.admin.overview, {}, ["items", "account", "codes"], null);
  usePeriodicRefresh(reload);
  const invites = useLive(api.admin.invites, {}, ["account"], [] as PendingInvite[]);
  const [inviting, setInviting] = useState<PendingInvite | "new" | null>(null);
  useEffect(() => {
    if (!tab) navigate("/admin", true);
  }, [tab]);
  return (
    <div className="page admin">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="muted">What’s happening on this Relay, who uses it, and how it’s set up.</p>
        </div>
        <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setInviting("new")}>
          Invite member
        </Button>
      </div>
      <nav className="page-tabs" aria-label="Admin">
        {TABS.map((t) => (
          <PageLink
            key={t.to}
            to={t.to}
            className={`page-tab${t === tab ? " is-active" : ""}`}
            aria-current={t === tab ? "page" : undefined}
          >
            {t.label}
          </PageLink>
        ))}
      </nav>
      {error && <LoadFailed banner={!!data} error={error} onRetry={reload} />}
      {!data ? (
        !error && <Spinner />
      ) : (
        <>
          {/* The overview says it in full; other tabs point back to it. */}
          {tab?.to !== "/admin" && <HealthNotice data={data} />}
          {tab?.to === "/admin" && <AdminOverview data={data} invites={invites.data.length} />}
          {tab?.to === "/admin/members" && (
            <>
              <Members data={data} onChanged={reload} />
              <Invitations
                invites={invites.data}
                loading={invites.loading}
                error={invites.error}
                onEdit={setInviting}
                onChanged={invites.reload}
              />
            </>
          )}
          {tab?.to === "/admin/settings" && (
            <>
              <section className="settings-section card-surface" aria-labelledby="admin-capacity">
                <div className="settings-section-head">
                  <h2 id="admin-capacity">Total storage</h2>
                  <p className="muted">The most everyone can keep together, Trash included.</p>
                </div>
                {/* Keep the editor mounted so a live policy update preserves an unsaved draft. */}
                <Capacity data={data} onSaved={reload} />
              </section>
              <section className="settings-section card-surface" aria-labelledby="admin-codes">
                <div className="settings-section-head">
                  <h2 id="admin-codes">Codes</h2>
                  <p className="muted">
                    Codes for sign-ins, shares, upload requests and invitations are six digits and work for a day. Links
                    and QR codes don’t change.
                  </p>
                </div>
                {data.codeAttackAt && (
                  <p className="notice">
                    Someone tried many wrong codes on {dateTime(data.codeAttackAt)}. Each network got only a few tries,
                    and codes kept working for everyone else.
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}
      {inviting && (
        <InviteDialog
          invite={
            inviting === "new" ? undefined : (invites.data.find((invite) => invite.id === inviting.id) ?? inviting)
          }
          onClose={() => setInviting(null)}
          onRefresh={invites.reload}
          onSaved={() => {
            invites.reload();
            if (inviting !== "new") toast("Invitation saved");
          }}
        />
      )}
    </div>
  );
}

function Members({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const { me } = useSession();
  const [managing, setManaging] = useState<string | null>(null);
  // The dialog follows the live list, so what it shows is never older than the page behind it.
  const member = data.members.find((m) => m.id === managing);
  return (
    <section className="settings-section card-surface" aria-labelledby="admin-members">
      <div className="settings-section-head">
        <h2 id="admin-members">Members</h2>
        <p className="muted">
          {plural(data.members.length, "member")}. Each chooses their own settings, within any limits you set.
        </p>
      </div>
      <ul className="list member-list">
        {data.members.map((u) => {
          const used = u.usage.used + u.usage.reserved;
          return (
            <li key={u.id} className="list-row member-row">
              <span className="avatar" aria-hidden>
                {displayName(u)[0]?.toUpperCase()}
              </span>
              <span className="list-text static">
                <span className="member-name">
                  <strong>
                    <UserText>{displayName(u)}</UserText>
                  </strong>
                  {u.id === me.user.id && <span className="muted"> (you)</span>}
                  {u.admin && <span className="pill">Administrator</span>}
                  {u.disabled && (
                    <span className="pill danger">{u.removalStopped ? "Removal didn’t finish" : "Suspended"}</span>
                  )}
                  {u.walriyami && <span className="pill">Walriyami</span>}
                </span>
                <span className="muted">
                  {u.name && `${u.username} · `}
                  {storageSummary(u.usage, u.limits.storage)}
                  {" · "}
                  {u.lastActive ? `active ${ago(u.lastActive)}` : "never signed in on a device"}
                </span>
                {u.limits.storage !== null && (
                  <span className="member-usage">
                    <ProgressBar
                      value={used}
                      max={u.limits.storage}
                      label={`Storage used by ${displayName(u)}`}
                      minVisible
                    />
                  </span>
                )}
                <span className="member-limits">
                  {u.admin ? "No limits, as administrator" : limitsSummary(u.limits)}
                </span>
              </span>
              <Button size="sm" aria-label={`Manage ${u.username}`} onClick={() => setManaging(u.id)}>
                Manage
              </Button>
            </li>
          );
        })}
      </ul>
      {member && (
        <ManageMember
          member={member}
          self={member.id === me.user.id}
          lastAdmin={member.admin && data.members.filter((m) => m.admin).length === 1}
          onClose={() => setManaging(null)}
          onChanged={onChanged}
          onSaved={() => {
            setManaging(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function Invitations({
  invites,
  loading,
  error,
  onEdit,
  onChanged,
}: {
  invites: PendingInvite[];
  loading: boolean;
  error: string;
  onEdit: (invite: PendingInvite) => void;
  onChanged: () => void;
}) {
  async function withdraw(invite: PendingInvite) {
    const ok = await confirmDialog({
      title: "Withdraw this invitation?",
      body: "Its link stops working at once. You can invite the person again with a new link.",
      confirm: "Withdraw",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(api.admin.revokeInvite, { params: { id: invite.id } });
      toast("Invitation withdrawn");
    } catch (e) {
      errorToast(e);
    }
    onChanged();
  }
  return (
    <section className="settings-section card-surface" aria-labelledby="admin-invites">
      <div className="settings-section-head">
        <h2 id="admin-invites">Invitations</h2>
        <p className="muted">Links not used yet. Each creates one account; its limits can change until then.</p>
      </div>
      {error && <LoadFailed banner error={error} onRetry={onChanged} />}
      {invites.length ? (
        <ul className="list" aria-label="Open invitations">
          {invites.map((i) => (
            <li key={i.id} className="list-row invite-row">
              <span className="list-text static">
                <strong>
                  {i.note ? (
                    <>
                      For <UserText>{i.note}</UserText>
                    </>
                  ) : (
                    "Invitation"
                  )}
                </strong>
                <span className="muted">
                  Expires {dateTime(i.expires)} · created {ago(i.created)} by <UserText>{i.createdBy}</UserText>
                </span>
                <span className="member-limits">{limitsSummary(i.limits)}</span>
                {i.code && (
                  <span>
                    <span className="code">{i.code}</span>{" "}
                    <CopyButton value={i.code} label="Copy invitation code" variant="ghost" size="sm" iconOnly />
                  </span>
                )}
              </span>
              <span className="row-actions">
                <Button
                  size="sm"
                  icon={<Pencil size={14} />}
                  aria-label={`Edit invitation${i.note ? ` for ${i.note}` : ""}`}
                  onClick={() => onEdit(i)}
                >
                  Edit
                </Button>
                <Button size="sm" onClick={() => void withdraw(i)}>
                  Withdraw
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <Spinner />
      ) : (
        !error && (
          <InlineEmpty icon={<UserPlus size={20} />} title="No open invitations">
            New invitations will appear here until someone joins or they expire.
          </InlineEmpty>
        )
      )}
    </section>
  );
}

function Capacity({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  const { capacity } = data.limits;
  const [draft, setDraft] = useState(() => toDraft(capacity));
  const [baseline, setBaseline] = useState(capacity);
  const stale = capacity !== baseline;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Undefined while untouched, so an unchanged value is never rewritten; null when invalid.
  const change = changedBytes(draft, baseline);
  const used = data.storage.used + data.storage.reserved;
  return (
    <form
      className="stack-sm"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (stale) return setError("Total storage changed. Review the current capacity before saving your draft.");
        if (change === null) return setError("Enter a size greater than zero.");
        setBusy(true);
        try {
          await call(api.admin.settings, { body: { capacity: change, expectedCapacity: baseline } });
          if (change !== undefined && change !== null) setBaseline(change);
          toast("Total storage saved");
          onSaved();
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) onSaved();
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <ByteSizeField
          label="Total storage"
          hint={`${bytes(data.storage.used)} saved${data.storage.reserved > 0 ? ` · ${bytes(data.storage.reserved)} uploading` : ""} · ${bytes(data.storage.diskFree)} free on disk.${used > capacity ? " Over the total storage limit." : ""}`}
          draft={draft}
          original={baseline}
          onChange={setDraft}
          invalid={change === null}
        />
      </div>
      {stale && (
        <p className="notice" role="alert">
          Total storage changed to {bytes(capacity)}. Your draft is preserved.{" "}
          <button type="button" className="link" onClick={() => setBaseline(capacity)}>
            Use my draft with this current capacity
          </button>
        </p>
      )}
      {change && change < used && (
        <p className="notice">
          Below the saved and reserved total. New uploads are blocked until usage is under {bytes(change)}. Accepted
          uploads can finish; nothing is removed.
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" busy={busy} disabled={change === undefined}>
          Save total storage
        </Button>
      </div>
    </form>
  );
}

/** "They'll be signed out on 2 devices", or that they aren't signed in anywhere. */
const signOutConsequence = (m: AdminMember) =>
  m.signedInDevices
    ? `${m.username} will be signed out on ${plural(m.signedInDevices, "device")} right away.`
    : `${m.username} isn’t signed in anywhere right now.`;

/** A limit is tighter when there was none, or the new one is smaller. */
const tighter = (now: number | null, before: number | null) => now !== null && (before === null || now < before);

/** What saving tighter day limits does to what the member already has, in a sentence each. */
function tighteningEffects(limits: MemberLimits, before: MemberLimits) {
  return [
    tighter(limits.linkDays, before.linkDays) &&
      `Their shared links and upload-request URLs that would work longer now expire within ${days(limits.linkDays!)}.`,
    tighter(limits.keepDays, before.keepDays) &&
      `Maximum total file age becomes ${days(limits.keepDays!)} from the first saved content. Existing files and Trash are included, with no grace beyond the hard deadline.`,
  ].filter((effect): effect is string => !!effect);
}

/** "Saved. 3 links and 1 upload now end sooner." */
function appliedMessage(applied: LimitsApplied) {
  const parts = [
    applied.links && plural(applied.links, "link"),
    applied.items && plural(applied.items, "item"),
    applied.requests && plural(applied.requests, "request"),
  ];
  const said = parts.filter(Boolean).join(" and ");
  return said ? `Saved. ${said} now end sooner.` : "Saved";
}

function ManageMember({
  member,
  self,
  lastAdmin,
  onClose,
  onChanged,
  onSaved,
}: {
  member: AdminMember;
  self: boolean;
  /** Relay always keeps one administrator, so the only one can't stop being one. */
  lastAdmin: boolean;
  onClose: () => void;
  /** Something was saved but the dialog stays open. */
  onChanged: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(member.name ?? "");
  const [username, setUsername] = useState(member.username);
  const limits = useLimitsForm(member.limits);
  const [disabled, setDisabled] = useState(member.disabled);
  const [admin, setAdmin] = useState(member.admin);
  // A role change saves on its own: Relay clears limits with it, and an administrator can't be suspended.
  const roleChange = admin !== member.admin ? admin : undefined;
  const limited = !member.admin && roleChange === undefined;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputs = {
    username: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };
  const cleanUsername = username.trim().toLowerCase();
  // Only edited fields are sent.
  const changes = {
    name: name.trim() !== (member.name ?? "") ? name.trim() || null : undefined,
    username: cleanUsername !== member.username ? cleanUsername : undefined,
    limits: limited && limits.changed && limits.limits ? limits.limits : undefined,
    // Making a suspended member an administrator lifts the suspension in the same step.
    disabled: roleChange && member.disabled ? false : limited && disabled !== member.disabled ? disabled : undefined,
    admin: roleChange,
  };
  const changed = Object.values(changes).some((v) => v !== undefined) || limits.limits === null || !!password;
  function fail(message: string, field?: keyof typeof inputs) {
    setError(message);
    if (field) inputs[field].current?.focus();
  }
  async function save() {
    setError("");
    if (limits.stale)
      return setError("Limits changed while this dialog was open. Review the current limits before saving your draft.");
    if (changes.username !== undefined && !USERNAME.test(changes.username))
      return fail("Use 3 to 32 lowercase letters, numbers, - or _, starting with a letter or number.", "username");
    if (limited && limits.limits === null) return setError("Enter a storage limit more than zero, or choose No limit.");
    if (password && password.length < LIMITS.passwordMin) {
      return fail(`The new password needs at least ${LIMITS.passwordMin} characters.`, "password");
    }
    const suspending = changes.disabled === true;
    const effects = changes.limits ? tighteningEffects(changes.limits, member.limits) : [];
    if (roleChange !== undefined) {
      const ok = await confirmDialog(roleConfirmation(member, roleChange, self, !!password));
      if (!ok) return;
    } else if (suspending || password || effects.length) {
      const title = suspending
        ? password
          ? `Suspend ${member.username} and set a new password?`
          : `Suspend ${member.username}?`
        : password
          ? `Set a new password for ${member.username}?`
          : `Tighten ${member.username}’s limits?`;
      const body = [
        (suspending || password) && signOutConsequence(member),
        suspending &&
          "Sign-in and existing share and request tokens are blocked during suspension. Re-enabling access resumes tokens that are still valid. File, token and upload expiry clocks continue during suspension.",
        password && "Their passkeys are removed. Tell them the new password yourself.",
        ...effects,
      ]
        .filter(Boolean)
        .join(" ");
      const ok = await confirmDialog({
        title,
        body,
        confirm: suspending ? "Suspend" : password ? "Set password" : "Tighten limits",
        danger: suspending || !!password,
      });
      if (!ok) return;
    }
    setBusy(true);
    let saved = false;
    try {
      let applied: LimitsApplied = { links: 0, items: 0, requests: 0 };
      if (Object.values(changes).some((v) => v !== undefined)) {
        applied = await call(api.admin.updateMember, {
          params: { id: member.id },
          body: { ...changes, ...(changes.limits ? { expectedLimits: limits.baseline } : {}) },
        });
        saved = true;
      }
      if (password) await call(api.admin.resetPassword, { params: { id: member.id }, body: { password } });
      const now = changes.username ?? member.username;
      toast(
        roleChange !== undefined
          ? self
            ? "You’re no longer an administrator"
            : `${now} is ${roleChange ? "now an administrator" : "no longer an administrator"}`
          : suspending
            ? `${now} is suspended`
            : changes.username
              ? `Saved. ${self ? "You sign" : "They sign"} in as ${now} from now on.`
              : appliedMessage(applied),
      );
      onSaved();
      // Admin is closed to members, so leave it rather than land on "Page not found".
      if (self && roleChange === false) {
        notifyChange("account");
        navigate("/", true);
      }
    } catch (e) {
      if (saved) {
        // The member's other changes are in; only the password is left to retry.
        onChanged();
        setError(`Your other changes were saved, but the password wasn’t changed: ${(e as Error).message}`);
      } else if (e instanceof ApiError && e.status === 409) {
        if (changes.limits) {
          onChanged();
          setError(e.message);
        } else fail(e.message, "username");
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Manage ${member.username}${self ? " (you)" : ""}`}
      subtitle={`Joined ${dateTime(member.created)} · ${member.lastActive ? `active ${ago(member.lastActive)}` : "never signed in on a device"}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="manage-member" busy={busy} disabled={!changed}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="manage-member"
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void save();
        }}
      >
        <div className="form-grid">
          <Field
            label="Name"
            hint={
              self
                ? "What people you share with see. Empty shows your username."
                : "What people they share with see. Empty shows their username."
            }
          >
            <input
              className="input"
              maxLength={LIMITS.displayNameLength}
              placeholder={member.username}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Username"
            hint={self ? "What you sign in with." : "What they sign in with. Their devices and passkeys keep working."}
          >
            <input
              ref={inputs.username}
              className="input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              maxLength={32}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
        </div>
        <Toggle
          label="Administrator"
          description={
            lastAdmin
              ? `${self ? "You’re" : `${member.username} is`} the only administrator. Make someone else an administrator first to turn this off.`
              : "Can manage members, storage and settings, and has no limits."
          }
          checked={admin}
          disabled={lastAdmin}
          onChange={setAdmin}
        />
        {roleChange !== undefined ? (
          <p className="field-hint">
            {roleChange
              ? "Administrators have no limits, so saving removes any limits set for this member."
              : "Saving leaves them with no limits. Open Manage again afterwards to set some."}
          </p>
        ) : member.admin ? (
          <p className="field-hint">
            Administrators have no limits. Storage is shared with everyone, up to the total storage in Settings.
          </p>
        ) : (
          <div className="limits-panel">
            <div className="limits-panel-head">
              <strong>Limits</strong>
              <span className="muted">{storageSummary(member.usage, member.limits.storage)}</span>
            </div>
            {limits.stale && (
              <p className="notice" role="alert">
                Limits changed while this dialog was open. Your draft is preserved. Current limits:{" "}
                {limitsSummary(member.limits)}.{" "}
                <button type="button" className="link" onClick={limits.acceptCurrent}>
                  Use my draft with these current limits
                </button>
              </p>
            )}
            <LimitsFields
              draft={limits.draft}
              onChange={limits.setDraft}
              used={member.usage.used + member.usage.reserved}
              invalid={limits.limits === null}
            />
          </div>
        )}
        {limited && (
          <Toggle
            label="Suspend access"
            description="Signs the member out and pauses their share and request tokens. Turning suspension off resumes tokens that are still valid. Expiry clocks continue during suspension."
            checked={disabled}
            onChange={setDisabled}
          />
        )}
        {self ? (
          <p className="field-hint">
            To change your own password, use <PageLink to="/settings">Settings</PageLink>.
          </p>
        ) : (
          <Field
            label="Set a new password"
            hint={`Optional. At least ${LIMITS.passwordMin} characters. Signs the member out everywhere.`}
          >
            <input
              ref={inputs.password}
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={LIMITS.passwordMin}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
      {!self && <RemoveMember member={member} onRemoved={onSaved} />}
    </Modal>
  );
}

/** Granting the role hands over everything; taking it away from yourself locks you out of Admin. */
function roleConfirmation(member: AdminMember, admin: boolean, self: boolean, password: boolean) {
  const also = password ? " The new password is saved too, and they’re signed out everywhere." : "";
  if (admin)
    return {
      title: `Make ${member.username} an administrator?`,
      body: `They’ll be able to invite and remove members, set passwords, change storage and every Admin setting, including taking this role away from you. Administrators have no limits, so their limits are removed.${member.disabled ? " Their suspension is lifted." : ""}${also}`,
      confirm: "Make administrator",
      danger: true,
    };
  if (self)
    return {
      title: "Stop being an administrator?",
      body: "You’ll lose Admin straight away and become a member with no limits. Only another administrator can give the role back.",
      confirm: "Stop being administrator",
      danger: true,
    };
  return {
    title: `Remove ${member.username}’s administrator role?`,
    body: `They keep their account and files, and lose Admin straight away. They’ll have no limits until you set some.${also}`,
    confirm: "Remove role",
    danger: true,
  };
}

/**
 * Deleting an account is the one thing here that can't be taken back, so the confirmation says in
 * numbers what goes with it and asks for the username, the way a careful person would double-check.
 */
function RemoveMember({ member, onRemoved }: { member: AdminMember; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    let removal;
    try {
      removal = await call(api.admin.removal, { params: { id: member.id } });
    } catch (e) {
      return errorToast(e);
    } finally {
      setBusy(false);
    }
    const name = member.username;
    const removed = await promptDialog({
      title: `Remove ${name}?`,
      body: (
        <div className="stack-sm removal-body">
          <ul className="removal-list">
            <li>
              {removal.items
                ? `${plural(removal.items, "item")} in their Files and Trash ${removal.items === 1 ? "is" : "are"} deleted, freeing ${bytes(removal.bytes)} for everyone.`
                : "They have no files, so no space is freed."}
            </li>
            {removal.links + removal.requests > 0 && (
              <li>
                {[
                  removal.links && plural(removal.links, "shared link"),
                  removal.requests && plural(removal.requests, "upload request"),
                ]
                  .filter(Boolean)
                  .join(" and ")}{" "}
                stop working. Anyone opening them sees that they’re gone.
              </li>
            )}
            <li>
              {removal.devices
                ? `They’re signed out on ${plural(removal.devices, "device")} at once.`
                : "They aren’t signed in anywhere right now."}
            </li>
          </ul>
          <p>
            <strong>This can’t be undone.</strong> If they want a copy, ask them to use Download all my files in
            Settings › Storage first. Someone who signs in through Walriyami and still has access there would come back
            as a new, empty account.
          </p>
        </div>
      ),
      label: `Type ${name} to confirm`,
      value: "",
      confirm: "Remove member",
      danger: true,
      apply: async (typed) => {
        if (typed.trim().toLowerCase() !== name) throw new Error(`Type ${name} exactly to remove this member.`);
        await call(api.admin.removeMember, { params: { id: member.id } });
      },
    });
    if (removed === null) return;
    toast(`${name} was removed`, {
      detail: removal.bytes ? `${bytes(removal.bytes)} freed` : undefined,
    });
    notifyChange("items");
    onRemoved();
  }
  return (
    <div className="setting-row danger-zone">
      <span className="setting-label">
        <strong>Remove member</strong>
        <span className="field-hint">
          {member.removalStopped
            ? `Removing them stopped ${ago(member.removalStopped)} before everything of theirs was deleted. They’re suspended until you remove them again.`
            : "Deletes their account, files and links, and frees their space."}
        </span>
      </span>
      <Button className="danger-text" icon={<UserMinus size={16} />} busy={busy} onClick={() => void remove()}>
        Remove member…
      </Button>
    </div>
  );
}
