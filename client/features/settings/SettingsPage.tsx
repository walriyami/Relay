import { useEffect, useRef, useState } from "react";
import { Laptop, Plus, Smartphone, Tablet } from "lucide-react";
import { ApiError, api, call, type ActivityPrefs, type Device, type Me, type Prefs } from "../../api";
import { LIMITS, USERNAME, displayName } from "../../../shared/model";
import { useSession } from "../../app/session";
import { confirmSignOut, signOut } from "../../app/App";
import { ago, bytes } from "../../lib/format";
import { notifyChange } from "../../lib/live";
import { fromSegment, keepOptions, linkLifeOptions, toSegment } from "../../lib/options";
import { navigate } from "../../lib/router";
import { setTransferPrefs } from "../../lib/transfers";
import { setLocalPrefs, useLocalPrefs } from "../../lib/local-prefs";
import { AddDevice } from "./AddDevice";
import { PasskeysSection } from "./Passkeys";
import { Section } from "./Section";
import {
  Button,
  LoadFailed,
  Field,
  Menu,
  Modal,
  ProgressBar,
  Segmented,
  Toggle,
  confirmDialog,
  promptDialog,
  toast,
} from "../../components/ui";

const deviceIcon = (d: Device) => {
  const name = (d.name + (d.current ? " " + navigator.userAgent : "")).toLowerCase();
  if (/ipad|tablet/.test(name)) return <Tablet size={18} aria-hidden />;
  if (/phone|iphone|android|mobile/.test(name)) return <Smartphone size={18} aria-hidden />;
  return <Laptop size={18} aria-hidden />;
};

type AccountChange = {
  prefs?: Partial<Omit<Prefs, "activity">> & { activity?: Partial<ActivityPrefs> };
  retentionDays?: number | null;
};

function applyChange(current: Me, body: AccountChange): Me {
  return {
    ...current,
    prefs: {
      ...current.prefs,
      ...body.prefs,
      activity: { ...current.prefs.activity, ...body.prefs?.activity },
    },
    user: body.retentionDays !== undefined ? { ...current.user, retentionDays: body.retentionDays } : current.user,
  };
}

