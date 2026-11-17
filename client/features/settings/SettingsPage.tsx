import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icons";
import { ApiError, api, call, type ActivityPrefs, type Device, type Me, type Prefs } from "../../api";
import { LIMITS, USERNAME, displayName } from "../../../shared/model";
import { useSession } from "../../app/session";
import { DeviceIcon, useEditDevice } from "../../app/devices";
import { confirmSignOut, signOut } from "../../app/App";
import { ago } from "../../lib/format";
import { notifyChange } from "../../lib/live";
import { fromSegment, keepOptions, limitHint, linkLifeOptions, toSegment, trashOptions } from "../../lib/options";
import { scrollMotion } from "../../lib/router";
import { setTransferPrefs } from "../../lib/transfers";
import { setLocalPrefs, useLocalPrefs } from "../../lib/local-prefs";
import { StorageMeter } from "../../components/StorageMeter";
import { AddDevice } from "./AddDevice";
import { PasskeysSection } from "./Passkeys";
import { Section } from "./Section";
import { NotificationSettings } from "../activity/Notifications";
import {
  Button,
  Chip,
  ListSkeleton,
  LoadFailed,
  Field,
  Menu,
  Modal,
  PageLink,
  Segmented,
  Toggle,
  confirmDialog,
  toast,
} from "../../components/ui";

type AccountChange = {
  prefs?: Partial<Omit<Prefs, "activity">> & { activity?: Partial<ActivityPrefs> };
  retentionDays?: number | null;
  trashDays?: number;
};

function applyChange(current: Me, body: AccountChange): Me {
  return {
    ...current,
    prefs: {
      ...current.prefs,
      ...body.prefs,
      activity: { ...current.prefs.activity, ...body.prefs?.activity },
    },
    user: {
      ...current.user,
      ...(body.retentionDays !== undefined && { retentionDays: body.retentionDays }),
      ...(body.trashDays !== undefined && { trashDays: body.trashDays }),
    },
  };
}

/** The page's sections, in order, as the side navigation lists them. */
const SECTIONS = [
  { id: "s-sending", title: "Sharing" },
  { id: "s-storage", title: "Storage" },
  { id: "s-activity", title: "Activity" },
  { id: "s-notify", title: "This device" },
  { id: "s-devices", title: "Devices" },
  { id: "s-account", title: "Account" },
  { id: "s-passkeys", title: "Passkeys" },
];
/** How long a quiet "Saved" stays beside the section that changed. */
const SAVED_FOR = 2400;
const OLDER_AFTER = 30 * 24 * 3_600_000;
const WIDE = "(min-width: 1120px)";
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * Beside the sections on wide screens: where you are on the page, and a jump to any other section.
 * The current section is the last one whose heading has scrolled past the top quarter of the
 * window, or the last one once the page is at its end. A section picked here stays current until
 * you scroll yourself, even when the page ends before its heading can reach the top.
 */
