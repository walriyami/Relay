import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";
import {
  Download,
  FolderInput,
  FolderOpen,
  Link2,
  LogOut,
  Monitor,
  Moon,
  Send,
  Settings,
  Shield,
  Sun,
} from "lucide-react";
import {
  ApiError,
  api,
  call,
  displayName,
  setCsrf,
  setPrincipal,
  type Me,
  type SessionEnded,
  type SetupState,
} from "../api";
import { navigate, useRoute, useSearch } from "../lib/router";
import { connectLive, disconnectLive, onChange } from "../lib/live";
import { abandonAll, isBusy, setTransferPrefs, transfers } from "../lib/transfers";
import { clearDraft } from "../lib/draft";
import { setLocalPrefs, useLocalPrefs } from "../lib/local-prefs";
import { Button, ConfirmHost, Popover, Spinner, Toaster, confirmDialog, menuKeys } from "../components/ui";
import { AuthFrame, SignIn, Join } from "../features/auth/Auth";
import { Setup } from "../features/setup/Setup";
import { SendPage } from "../features/send/SendPage";
import { FilesPage } from "../features/library/FilesPage";
import { ActivityProvider } from "../features/activity/ActivityProvider";
import { ActivityButton } from "../features/activity/ActivityButton";
import { CodeButton } from "../features/codes/CodeButton";
import { LinksPage } from "../features/links/LinksPage";
import { RequestsPage } from "../features/requests/RequestsPage";
import { GuestUpload, PickupPage, PublicSharePage } from "./PublicPages";
import { SessionProvider, useSession, type SetMe } from "./session";
import { ConnectionBar, ConnectionScreen } from "../components/ConnectionStatus";
import { connection, onConnectivity } from "../lib/connection";
import { Brand } from "./Brand";
import { PageBoundary, pageRetries } from "./PageBoundary";
import type { SettingsPage as SettingsPageComponent } from "../features/settings/SettingsPage";

// Settings and Admin are visited rarely (Admin by one person), so they load on first visit.
// A load that failed (offline, a deploy replaced the chunk) is forgotten, so the next visit tries again.
/**
 * The address of a page chunk that failed to load. Browsers remember a failed module import for
 * good, so trying again means asking for the same file under a fresh address.
 */
function failedChunk(error: unknown, name: string) {
  const named = /(https?:\/\/\S+?\.js)\b/.exec(error instanceof Error ? error.message : "")?.[1];
  if (named) return named;
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .reverse()
    .find((url) => new URL(url).pathname.startsWith(`/assets/${name}-`));
}

/** A lazily loaded page whose "Try again" really fetches its chunk again after a failure. */
function lazyPage<P extends object>(name: string, load: () => Promise<Record<string, unknown>>) {
  let retry: string | undefined;
  let failedAt: number | undefined;
  const make = () =>
    lazy(() =>
      (retry ? import(/* @vite-ignore */ `${retry.split("?")[0]}?retry=${Date.now()}`) : load()).then(
        (module: Record<string, unknown>) => ({ default: module[name] as ComponentType<P> }),
        (error: unknown) => {
          retry = failedChunk(error, name) ?? retry;
          failedAt = pageRetries();
          throw error;
        },
      ),
    );
  let Loaded = make();
  return (props: P) => {
    // A failed load stays failed until the person asks to try again; only then fetch anew.
    if (failedAt !== undefined && failedAt !== pageRetries()) {
      failedAt = undefined;
      Loaded = make();
    }
    return <Loaded {...props} />;
  };
}
const SettingsPage = lazyPage<ComponentProps<typeof SettingsPageComponent>>(
  "SettingsPage",
  () => import("../features/settings/SettingsPage"),
);
const AdminPage = lazyPage("AdminPage", () => import("../features/admin/AdminPage"));

/** What the sign-in screen says after the session ended while this tab was open. */
const ENDED: Record<SessionEnded["reason"], string> = {
  suspended: "Your account was suspended by the administrator.",
  "signed-out": "This device was signed out.",
  "password-reset": "The administrator set a new password for your account. Sign in with it to continue.",
  "password-changed": "Your password was changed on another device. Sign in with the new password.",
  expired: "Your session ended. Sign in again to continue.",
};