export function SettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const { me: savedMe, setMe, refreshMe } = useSession();
  const queue = useRef<AccountChange[]>([]);
  const saving = useRef(false);
  const [pending, setPending] = useState<AccountChange[]>([]);
  // Keep later choices visible while earlier writes and account refreshes settle.
  const me = pending.reduce(applyChange, savedMe);
  // Usage changes with every upload; the bootstrap copy is stale by now.
  useEffect(() => {
    void refreshMe().catch(() => {});
  }, [refreshMe]);
  const local = useLocalPrefs();
  const [changingPassword, setChangingPassword] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  async function save(body: AccountChange) {
    queue.current.push(body);
    setPending([...queue.current]);
    if (saving.current) return;
    saving.current = true;
    while (queue.current.length) {
      try {
        const { prefs, user } = await call(api.account.update, { body: queue.current[0] });
        setMe((current) => ({ ...current, prefs, user }));
        setTransferPrefs(prefs);
        toast("Saved");
      } catch (e) {
        // A failed response may still have reached the server. Recover before the next write;
        // pending choices stay visible, and a failed refresh falls back to the last saved state.
        await refreshMe().catch(() => {});
        toast((e as Error).message, { tone: "error" });
      }
      queue.current.shift();
      setPending([...queue.current]);
    }
    saving.current = false;
  }
  const notifySupported = typeof Notification !== "undefined";
  const notifyBlocked = notifySupported && Notification.permission === "denied";
  const quota = me.user.quota;
  const used = me.usage.used + me.usage.reserved;
  return (
    <div className="page settings">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <Section id="s-sending" title="Sending" description="Defaults for new transfers.">
        <div className="setting-row">
          <span className="setting-label">
            <strong>Links expire after</strong>
            <span className="field-hint">Each link can still be set on its own when you create it.</span>
          </span>
          <Segmented
            label="Links expire after"
            value={toSegment(me.prefs.linkDays)}
            options={linkLifeOptions(me.prefs.linkDays)}
            onChange={(v) => void save({ prefs: { linkDays: fromSegment(v) } })}
          />
        </div>
        <div className="setting-row">
          <span className="setting-label">
            <strong>Keep uploads in Files</strong>
            <span className="field-hint">After this, uploads move to Trash automatically.</span>
          </span>
          <Segmented
            label="Keep uploads in Files"
            value={me.user.retentionDays || 0}
            options={keepOptions(me.user.retentionDays)}
            onChange={(v) => void save({ retentionDays: v || null })}
          />
        </div>
        <Toggle
          label="Copy new links automatically"
          description="Puts the link on your clipboard as soon as it’s ready."
          checked={me.prefs.autoCopyLink}
          onChange={(v) => void save({ prefs: { autoCopyLink: v } })}
        />
      </Section>
      <DevicesSection />
      <PasskeysSection />
      <Section
        id="s-activity"
        title="Activity"
        description="What the bell shows. Items waiting for this device to accept them are always shown."
      >
        <Toggle
          label="Items you received"
          description="Items from your other devices that this device accepted or declined."
          checked={me.prefs.activity.received}
          onChange={(v) => void save({ prefs: { activity: { received: v } } })}
        />
        <Toggle
          label="Files sent to your requests"
          checked={me.prefs.activity.requests}
          onChange={(v) => void save({ prefs: { activity: { requests: v } } })}
        />
        <Toggle
          label="Your links"
          description="Someone opened or downloaded from a link you shared."
          checked={me.prefs.activity.links}
          onChange={(v) => void save({ prefs: { activity: { links: v } } })}
        />
        <Toggle
          label="Sign-ins and security"
          description="New sign-ins, password changes, and passkeys added or removed."
          checked={me.prefs.activity.security}
          onChange={(v) => void save({ prefs: { activity: { security: v } } })}
        />
        {me.user.admin && (
          <Toggle
            label="New members"
            description="Someone joined with one of your invitations."
            checked={me.prefs.activity.members}
            onChange={(v) => void save({ prefs: { activity: { members: v } } })}
          />
        )}
      </Section>
      <Section
        id="s-notify"
        title="Arrivals"
        description="What happens when something arrives. These apply to this browser only."
      >
        <Toggle
          label="Accept items automatically"
          description="Items your other devices send here download as soon as they arrive."
          checked={local.autoAccept}
          onChange={(v) => setLocalPrefs({ autoAccept: v })}
        />
        <Toggle
          label="Open items as soon as they arrive"
          description="Otherwise they wait in Activity."
          checked={local.popups}
          onChange={(v) => setLocalPrefs({ popups: v })}
        />
        <Toggle label="Play a sound" checked={local.sound} onChange={(v) => setLocalPrefs({ sound: v })} />
        <Toggle
          label="System notifications when Relay is in the background"
          description={
            !notifySupported
              ? "This browser doesn’t support notifications."
              : notifyBlocked
                ? "Blocked by your browser. Allow notifications for this site, then reload."
                : undefined
          }
          disabled={!notifySupported || notifyBlocked}
          checked={local.system && typeof Notification !== "undefined" && Notification.permission === "granted"}
          onChange={async (v) => {
            if (!v) return setLocalPrefs({ system: false });
            if (typeof Notification === "undefined") return;
            const permission =
              Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
            if (permission === "granted") setLocalPrefs({ system: true });
            else toast("Notifications weren’t allowed.", { tone: "error" });
          }}
        />
      </Section>
      <Section id="s-look" title="Appearance" description="Applies to this browser only.">
        <div className="setting-row">
          <span className="setting-label">
            <strong>Theme</strong>
          </span>
          <Segmented
            label="Theme"
            value={local.theme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(v) => setLocalPrefs({ theme: v })}
          />
        </div>
      </Section>
      <Section id="s-storage" title="Storage">
        <div className="stack-sm">
          <ProgressBar value={used} max={quota} label="Storage used" minVisible />
          <span>
            <strong>{bytes(used)}</strong> <span className="muted">of {bytes(quota)} used</span>
          </span>
          <p className="field-hint">
            Items in Trash still count until deleted. Trash empties itself after 30 days.{" "}
            <a
              className="link"
              href="/trash"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                navigate("/trash");
              }}
            >
              Open Trash
            </a>
          </p>
        </div>
      </Section>
      <Section id="s-account" title="Account">
        <div className="setting-row">
          <span className="setting-label">
            <strong>{displayName(me.user)}</strong>
            <span className="field-hint">
              {me.user.name ? `Signs in as ${me.user.username}. ` : ""}People you share with see this name.
            </span>
          </span>
          <Button onClick={() => setEditingProfile(true)}>Edit…</Button>
        </div>
        <div className="setting-row">
          <span className="setting-label">
            <strong>Password</strong>
            <span className="field-hint">Changing it signs out your other devices.</span>
          </span>
          <Button onClick={() => setChangingPassword(true)}>Change password…</Button>
        </div>
        <div className="setting-row">
          <span className="setting-label">
            <strong>Sign out</strong>
            <span className="field-hint">Signs out this browser. Uploads in progress here are cancelled.</span>
          </span>
          <Button
            onClick={async () => {
              if (!(await confirmSignOut())) return;
              await signOut();
              onSignedOut();
            }}
          >
            Sign out
          </Button>
        </div>
        {changingPassword && <PasswordDialog onClose={() => setChangingPassword(false)} />}
        {editingProfile && <ProfileDialog onClose={() => setEditingProfile(false)} />}
      </Section>
    </div>
  );
}

