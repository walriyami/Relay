import { useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { ApiError, api, call, displayName, type AdminMember, type AdminOverview, type PendingInvite } from "../../api";
import { LIMITS, USERNAME, type MemberDefaults } from "../../../shared/model";
import { useSession } from "../../app/session";
import { ago, bytes, dateTime, plural } from "../../lib/format";
import { notifyChange, useLive } from "../../lib/live";
import type { CodeLength } from "../../../shared/codes";
import { usePeriodicRefresh } from "../../lib/refresh";
import { navigate, scrollMotion } from "../../lib/router";
import {
  Button,
  CopyButton,
  Field,
  InlineEmpty,
  LoadFailed,
  Modal,
  ProgressBar,
  Segmented,
  Spinner,
  Toggle,
  confirmDialog,
  promptDialog,
  toast,
} from "../../components/ui";
import { LinkDialog } from "../../components/LinkDialog";
import { days, fromSegment, keepOptions, linkLifeOptions, toSegment, trashOptions } from "../../lib/options";
import { ByteSizeField, changedBytes, toDraft, type ByteDraft } from "./ByteSize";

const errorToast = (e: unknown) => toast((e as Error).message, { tone: "error" });

/** Only reachable by the administrator: the app shows members "Page not found" instead. */
export function AdminPage() {
  const { me } = useSession();
  // Storage and member usage move with every upload; a join or suspension changes "account".
  const { data, error, reload } = useLive(api.admin.overview, {}, ["items", "account"], null);
  usePeriodicRefresh(reload);
  const invites = useLive(api.admin.invites, {}, ["account"], [] as PendingInvite[]);
  const [invite, setInvite] = useState<{ token: string; code: string; expires: number } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [member, setMember] = useState<AdminMember | null>(null);
  async function createInvite() {
    setInviting(true);
    try {
      await promptDialog({
        title: "Invite a member",
        label: "Who is it for? (optional)",
        value: "",
        optional: true,
        hint: "Only administrators see this. It tells open invitations apart.",
        confirm: "Create invitation",
        apply: async (note) => {
          setInvite(await call(api.admin.invite, { body: { note: note || undefined } }));
          invites.reload();
        },
      });
    } catch (e) {
      errorToast(e);
    } finally {
      setInviting(false);
    }
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="muted">Members, storage and service activity.</p>
        </div>
        <Button variant="primary" icon={<UserPlus size={16} />} busy={inviting} onClick={() => void createInvite()}>
          Invite member
        </Button>
      </div>
      {error && <LoadFailed banner={!!data} error={error} onRetry={reload} />}
      {!data ? (
        !error && <Spinner />
      ) : (
        <>
          <HealthNotice data={data} />
          <Stats data={data} />
          <section className="settings-section card-surface" aria-labelledby="admin-members">
            <div className="settings-section-head">
              <h2 id="admin-members">Members</h2>
            </div>
            <ul className="list">
              {data.members.map((u) => (
                <li key={u.id} className="list-row">
                  <span className="avatar" aria-hidden>
                    {displayName(u)[0]?.toUpperCase()}
                  </span>
                  <span className="list-text static">
                    <strong>
                      {displayName(u)}
                      {u.name && <span className="member-username muted">{u.username}</span>}
                      {u.admin && <span className="pill">Admin</span>}
                      {u.disabled && <span className="pill danger">Suspended</span>}
                    </strong>
                    <span className="muted">
                      {bytes(u.usage.used)} of {bytes(u.quota)}
                      {u.usage.reserved > 0 && ` · ${bytes(u.usage.reserved)} uploading`}
                      {u.retentionDays ? ` · uploads kept ${days(u.retentionDays)}` : ""}
                    </span>
                    <span className="member-usage">
                      <ProgressBar
                        value={u.usage.used + u.usage.reserved}
                        max={u.quota}
                        label={`Storage used by ${displayName(u)}`}
                        minVisible
                      />
                    </span>
                  </span>
                  <Button size="sm" aria-label={`Manage ${u.username}`} onClick={() => setMember(u)}>
                    Manage
                  </Button>
                </li>
              ))}
            </ul>
          </section>
          <Invitations
            invites={invites.data}
            loading={invites.loading}
            error={invites.error}
            onChanged={invites.reload}
          />
          <section className="settings-section card-surface" aria-labelledby="admin-defaults">
            <div className="settings-section-head">
              <h2 id="admin-defaults">New members</h2>
              <p className="muted">
                What people who join from now on start with. Members already here keep theirs; use Manage to change
                them.
              </p>
            </div>
            {/* Keyed so saved (or elsewhere changed) values become the new starting point. */}
            <NewMemberDefaults key={JSON.stringify(data.defaults)} defaults={data.defaults} onSaved={reload} />
          </section>
          <section className="settings-section card-surface" aria-labelledby="admin-limits">
            <div className="settings-section-head">
              <h2 id="admin-limits">Limits</h2>
              <p className="muted">The most all members can store together.</p>
            </div>
            {/* Keyed so a saved (or elsewhere changed) value becomes the new starting point. */}
            <Limits key={data.limits.capacity} limits={data.limits} onSaved={reload} />
          </section>
          <section className="settings-section card-surface" aria-labelledby="admin-codes">
            <div className="settings-section-head">
              <h2 id="admin-codes">Codes</h2>
              <p className="muted">One length for sign-ins, shares, upload requests and invitations.</p>
            </div>
            <CodeSettings key={data.codeLength} codeLength={data.codeLength} onSaved={reload} />
          </section>
          <ServiceHealth data={data} />
        </>
      )}
      {invite && (
        <LinkDialog
          title="Invitation ready"
          subtitle="Copy or scan this link now. For security, it can’t be retrieved after you close this window."
          meta={`Works once · Expires ${dateTime(invite.expires)}`}
          url={`${location.origin}/join/${invite.token}`}
          code={invite.code}
          codeLabel="Invitation code"
          purpose="invitation"
          onClose={() => setInvite(null)}
        />
      )}
      {member && (
        <ManageMember
          member={member}
          self={member.id === me.user.id}
          onClose={() => setMember(null)}
          onChanged={reload}
          onSaved={() => {
            setMember(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** What needs the administrator, if anything; everything else about the service can wait below. */
function healthProblems({ operations: o, storage }: AdminOverview) {
  const stale = (stage: AdminOverview["operations"]["maintenance"][number]) =>
    o.sampled - stage.attempted > Math.max(5 * 60_000, 3 * o.maintenanceIntervalMs);
  return [
    storage.diskFree < Math.min(1024 ** 3, storage.diskTotal * 0.05) &&
      "Disk space is low. Free space on the host before uploads fail.",
    o.reconciliation.missing > 0 &&
      `${plural(o.reconciliation.missing, "stored blob")} missing at startup. Some files may be unavailable. Check the data volume on the host.`,
    o.maintenance.some((stage) => stage.failed) &&
      "Maintenance failed. Other cleanup jobs continue; failed jobs retry on the next sweep. Inspect server logs for the affected job.",
    o.maintenance.some(stale) &&
      "Maintenance has not run recently. Check the process and its configured sweep interval.",
  ].filter((problem): problem is string => !!problem);
}

/** Leads the page when the service needs a look, and points to the details. */
function HealthNotice({ data }: { data: AdminOverview }) {
  const problems = healthProblems(data);
  if (!problems.length) return null;
  return (
    <div className="notice health-notice" role="status">
      <strong>Relay needs attention</strong>
      <span>{problems.length === 1 ? problems[0] : `${problems.length} problems were found.`}</span>
      <a
        className="link"
        href="#admin-health"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("admin-health")?.scrollIntoView({ behavior: scrollMotion(), block: "start" });
        }}
      >
        See service health
      </a>
    </div>
  );
}

function ServiceHealth({ data }: { data: AdminOverview }) {
  const { operations: o, storage } = data;
  const problems = healthProblems(data);
  const jobs = o.maintenance.length;
  return (
    <section className="settings-section card-surface" aria-labelledby="admin-health">
      <div className="settings-section-head health-head">
        <h2 id="admin-health">Service health</h2>
        <span className={`pill ${problems.length ? "danger" : "success"}`}>
          {problems.length ? "Needs attention" : "Checks passing"}
        </span>
      </div>
      {problems.map((problem) => (
        <p key={problem} className="notice">
          {problem}
        </p>
      ))}
      {!problems.length && (
        <p className="muted">
          {jobs === 1 ? "The maintenance job is" : `All ${jobs} maintenance jobs are`} running on schedule. Last hour:{" "}
          {plural(o.recent.requests, "request")}, {plural(o.recent.failures, "server error")}.
        </p>
      )}
      {/* Open by itself when something failed, since then the detail is the point. */}
      <details className="health-details" open={problems.length > 0}>
        <summary>Details</summary>
        <ul className="list">
          {o.maintenance.map((stage) => (
            <li className="list-row" key={stage.name}>
              <span className="list-text static">
                <strong>{stage.name}</strong>
                <span className="muted">
                  {stage.succeeded ? `Last succeeded ${dateTime(stage.succeeded)}` : "No successful run yet"}
                  {stage.failures > 0 ? ` · ${plural(stage.failures, "failure")} since startup` : ""}
                </span>
              </span>
              <span className={`pill ${stage.failed ? "danger" : ""}`}>{stage.failed ? "Failed" : "OK"}</span>
            </li>
          ))}
        </ul>
        <dl className="health-facts">
          <dt>Last hour</dt>
          <dd>
            {plural(o.recent.requests, "request")} · {plural(o.recent.failures, "server error")} · {o.recent.limited}{" "}
            rate limited
          </dd>
          <dt>Stored content</dt>
          <dd>
            {bytes(storage.blobBytes)} unique · {bytes(storage.trashBytes)} in{" "}
            {plural(storage.trashItems, "trashed item")}. Excludes temporary files, previews and the database.
          </dd>
          <dt>Process</dt>
          <dd>
            {bytes(o.memoryBytes)} memory · started {dateTime(o.started)}. Counters reset on restart.
          </dd>
          <dt>File check</dt>
          <dd>
            At startup {dateTime(o.reconciliation.checked)} · {plural(o.reconciliation.removedOrphans, "orphan file")}{" "}
            removed
          </dd>
        </dl>
        <p className="field-hint">Updates every 30 seconds while this page is visible.</p>
      </details>
    </section>
  );
}

function Stats({ data }: { data: AdminOverview }) {
  const { storage, activity } = data;
  return (
    <div className="stats">
      <div className="stat card-surface">
        <span className="muted">Storage</span>
        <strong>{bytes(storage.used)}</strong>
        <ProgressBar
          value={storage.used + storage.reserved}
          max={storage.capacity}
          label="Service storage"
          minVisible
        />
        <span className="field-hint">
          of {bytes(storage.capacity)} capacity
          {storage.reserved > 0 && ` · ${bytes(storage.reserved)} uploading`}
        </span>
        <span className="field-hint">
          {bytes(storage.diskFree)} free on disk of {bytes(storage.diskTotal)}
        </span>
      </div>
      <div className="stat card-surface">
        <span className="muted">Activity</span>
        <strong>
          {activity.activeUploads ? `${plural(activity.activeUploads, "upload")} in progress` : "No uploads right now"}
        </strong>
        <span className="field-hint">{bytes(activity.receivedBytesLastHour)} received in the last hour</span>
      </div>
    </div>
  );
}

function Invitations({
  invites,
  loading,
  error,
  onChanged,
}: {
  invites: PendingInvite[];
  loading: boolean;
  error: string;
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
        <p className="muted">Links not used yet. Each creates one account.</p>
      </div>
      {error && <LoadFailed banner error={error} onRetry={onChanged} />}
      {invites.length ? (
        <ul className="list" aria-label="Open invitations">
          {invites.map((i) => (
            <li key={i.id} className="list-row">
              <span className="list-text static">
                <strong>{i.note ? `For ${i.note}` : `Expires ${dateTime(i.expires)}`}</strong>
                <span className="muted">
                  {i.note && `Expires ${dateTime(i.expires)} · `}Created {ago(i.created)} by {i.createdBy}
                </span>
                {i.code && (
                  <span>
                    <span className="code">{i.code}</span>{" "}
                    <CopyButton value={i.code} label="Copy invitation code" variant="ghost" size="sm" iconOnly />
                  </span>
                )}
              </span>
              <Button size="sm" onClick={() => void withdraw(i)}>
                Withdraw
              </Button>
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

function Limits({ limits, onSaved }: { limits: AdminOverview["limits"]; onSaved: () => void }) {
  const [capacity, setCapacity] = useState(() => toDraft(limits.capacity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Undefined while untouched, so an unchanged value is never rewritten; null when invalid.
  const change = changedBytes(capacity, limits.capacity);
  return (
    <form
      className="stack-sm"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (change === null) return setError("Enter a size greater than zero.");
        setBusy(true);
        try {
          await call(api.admin.settings, {
            body: { capacity: change },
          });
          toast("Limits saved");
          onSaved();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <ByteSizeField
          label="Total storage"
          draft={capacity}
          original={limits.capacity}
          onChange={setCapacity}
          invalid={change === null}
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" busy={busy} disabled={change === undefined}>
          Save limits
        </Button>
      </div>
    </form>
  );
}

function NewMemberDefaults({ defaults, onSaved }: { defaults: MemberDefaults; onSaved: () => void }) {
  const [quota, setQuota] = useState(() => toDraft(defaults.quota));
  const [retention, setRetention] = useState(defaults.retentionDays ?? 0);
  const [linkDays, setLinkDays] = useState(toSegment(defaults.linkDays));
  const [trashDays, setTrashDays] = useState(defaults.trashDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const quotaChange = changedBytes(quota, defaults.quota);
  const changes = {
    quota: quotaChange ?? undefined,
    retentionDays: retention !== (defaults.retentionDays ?? 0) ? retention || null : undefined,
    linkDays: linkDays !== toSegment(defaults.linkDays) ? fromSegment(linkDays) : undefined,
    trashDays: trashDays !== defaults.trashDays ? trashDays : undefined,
  };
  const changed = Object.values(changes).some((v) => v !== undefined) || quotaChange === null;
  return (
    <form
      className="stack"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (quotaChange === null) return setError("Enter a storage quota greater than zero.");
        setBusy(true);
        try {
          await call(api.admin.settings, { body: { defaults: changes } });
          toast("Saved. New members start with these.");
          onSaved();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <MemberFields
        quota={{ draft: quota, original: defaults.quota, invalid: quotaChange === null, onChange: setQuota }}
        retention={{ value: retention, onChange: setRetention }}
        linkDays={{ value: linkDays, onChange: setLinkDays }}
        trashDays={{ value: trashDays, onChange: setTrashDays }}
      />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" busy={busy} disabled={!changed}>
          Save for new members
        </Button>
      </div>
    </form>
  );
}

type Choice<T> = { value: T; onChange: (value: T) => void };

/** The values each member has, asked the same way for new members and for one member. */
function MemberFields({
  quota,
  quotaHint,
  retention,
  linkDays,
  trashDays,
}: {
  quota: { draft: ByteDraft; original: number; invalid: boolean; onChange: (draft: ByteDraft) => void };
  quotaHint?: string;
  retention: Choice<number>;
  /** As a segmented value: 0 keeps links until turned off. */
  linkDays: Choice<number>;
  trashDays: Choice<number>;
}) {
  return (
    <>
      <ByteSizeField
        label="Storage quota"
        hint={quotaHint}
        draft={quota.draft}
        original={quota.original}
        onChange={quota.onChange}
        invalid={quota.invalid}
      />
      <div className="stack-sm">
        <span className="field-label">Keep uploads in Files</span>
        <Segmented
          label="Keep uploads in Files"
          value={retention.value}
          options={keepOptions(retention.value)}
          onChange={retention.onChange}
        />
        <span className="field-hint">After this, uploads move to Trash automatically.</span>
      </div>
      <div className="stack-sm">
        <span className="field-label">Links expire after</span>
        <Segmented
          label="Links expire after"
          value={linkDays.value}
          options={linkLifeOptions(fromSegment(linkDays.value))}
          onChange={linkDays.onChange}
        />
        <span className="field-hint">What new links start with. Each link can still be set on its own.</span>
      </div>
      <div className="stack-sm">
        <span className="field-label">Empty Trash after</span>
        <Segmented
          label="Empty Trash after"
          value={trashDays.value}
          options={trashOptions(trashDays.value)}
          onChange={trashDays.onChange}
        />
        <span className="field-hint">Until then, anything deleted can be restored.</span>
      </div>
    </>
  );
}

/** "They'll be signed out on 2 devices", or that they aren't signed in anywhere. */
const signOutConsequence = (m: AdminMember) =>
  m.signedInDevices
    ? `${m.username} will be signed out on ${plural(m.signedInDevices, "device")} right away.`
    : `${m.username} isn’t signed in anywhere right now.`;

function ManageMember({
  member,
  self,
  onClose,
  onChanged,
  onSaved,
}: {
  member: AdminMember;
  self: boolean;
  onClose: () => void;
  /** Something was saved but the dialog stays open. */
  onChanged: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(member.name ?? "");
  const [username, setUsername] = useState(member.username);
  const [quota, setQuota] = useState(() => toDraft(member.quota));
  const [retention, setRetention] = useState(member.retentionDays || 0);
  const [linkDays, setLinkDays] = useState(toSegment(member.linkDays));
  const [trashDays, setTrashDays] = useState(member.trashDays);
  const [disabled, setDisabled] = useState(member.disabled);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputs = {
    username: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };
  const cleanUsername = username.trim().toLowerCase();
  // Only edited fields are sent: a quota the form can't show exactly is never rewritten.
  const quotaChange = changedBytes(quota, member.quota);
  const changes = {
    name: name.trim() !== (member.name ?? "") ? name.trim() || null : undefined,
    username: cleanUsername !== member.username ? cleanUsername : undefined,
    quota: quotaChange ?? undefined,
    retentionDays: retention !== (member.retentionDays || 0) ? retention || null : undefined,
    linkDays: linkDays !== toSegment(member.linkDays) ? fromSegment(linkDays) : undefined,
    trashDays: trashDays !== member.trashDays ? trashDays : undefined,
    disabled: !member.admin && disabled !== member.disabled ? disabled : undefined,
  };
  const changed = Object.values(changes).some((v) => v !== undefined) || quotaChange === null || !!password;
  function fail(message: string, field?: keyof typeof inputs) {
    setError(message);
    if (field) inputs[field].current?.focus();
  }
  async function save() {
    setError("");
    if (changes.username !== undefined && !USERNAME.test(changes.username))
      return fail("Use 3 to 32 lowercase letters, numbers, - or _, starting with a letter or number.", "username");
    if (quotaChange === null) return setError("Enter a storage quota greater than zero.");
    if (password && password.length < LIMITS.passwordMin) {
      return fail(`The new password needs at least ${LIMITS.passwordMin} characters.`, "password");
    }
    const suspending = changes.disabled === true;
    if (suspending || password) {
      const title =
        suspending && password
          ? `Suspend ${member.username} and set a new password?`
          : suspending
            ? `Suspend ${member.username}?`
            : `Set a new password for ${member.username}?`;
      const body = [
        signOutConsequence(member),
        suspending && "They can’t sign in until you turn suspension off. Their files are kept.",
        password && "Their passkeys are removed. Tell them the new password yourself.",
      ]
        .filter(Boolean)
        .join(" ");
      const ok = await confirmDialog({
        title,
        body,
        confirm: suspending ? "Suspend" : "Set password",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    let saved = false;
    try {
      if (Object.values(changes).some((v) => v !== undefined)) {
        await call(api.admin.updateMember, { params: { id: member.id }, body: changes });
        saved = true;
      }
      if (password) await call(api.admin.resetPassword, { params: { id: member.id }, body: { password } });
      const now = changes.username ?? member.username;
      toast(
        suspending
          ? `${now} is suspended`
          : changes.username
            ? `Saved. ${self ? "You sign" : "They sign"} in as ${now} from now on.`
            : "Saved",
      );
      onSaved();
    } catch (e) {
      if (saved) {
        // The member's other changes are in; only the password is left to retry.
        onChanged();
        setError(`Your other changes were saved, but the password wasn’t changed: ${(e as Error).message}`);
      } else if (e instanceof ApiError && e.status === 409) fail(e.message, "username");
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Manage ${member.username}${self ? " (you)" : ""}`}
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
        <MemberFields
          quota={{ draft: quota, original: member.quota, invalid: quotaChange === null, onChange: setQuota }}
          quotaHint={`${bytes(member.usage.used)} used now.`}
          retention={{ value: retention, onChange: setRetention }}
          linkDays={{ value: linkDays, onChange: setLinkDays }}
          trashDays={{ value: trashDays, onChange: setTrashDays }}
        />
        {!member.admin && (
          <Toggle
            label="Suspend access"
            description="Signs the member out everywhere and blocks sign-in."
            checked={disabled}
            onChange={setDisabled}
          />
        )}
        {self ? (
          <p className="field-hint">
            To change your own password, use{" "}
            <button type="button" className="link" onClick={() => navigate("/settings")}>
              Settings
            </button>
            .
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
    </Modal>
  );
}

function CodeSettings({ codeLength, onSaved }: { codeLength: CodeLength; onSaved: () => void }) {
  const [length, setLength] = useState(codeLength);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="stack-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || length === codeLength) return;
        if (
          !(await confirmDialog({
            title: `Use ${length}-digit codes?`,
            body: "All existing codes will be replaced. Previously shared codes will stop working; their links and QR codes will keep working. Share the replacement codes with anyone who needs them.",
            confirm: "Replace codes",
            danger: true,
          }))
        )
          return;
        setBusy(true);
        setError("");
        try {
          await call(api.admin.settings, { body: { codeLength: length } });
          notifyChange("account");
          onSaved();
          toast("Code length saved. Existing codes replaced.");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Segmented<CodeLength>
        label="Code length"
        value={length}
        onChange={setLength}
        options={[
          { value: 6, label: "6 digits · 123-456" },
          { value: 4, label: "4 digits · 1234" },
        ]}
      />
      <p className="field-hint">
        Six digits are harder to guess and support more codes. Four digits have a limit of 10,000 unique codes for this
        deployment; retired codes are never reused.
      </p>
      {length !== codeLength && (
        <p className="notice">Saving replaces every existing code. Links and QR codes keep working.</p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={length === codeLength} busy={busy}>
          Save code length
        </Button>
      </div>
    </form>
  );
}