export function App() {
  const route = useRoute();
  const parts = route.split("/").filter(Boolean);
  if (parts[0] === "s" && parts[1])
    return (
      <Public>
        <PublicSharePage token={parts[1]} />
      </Public>
    );
  if (parts[0] === "r" && parts[1])
    return (
      <Public>
        <GuestUpload token={parts[1]} />
      </Public>
    );
  if (parts[0] === "pickup")
    return (
      <Public>
        <PickupPage />
      </Public>
    );
  return <Private />;
}

function Public({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="public-conn">
        <ConnectionBar />
      </div>
      {children}
      <Toaster />
      <ConfirmHost />
    </>
  );
}

function Private() {
  const route = useRoute();
  const search = useSearch();
  const parts = route.split("/").filter(Boolean);
  const [me, setMe] = useState<Me | null>(null);
  /** Stays as it was at load until setup's last screen is left, however far setup got meanwhile. */
  const [setup, setSetup] = useState<SetupState>("done");
  const [loading, setLoading] = useState(true);
  /** The first session check failed for a reason other than being signed out. */
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const previousPrincipal = useRef<string | null>(null);
  const sessionRevision = useRef(0);
  const signedIn = useCallback((data: Me) => {
    sessionRevision.current++;
    const principal = `${data.user.id}:${data.device.id}`;
    if (previousPrincipal.current && previousPrincipal.current !== principal) {
      // Another sign-in in this tab starts clean: it never inherits someone else's work or draft.
      void abandonAll();
      clearDraft();
    }
    previousPrincipal.current = principal;
    setPrincipal(principal);
    setCsrf(data.csrf);
    setTransferPrefs(data.prefs);
    setMe(data);
    setNotice("");
  }, []);
  // Signing in on this screen lands on the page's main area, however it happened (a device link
  // signs in with nothing focused).
  const signedInHere = useCallback(
    (data: Me) => {
      signedIn(data);
      setTimeout(() => {
        const now = document.activeElement;
        if (!now || now === document.body || !now.isConnected)
          document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
      });
    },
    [signedIn],
  );
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the server saying "no session" means signed out; an outage keeps the cookie and retries.
    const session = call(api.session.get).catch((error) => {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    });
    Promise.all([session, call(api.setup.status)])
      .then(([data, status]) => {
        if (cancelled) return;
        setUnreachable(false);
        setSetup(status.state);
        if (data) signedIn(data);
        else setMe(null);
      })
      .catch(() => {
        if (cancelled) return;
        setUnreachable(true);
        timer = setTimeout(() => setAttempt((n) => n + 1), Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4)));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signedIn, attempt]);
  // Opens as soon as Relay can be reached again, rather than at the next scheduled try.
  useEffect(() => {
    if (!unreachable) return;
    return onConnectivity(() => {
      if (connection().state === "ok") setAttempt((n) => n + 1);
    });
  }, [unreachable]);
  const updateMe = useCallback<SetMe>((update) => {
    // A response started before a saved change must not replace that newer state.
    sessionRevision.current++;
    setMe((current) => (current && typeof update === "function" ? update(current) : (update as Me)));
  }, []);
  // Refreshing (for example storage usage) never signs the user out on a blip.
  const refresh = useCallback(async () => {
    const revision = ++sessionRevision.current;
    const data = await call(api.session.get);
    if (revision === sessionRevision.current) signedIn(data);
  }, [signedIn]);
  useEffect(() => {
    if (!me) return;
    connectLive();
    // Preferences and usage can change from another device.
    const offAccount = onChange("account", () => void refresh().catch(() => {}));
    // From a 401 on any request, or from the event stream with the server's reason.
    // Only the first report counts: requests failing right after the stream's reason must not replace it.
    let expired = false;
    const expire = (event: Event) => {
      if (expired) return;
      expired = true;
      const reason = (event as CustomEvent<SessionEnded | undefined>).detail?.reason;
      // Name what the sign-out interrupted: those uploads can't continue under another sign-in.
      const stopped = transfers.filter((t) => isBusy(t) && !t.guest).map((t) => t.name);
      void abandonAll();
      disconnectLive();
      setPrincipal(null);
      setCsrf("");
      setMe(null);
      setNotice(
        ENDED[reason ?? "expired"] +
          (stopped.length
            ? ` ${stopped.length === 1 ? `Your upload of ${stopped[0]}` : `${stopped.length} uploads`} stopped; anything that finished uploading is saved in Files.`
            : ""),
      );
    };
    window.addEventListener("relay-session-expired", expire);
    return () => {
      offAccount();
      disconnectLive();
      window.removeEventListener("relay-session-expired", expire);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when the signed-in user or device changes.
  }, [me?.user.id, me?.device.id]);
  if (loading)
    return (
      <main className="boot" tabIndex={-1}>
        <Spinner label="Opening Relay" />
      </main>
    );
  if (unreachable && !me)
    return (
      <main className="boot" tabIndex={-1}>
        <ConnectionScreen onRetry={() => setAttempt((n) => n + 1)} />
      </main>
    );
  // Before anyone has an account, and for the administrator until they finish choosing what members get.
  if (setup === "account" || (setup === "defaults" && me?.user.admin))
    return (
      <Public>
        <Setup
          state={setup}
          onSignedIn={signedInHere}
          onFinished={() => {
            setSetup("done");
            navigate("/", true);
          }}
        />
      </Public>
    );
  if (!me) {
    if (parts[0] === "join" && parts[1])
      return (
        <Public>
          <Join token={parts[1]} onSignedIn={signedInHere} />
        </Public>
      );
    return (
      <Public>
        <SignIn onSignedIn={signedInHere} notice={notice} />
      </Public>
    );
  }
  // A sign-in link from Add a device, opened on a browser that is already signed in.
  const loginCode = new URLSearchParams(search).get("login");
  const deviceToken = new URLSearchParams(search).get("device");
  if (loginCode || deviceToken)
    return (
      <Public>
        <SignedInLoginCode
          me={me}
          code={loginCode || ""}
          token={deviceToken || undefined}
          onSignedOut={() => setMe(null)}
        />
      </Public>
    );
  if (parts[0] === "join")
    return (
      <Public>
        <SignedInInvitation me={me} token={parts[1] ?? ""} onSignedOut={() => setMe(null)} />
      </Public>
    );
  return (
    <SessionProvider me={me} setMe={updateMe} refreshMe={refresh}>
      <Shell onSignedOut={() => setMe(null)} />
      <Toaster />
      <ConfirmHost />
    </SessionProvider>
  );
}