function SettingsNav() {
  const [current, setCurrent] = useState(SECTIONS[0].id);
  const picked = useRef(false);
  useEffect(() => {
    const wide = matchMedia(WIDE);
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (picked.current) return;
      const line = Math.max(window.innerHeight / 4, 140);
      const end = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let at = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) at = id;
      }
      setCurrent(end ? SECTIONS[SECTIONS.length - 1].id : at);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const release = (event: Event) => {
      if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return;
      picked.current = false;
    };
    const listen = () => {
      if (!wide.matches) return;
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
      for (const type of ["wheel", "touchmove", "keydown"]) window.addEventListener(type, release, { passive: true });
      schedule();
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const type of ["wheel", "touchmove", "keydown"]) window.removeEventListener(type, release);
    };
    const change = () => {
      stop();
      listen();
    };
    listen();
    wide.addEventListener("change", change);
    return () => {
      stop();
      wide.removeEventListener("change", change);
    };
  }, []);
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <ul>
        {SECTIONS.map(({ id, title }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              aria-current={current === id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                const heading = document.getElementById(id);
                if (!heading) return;
                picked.current = true;
                setCurrent(id);
                heading.scrollIntoView({ behavior: scrollMotion(), block: "start" });
                // Keyboard and screen reader users continue from the section they chose.
                heading.focus({ preventScroll: true });
                history.replaceState(history.state, "", `#${id}`);
              }}
            >
              {title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
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
  const device = useLocalPrefs();
  const [changingPassword, setChangingPassword] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  // Every choice on this page saves as it's made; the section it belongs to says so, quietly.
  const [saved, setSaved] = useState<{ section: string; at: number } | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), SAVED_FOR);
    return () => clearTimeout(timer);
  }, [saved]);
  const savedIn = (section: string) => saved?.section === section;
  const done = (section: string) => setSaved({ section, at: Date.now() });
  function local(section: string, patch: Parameters<typeof setLocalPrefs>[0]) {
    setLocalPrefs(patch);
    done(section);
  }
  async function save(body: AccountChange, section: string) {
    queue.current.push(body);
    setPending([...queue.current]);
    if (saving.current) return;
    saving.current = true;
    while (queue.current.length) {
      try {
        const { prefs, user } = await call(api.account.update, { body: queue.current[0] });
        setMe((current) => ({ ...current, prefs, user }));
        setTransferPrefs(prefs);
        done(section);
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
  const limits = me.user.limits;
  return (
    <div className="page settings">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <SettingsNav />
      <Section id="s-sending" title="Sharing" description="Defaults for new links." saved={savedIn("s-sending")}>
        <div className="setting-row">
          <span className="setting-label">
            <strong>Links expire after</strong>
            <span className="field-hint">
              You can still choose for each link when you create it.
              {limits.linkDays !== null && ` ${limitHint(limits.linkDays)}`}
            </span>
          </span>
          <Segmented
            label="Links expire after"
            value={toSegment(me.prefs.linkDays)}
            options={linkLifeOptions(me.prefs.linkDays, limits.linkDays)}
            onChange={(v) => void save({ prefs: { linkDays: fromSegment(v) } }, "s-sending")}
          />
        </div>
        <Toggle
          label="Copy new links automatically"
          description="Puts the link on your clipboard as soon as it’s ready."
          checked={me.prefs.autoCopyLink}
          onChange={(v) => void save({ prefs: { autoCopyLink: v } }, "s-sending")}
        />
        <Toggle
          label="Visible to people nearby"
          description="Other members on the same network as you can see your devices in Nearby and offer to send you things."
          checked={me.prefs.nearbyVisible}
          onChange={(v) => void save({ prefs: { nearbyVisible: v } }, "s-sending")}
        />
      </Section>
      <Section id="s-storage" title="Storage" saved={savedIn("s-storage")}>
        <div className="stack-sm">
          <StorageMeter me={me} />
          <p className="field-hint">
            Items in Trash still count until deleted. <PageLink to="/usage">See your usage</PageLink> ·{" "}
            <PageLink to="/trash">Open Trash</PageLink>
          </p>
        </div>
        <div className="setting-row">
          <span className="setting-label">
            <strong>Auto-delete new items after</strong>
            <span className="field-hint">
              They move to Trash this long after they’re first saved. You can change it for any item in Files.
              {limits.keepDays !== null && ` Relay removes every item ${limits.keepDays} days after it’s saved.`}
            </span>
          </span>
          <Segmented
            label="Auto-delete new items after"
            value={toSegment(me.user.retentionDays)}
            options={keepOptions(me.user.retentionDays, limits.keepDays)}
            onChange={(v) => void save({ retentionDays: v || null }, "s-storage")}
          />
        </div>
        <div className="setting-row">
          <span className="setting-label">
            <strong>Empty Trash after</strong>
            <span className="field-hint">For items you delete from now on. Each item in Trash shows its own date.</span>
          </span>
          <Segmented
            label="Empty Trash after"
            value={me.user.trashDays}
            options={trashOptions(me.user.trashDays)}
            onChange={(v) => void save({ trashDays: v }, "s-storage")}
          />
        </div>
      </Section>
      <Section
        id="s-activity"
        title="Activity"
        description="What the bell shows, and what notifications tell you about. Items waiting for this device to accept them are always shown."
        saved={savedIn("s-activity")}
      >
        <Toggle
          label="Items you received"
          description="Items from your other devices that this device accepted or declined."
          checked={me.prefs.activity.received}
          onChange={(v) => void save({ prefs: { activity: { received: v } } }, "s-activity")}
        />
        <Toggle
          label="Files sent to your requests"
          checked={me.prefs.activity.requests}
          onChange={(v) => void save({ prefs: { activity: { requests: v } } }, "s-activity")}
        />
        <Toggle
          label="Your links"
          description="Someone opened or downloaded from a link you shared. Downloads are marked new."
          checked={me.prefs.activity.links}
          onChange={(v) => void save({ prefs: { activity: { links: v } } }, "s-activity")}
        />
        <Toggle
          label="Sign-ins and security"
          description="Sign-ins, password changes, and passkeys added or removed. Only sign-ins on a new kind of device are marked new."
          checked={me.prefs.activity.security}
          onChange={(v) => void save({ prefs: { activity: { security: v } } }, "s-activity")}
        />
        {me.user.admin && (
          <Toggle
            label="New members"
            description="Someone joined with one of your invitations."
            checked={me.prefs.activity.members}
            onChange={(v) => void save({ prefs: { activity: { members: v } } }, "s-activity")}
          />
        )}
      </Section>
      <Section
        id="s-notify"
        title="This device"
        description="These choices apply to this browser only."
        saved={savedIn("s-notify")}
      >
        <div className="setting-row">
          <span className="setting-label">
            <strong>When your devices send something here</strong>
            <span className="field-hint">
              {device.autoAccept
                ? "It downloads straight away. Text opens so you can read it."
                : "It opens here, and you choose whether to download it."}
            </span>
          </span>
          <Segmented
            label="When your devices send something here"
            value={device.autoAccept ? "download" : "ask"}
            options={[
              { value: "download", label: "Download it" },
              { value: "ask", label: "Ask me" },
            ]}
            onChange={(v) => local("s-notify", { autoAccept: v === "download" })}
          />
        </div>
        <Toggle label="Play a sound" checked={device.sound} onChange={(v) => local("s-notify", { sound: v })} />
        <NotificationSettings />
        <div className="setting-row">
          <span className="setting-label">
            <strong>Theme</strong>
          </span>
          <Segmented
            label="Theme"
            value={device.theme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(v) => local("s-notify", { theme: v })}
          />
        </div>
      </Section>
      <DevicesSection />
      <Section id="s-account" title="Account">
        <SharedIdentitySettings />
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
      <PasskeysSection />
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
  const { devices, devicesLoading, devicesError, reloadDevices } = useSession();
  const editDevice = useEditDevice();
  const [adding, setAdding] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const signedIn = devices.filter((d) => d.signedIn);
  const others = signedIn.filter((d) => !d.current);
  // Browsers nobody has used for a month fold away, so the ones in use stay easy to find.
  const now = Date.now();
  const older = signedIn.filter((d) => !d.current && !d.online && now - d.seen > OLDER_AFTER);
  const shown = showOlder ? signedIn : signedIn.filter((d) => !older.includes(d));
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
      {devicesLoading && <ListSkeleton rows={2} />}
      <ul className="device-list">
        {shown.map((d) => (
          <li key={d.id} className="device-row">
            <span className="device-icon">
              <DeviceIcon device={d} />
            </span>
            <span className="device-text">
              <strong className="device-name">{d.name}</strong>
              <span className="chips">
                {d.current && <Chip>This browser</Chip>}
                {d.current || d.online ? <Chip tone="good">Online</Chip> : <Chip>Last seen {ago(d.seen)}</Chip>}
              </span>
            </span>
            {d.current ? (
              // This device’s name and icon can be edited directly.
              <Button
                size="sm"
                variant="ghost"
                className="device-edit"
                icon={<Icon.rename size={14} />}
                aria-label="Edit this device"
                onClick={() => editDevice(d)}
              >
                Edit
              </Button>
            ) : (
              <Menu
                label={`Actions for ${d.name}`}
                items={[
                  {
                    label: "Edit name and icon",
                    icon: <Icon.rename size={16} aria-hidden />,
                    onSelect: () => editDevice(d),
                  },
                  { label: "Sign out", danger: true, onSelect: () => void remove(d) },
                ]}
              />
            )}
          </li>
        ))}
      </ul>
      {older.length > 0 && (
        <button
          type="button"
          className="link device-older"
          aria-expanded={showOlder}
          onClick={() => setShowOlder(!showOlder)}
        >
          {showOlder
            ? "Hide devices not used for 30 days"
            : `Show ${older.length === 1 ? "1 device" : `${older.length} devices`} not used for 30 days`}
        </button>
      )}
      <div className="row">
        <Button icon={<Icon.add size={16} />} onClick={() => setAdding(true)}>
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

function SharedIdentitySettings() {
  const [enabled, setEnabled] = useState(false);
  const [linked, setLinked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call(api.sso.account)
      .then((v) => {
        setEnabled(v.enabled);
        setLinked(v.linked);
      })
      .catch(() => {});
  }, []);
  if (!enabled) return null;
  return (
    <div className="setting-row">
      <span className="setting-label">
        <strong>Walriyami shared sign-in</strong>
        <span className="field-hint">
          Link this Relay account explicitly. Your local login and public sharing keep working.
        </span>
      </span>
      <Button disabled={linked} onClick={() => setOpen(true)}>
        {linked ? "Linked" : "Link account…"}
      </Button>
      {open && (
        <Modal title="Link Walriyami" onClose={() => setOpen(false)}>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                location.assign((await call(api.sso.link, { body: { password } })).url);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            <p>Re-enter this Relay account’s password, then sign in to the Walriyami identity you want to link.</p>
            <Field label="Relay password">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            <Button type="submit" busy={busy} variant="primary">
              Continue to Walriyami
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