/** The name people see, and the username to sign in with. */
function ProfileDialog({ onClose }: { onClose: () => void }) {
  const { me, setMe } = useSession();
  const [name, setName] = useState(me.user.name ?? "");
  const [username, setUsername] = useState(me.user.username);
  const [error, setError] = useState<{ field: "name" | "username"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanUsername = username.trim().toLowerCase();
  const changes = {
    ...(name.trim() !== (me.user.name ?? "") ? { name: name.trim() || null } : {}),
    ...(cleanUsername !== me.user.username ? { username: cleanUsername } : {}),
  };
  const usernameProblem = !USERNAME.test(cleanUsername)
    ? "Use 3 to 32 lowercase letters, numbers, - or _, starting with a letter or number."
    : null;
  const errorProps = (field: "name" | "username") =>
    error?.field === field ? { "aria-invalid": true, "aria-describedby": "profile-error" } : {};
  return (
    <Modal
      size="sm"
      title="Name and username"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="profile" busy={busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="profile"
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!Object.keys(changes).length) return onClose();
          if (changes.username && usernameProblem) return setError({ field: "username", message: usernameProblem });
          setBusy(true);
          try {
            const { prefs, user } = await call(api.account.update, { body: changes });
            setMe((current) => ({ ...current, prefs, user }));
            toast(changes.username ? `Saved. Sign in as ${user.username} from now on.` : "Saved");
            onClose();
          } catch (e) {
            setError({
              field: e instanceof ApiError && e.status === 409 ? "username" : "name",
              message: (e as Error).message,
            });
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint="Shown on links you share and on your requests. Empty shows your username.">
          <input
            className="input"
            maxLength={LIMITS.displayNameLength}
            placeholder={me.user.username}
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            data-autofocus
            {...errorProps("name")}
          />
        </Field>
        <Field label="Username" hint="What you sign in with. Your devices and passkeys keep working.">
          <input
            className="input"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            maxLength={32}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
            {...errorProps("username")}
          />
        </Field>
        {error && (
          <p id="profile-error" className="field-error" role="alert">
            {error.message}
          </p>
        )}
      </form>
    </Modal>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ field: "current" | "next" | "confirm"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  // The field the error is about takes focus with its text selected, ready to correct.
  useEffect(() => {
    if (!error) return;
    inputs[error.field].current?.focus();
    inputs[error.field].current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus the field only when a new error arrives.
  }, [error]);
  const errorProps = (field: "current" | "next" | "confirm") =>
    error?.field === field ? { "aria-invalid": true, "aria-describedby": "change-password-error" } : {};
  return (
    <Modal
      size="sm"
      title="Change password"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="change-password"
            busy={busy}
            disabled={!current || !next || !confirm}
          >
            Change password
          </Button>
        </>
      }
    >
      <form
        id="change-password"
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          if (next !== confirm) return setError({ field: "confirm", message: "The new passwords don’t match." });
          setBusy(true);
          try {
            await call(api.account.password, { body: { current, password: next } });
            toast("Password changed. Other devices were signed out.");
            notifyChange("devices");
            onClose();
          } catch (e) {
            const wrongCurrent = e instanceof ApiError && e.status === 403;
            setError({ field: wrongCurrent ? "current" : "next", message: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Current password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            ref={inputs.current}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            {...errorProps("current")}
          />
        </Field>
        <Field label="New password" hint={`At least ${LIMITS.passwordMin} characters`}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={LIMITS.passwordMin}
            required
            ref={inputs.next}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            {...errorProps("next")}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={LIMITS.passwordMin}
            required
            ref={inputs.confirm}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            {...errorProps("confirm")}
          />
        </Field>
        {error && (
          <p id="change-password-error" className="field-error" role="alert">
            {error.message}
          </p>
        )}
      </form>
    </Modal>
  );
}

function DevicesSection() {
  const { me, setMe, devices, devicesLoading, devicesError, reloadDevices } = useSession();
  const [adding, setAdding] = useState(false);
  const signedIn = devices.filter((d) => d.signedIn);
  const others = signedIn.filter((d) => !d.current);
  async function rename(d: Device) {
    await promptDialog({
      title: "Rename device",
      label: "Device name",
      value: d.name,
      confirm: "Save",
      // Names tell devices apart when sending and signing out, so two signed-in devices can't share one.
      apply: async (name) => {
        if (name === d.name) return;
        if (signedIn.some((o) => o.id !== d.id && o.name.toLowerCase() === name.toLowerCase()))
          throw new Error("Another signed-in device already has that name.");
        await call(api.devices.rename, { params: { id: d.id }, body: { name } });
        if (d.current) setMe({ ...me, device: { ...me.device, name } });
        reloadDevices();
      },
    });
  }
  const seenText = (d: Device) => (d.online ? "is online now" : `was last seen ${ago(d.seen)}`);
  async function remove(d: Device) {
    const ok = await confirmDialog({
      title: `Sign out ${d.name}?`,
      body: `This device ${seenText(d)}. It will need a password or sign-in code to use Relay again.`,
      confirm: "Sign out",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(api.devices.signOut, { params: { id: d.id } });
      reloadDevices();
      toast(`${d.name} was signed out`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }
  return (
    <Section
      id="s-devices"
      title="Devices"
      description="Devices signed in to your account. Online devices can receive what you send."
    >
      {devicesError && (
        <LoadFailed banner title="Devices couldn’t be loaded" error={devicesError} onRetry={reloadDevices} />
      )}
      {devicesLoading && <p className="muted">Loading devices…</p>}
      <ul className="device-list">
        {signedIn.map((d) => (
          <li key={d.id} className="device-row">
            <span className="device-icon">{deviceIcon(d)}</span>
            <span className="device-text">
              <strong>
                {d.name}
                {d.current && <span className="pill">This browser</span>}
              </strong>
              <span className="muted">
                {d.current || d.online ? (
                  <>
                    <span className="online-dot" aria-hidden /> Online
                  </>
                ) : (
                  `Last seen ${ago(d.seen)}`
                )}
              </span>
            </span>
            <Menu
              label={`Actions for ${d.name}`}
              items={[
                { label: "Rename", onSelect: () => void rename(d) },
                ...(d.current ? [] : [{ label: "Sign out", danger: true, onSelect: () => void remove(d) }]),
              ]}
            />
          </li>
        ))}
      </ul>
      <div className="row">
        <Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>
          Add a device
        </Button>
        {others.length > 0 && (
          <Button
            variant="ghost"
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Sign out all other devices?",
                body: `${others.map((d) => d.name).join(", ")} will need to sign in again.`,
                confirm: "Sign out others",
                danger: true,
              });
              if (!ok) return;
              try {
                await call(api.devices.signOutOthers);
                reloadDevices();
                toast("Other devices were signed out");
              } catch (e) {
                toast((e as Error).message, { tone: "error" });
              }
            }}
          >
            Sign out all other devices
          </Button>
        )}
      </div>
      {adding && <AddDevice onClose={() => setAdding(false)} />}
    </Section>
  );
}