const NAV = [
  { to: "/", label: "Send", icon: <Send size={20} aria-hidden /> },
  { to: "/files", label: "Files", icon: <FolderOpen size={20} aria-hidden /> },
  { to: "/links", label: "Links", icon: <Link2 size={20} aria-hidden /> },
  { to: "/requests", label: "Requests", icon: <FolderInput size={20} aria-hidden /> },
];

function NotFound() {
  return (
    <div className="page not-found">
      <h1>Page not found</h1>
      <p className="muted">This address doesn’t exist in Relay.</p>
      <Button variant="primary" onClick={() => navigate("/")}>
        Go to Send
      </Button>
    </div>
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const { me } = useSession();
  const route = useRoute();
  const section = "/" + (route.split("/")[1] || "");
  let page: React.ReactNode;
  switch (section) {
    case "/":
      page = <SendPage />;
      break;
    case "/files":
      page = <FilesPage key="files" />;
      break;
    case "/trash":
      page = <FilesPage key="trash" trash />;
      break;
    case "/links":
      page = <LinksPage />;
      break;
    case "/requests":
      page = <RequestsPage />;
      break;
    case "/settings":
      page = <SettingsPage onSignedOut={onSignedOut} />;
      break;
    case "/admin":
      // Members get the same answer as for any unknown address, without loading the admin page.
      page = me.user.admin ? <AdminPage /> : <NotFound />;
      break;
    default:
      page = <NotFound />;
  }
  return (
    <ActivityProvider>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Brand />
            <nav className="nav" aria-label="Main">
              {NAV.map((item) => {
                const active = section === item.to || (item.to === "/files" && section === "/trash");
                return (
                  <a
                    key={item.to}
                    href={item.to}
                    className={active ? "nav-link active" : "nav-link"}
                    aria-current={active ? "page" : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      event.preventDefault();
                      navigate(item.to);
                    }}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </a>
                );
              })}
            </nav>
            <div className="topbar-actions">
              <CodeButton />
              <ActivityButton />
              <AccountMenu onSignedOut={onSignedOut} active={section === "/settings" || section === "/admin"} />
            </div>
          </div>
          <ConnectionBar />
        </header>
        <main id="main" className="main" tabIndex={-1}>
          <PageBoundary key={section}>
            <Suspense
              fallback={
                <div className="page">
                  <Spinner />
                </div>
              }
            >
              {page}
            </Suspense>
          </PageBoundary>
        </main>
      </div>
    </ActivityProvider>
  );
}

function AccountMenu({ onSignedOut, active }: { onSignedOut: () => void; active: boolean }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => {
    // The trigger takes focus first so a dialog opened from here returns focus to it.
    button.current?.focus();
    setOpen(false);
  };
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);
  const go = (to: string) => {
    close();
    navigate(to);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`avatar-button ${active ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${displayName(me.user)}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden>
          {displayName(me.user)[0]?.toUpperCase()}
        </span>
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Account" className="account-popover">
          <div className="account-head">
            <strong>{displayName(me.user)}</strong>
            <span className="muted">{me.user.name ? `${me.user.username} · ${me.device.name}` : me.device.name}</span>
          </div>
          <div className="menu-list" role="menu" ref={list} onKeyDown={menuKeys(list, button, () => setOpen(false))}>
            <button role="menuitem" className="menu-item" onClick={() => go("/settings")}>
              <Settings size={16} aria-hidden /> Settings
            </button>
            {me.user.admin && (
              <button role="menuitem" className="menu-item" onClick={() => go("/admin")}>
                <Shield size={16} aria-hidden /> Admin
              </button>
            )}
            <div className="menu-sep" role="separator" />
            <ThemeSwitch />
            <AutoAcceptSwitch />
            <div className="menu-sep" role="separator" />
            <button
              role="menuitem"
              className="menu-item"
              onClick={async () => {
                close();
                if (await confirmSignOut()) {
                  await signOut();
                  onSignedOut();
                }
              }}
            >
              <LogOut size={16} aria-hidden /> Sign out
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/** Light / Dark / System, right in the account menu; the same setting as in Settings. */
function ThemeSwitch() {
  const { theme } = useLocalPrefs();
  return (
    // Inside the account menu, so a group of menu radios rather than a radiogroup.
    <div className="theme-switch" role="group" aria-labelledby="theme-switch-label">
      <span id="theme-switch-label">Theme</span>
      <div className="theme-switch-options">
        {THEMES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={theme === value}
            aria-label={label}
            title={label}
            onClick={() => setLocalPrefs({ theme: value })}
          >
            <Icon size={15} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Accepting what your other devices send, right in the account menu; the same setting as in Settings. */
function AutoAcceptSwitch() {
  const { autoAccept } = useLocalPrefs();
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={autoAccept}
      className="menu-item menu-switch"
      title="Items your other devices send here download as soon as they arrive"
      onClick={() => setLocalPrefs({ autoAccept: !autoAccept })}
    >
      <Download size={16} aria-hidden />
      <span>Auto-accept</span>
      <span className="switch-visual" aria-hidden />
    </button>
  );
}

// Signing out abandons this tab's uploads, so say so first.
export async function confirmSignOut() {
  const n = transfers.filter(isBusy).length;
  if (!n) return true;
  return confirmDialog({
    title: `Sign out and cancel ${n === 1 ? "1 upload" : `${n} uploads`}?`,
    body: "Uploads in progress in this tab stop, and anything not finished is discarded.",
    confirm: "Sign out",
    danger: true,
  });
}

/** Signs this browser out and lands on `to` (the sign-in screen unless it names another page). */
export async function signOut(to = "/") {
  await abandonAll();
  // Closed first, so the server's "signed out" notice for this device doesn't come back to this tab.
  disconnectLive();
  await call(api.session.signOut).catch(() => {});
  clearDraft();
  setPrincipal(null);
  setCsrf("");
  navigate(to, true);
}

/** A sign-in code opened while signed in: using it here would need this browser signed out first. */
function SignedInLoginCode({
  me,
  code,
  token,
  onSignedOut,
}: {
  me: Me;
  code: string;
  token?: string;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Validate the handoff before offering to sign out of the current account.
  const handoff = token ? `device:${token}` : `code:${code}`;
  const [validation, setValidation] = useState<{
    handoff: string;
    state: "checking" | "ready" | "gone" | "error";
    error?: string;
  }>({ handoff, state: "checking" });
  const [retry, setRetry] = useState(0);
  const state = validation.handoff === handoff ? validation.state : "checking";
  const noun = token ? "link" : "code";
  useEffect(() => {
    let live = true;
    setValidation({ handoff, state: "checking" });
    const check = token
      ? call(api.session.deviceLinkCheck, { params: { token } }).then(() => true)
      : call(api.pickup.resolve, { body: { code } }).then((found) => found.kind === "device");
    check
      .then((usable) => {
        if (live) setValidation({ handoff, state: usable ? "ready" : "gone" });
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && (e.status === 410 || e.status === 404)) setValidation({ handoff, state: "gone" });
        else
          setValidation({
            handoff,
            state: "error",
            error: (e as Error).message || "Could not check this sign-in. Try again.",
          });
      });
    return () => {
      live = false;
    };
  }, [code, token, handoff, retry]);
  if (state !== "ready")
    return (
      <AuthFrame
        title={
          state === "gone"
            ? `This sign-in ${noun} can’t be used`
            : state === "error"
              ? `Couldn’t check this sign-in ${noun}`
              : `Checking sign-in ${noun}`
        }
        subtitle={
          state === "gone"
            ? `It expired, was already used or was withdrawn. You’re still signed in as ${me.user.username}.`
            : `You’re still signed in as ${me.user.username}.`
        }
      >
        <div className="stack">
          {state === "checking" && <p role="status">Checking this {noun}…</p>}
          {state === "error" && (
            <p className="field-error" role="alert">
              {validation.error}
            </p>
          )}
          <Button variant="primary" autoFocus onClick={() => navigate("/", true)}>
            Keep using Relay
          </Button>
          {state === "error" && <Button onClick={() => setRetry((value) => value + 1)}>Try again</Button>}
        </div>
      </AuthFrame>
    );
  return (
    <AuthFrame
      title={`This browser is already signed in as ${me.user.username}`}
      subtitle={`The ${token ? "link" : "code"} signs a new device in. To use it here instead, sign out first.`}
    >
      <div className="stack">
        <Button variant="primary" autoFocus onClick={() => navigate("/", true)} disabled={busy}>
          Keep using Relay
        </Button>
        <Button
          busy={busy}
          onClick={async () => {
            if (!(await confirmSignOut())) return;
            setBusy(true);
            await signOut(token ? `/?device=${encodeURIComponent(token)}` : `/?login=${encodeURIComponent(code)}`);
            onSignedOut();
          }}
        >
          Sign out and use the {token ? "link" : "code"}
        </Button>
      </div>
    </AuthFrame>
  );
}

/** An invitation opened while signed in: joining would need this browser signed out first. */
function SignedInInvitation({ me, token, onSignedOut }: { me: Me; token: string; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  // Only a working invitation is worth signing out for.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    call(api.session.invitation, { params: { token } }).catch((e) => {
      if (live && e instanceof ApiError && (e.status === 410 || e.status === 404)) setGone(true);
    });
    return () => {
      live = false;
    };
  }, [token]);
  if (gone)
    return (
      <AuthFrame
        title="This invitation can’t be used"
        subtitle={`It expired, was already used or was withdrawn. You’re still signed in as ${me.user.username}.`}
      >
        <Button variant="primary" autoFocus onClick={() => navigate("/", true)}>
          Go to Relay
        </Button>
      </AuthFrame>
    );
  return (
    <AuthFrame
      title={`You’re signed in as ${me.user.username}`}
      subtitle="Sign out to use this invitation and create a new account."
    >
      <div className="stack">
        <Button
          variant="primary"
          autoFocus
          busy={busy}
          onClick={async () => {
            if (!(await confirmSignOut())) return;
            setBusy(true);
            await signOut(token ? `/join/${token}` : "/");
            onSignedOut();
          }}
        >
          Sign out
        </Button>
        <Button disabled={busy} onClick={() => navigate("/", true)}>
          Go to Relay
        </Button>
      </div>
    </AuthFrame>
  );
}
