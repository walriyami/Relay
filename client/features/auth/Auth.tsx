import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, api, call, type InvitationCheck, type Me, type PickupResolution } from "../../api";
import { LIMITS, USERNAME } from "../../../shared/model";
import { dateTime } from "../../lib/format";
import { navigate } from "../../lib/router";
import { Button, Field, Spinner } from "../../components/ui";
import { Brand } from "../../app/Brand";
import { CodeEntryForm, codeDigits } from "../codes/CodeEntry";
import { browserName } from "./device-name";
import { passkeyDismissed, passkeysSupported, signInWithPasskey } from "./passkeys";

const signInError = (e: unknown) =>
  e instanceof ApiError && e.status === 429 ? "Too many attempts. Wait a minute and try again." : (e as Error).message;

/** A form error that belongs to one field: the field is focused and selected, and describes itself with it. */
type FieldError<F extends string> = { field: F; message: string } | null;
function useFocusOnError<F extends string>(
  error: FieldError<F>,
  fields: Record<F, RefObject<HTMLInputElement | null>>,
) {
  useEffect(() => {
    if (!error) return;
    const input = fields[error.field].current;
    input?.focus();
    input?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus the field only when a new error arrives.
  }, [error]);
}
const describedBy = (invalid: boolean, ...ids: (string | false)[]) => ({
  "aria-invalid": invalid || undefined,
  "aria-describedby": ids.filter(Boolean).join(" ") || undefined,
});

export function AuthFrame({
  title,
  subtitle,
  children,
  side,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  side?: ReactNode;
}) {
  return (
    <main className={side ? "auth auth-split" : "auth"} tabIndex={-1}>
      {side && (
        <div className="auth-page-brand">
          <Brand />
        </div>
      )}
      <div className="auth-card card-surface">
        {!side && <Brand />}
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {children}
      </div>
      {side}
    </main>
  );
}

export function SignIn({ onSignedIn, notice }: { onSignedIn: (me: Me) => void; notice?: string }) {
  // Consume bearer parameters from the address before making requests.
  const [loginCode] = useState(() => new URLSearchParams(location.search).get("login"));
  const [deviceToken, setDeviceToken] = useState(() => new URLSearchParams(location.search).get("device"));
  useEffect(() => {
    if (loginCode || deviceToken) history.replaceState(history.state, "", location.pathname);
  }, [loginCode, deviceToken]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<FieldError<"username" | "password">>(null);
  const [passkeyError, setPasskeyError] = useState("");
  const [passkeyHint, setPasskeyHint] = useState(false);
  const [busy, setBusy] = useState<"" | "form" | "passkey">("");
  const passwordInput = useRef<HTMLInputElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  useFocusOnError(error, { username: usernameInput, password: passwordInput });
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPasskeyError("");
    // Nothing to check yet: say so here rather than spending a sign-in attempt on it.
    if (!username.trim()) return setError({ field: "username", message: "Enter your username." });
    if (!password) return setError({ field: "password", message: "Enter your password." });
    setBusy("form");
    try {
      onSignedIn(
        await call(api.session.password, { body: { username: username.trim(), password, deviceName: browserName() } }),
      );
    } catch (e) {
      setError({ field: "password", message: signInError(e) });
    } finally {
      setBusy("");
    }
  }
  async function openCode(destination: PickupResolution, code: string) {
    if (destination.kind === "device") {
      // Resolution only identifies the recipient. Redeeming here preserves the one-time sign-in
      // behavior and keeps the issuing device's owner-only status check authoritative.
      onSignedIn(await call(api.session.code, { body: { code: codeDigits(code), deviceName: browserName() } }));
    } else {
      navigate(destination.path, true);
    }
  }
  async function passkey() {
    setError(null);
    setPasskeyError("");
    setPasskeyHint(false);
    setBusy("passkey");
    try {
      onSignedIn(await signInWithPasskey());
    } catch (e) {
      // Browsers report "no passkey on this device" the same way as a cancelled prompt, so the
      // dismissal gets a quiet hint rather than an error.
      if (passkeyDismissed(e)) setPasskeyHint(true);
      else setPasskeyError(signInError(e));
    } finally {
      setBusy("");
    }
  }
  const errorId = "sign-in-error";
  const message = error?.message || passkeyError;
  if (deviceToken)
    return <DeviceLinkSignIn token={deviceToken} onSignedIn={onSignedIn} onCancel={() => setDeviceToken(null)} />;
  return (
    <AuthFrame
      title="Sign in"
      subtitle={
        loginCode ? "Sign in on this device with the code from your other device." : "Access your files and devices."
      }
      side={
        <section className="auth-card auth-code-card card-surface" aria-labelledby="code-entry-title">
          <div>
            <h2 id="code-entry-title">Use a code</h2>
            <p className="muted">
              {loginCode
                ? "On a device that’s already signed in, choose Add a device on the Send page or in Settings › Devices. Other Relay codes open their destination here."
                : "Sign in, open a share, upload to a request, or accept an invitation."}
            </p>
          </div>
          <CodeEntryForm
            page
            initialCode={loginCode || ""}
            autoFocus={!!loginCode}
            fieldLabel="Code"
            onOpen={openCode}
          />
        </section>
      }
    >
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <form className="stack" onSubmit={submit}>
        <Field label="Username">
          <input
            className="input"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            ref={usernameInput}
            autoFocus={!loginCode}
            required
            value={username}
            {...describedBy(error?.field === "username", error?.field === "username" && errorId)}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Password">
          <input
            ref={passwordInput}
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            {...describedBy(error?.field === "password", error?.field === "password" && errorId)}
          />
        </Field>
        {message && (
          <p id={errorId} className="field-error" role="alert">
            {message}
          </p>
        )}
        {passkeyHint && !message && (
          <p className="muted" role="status">
            No passkey was used. If this device has no passkey for Relay, sign in with your password, then add one in
            Settings.
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy === "form"} disabled={busy === "passkey"}>
          Sign in
        </Button>
        {passkeysSupported() && (
          <Button icon={<KeyRound size={16} />} busy={busy === "passkey"} disabled={busy === "form"} onClick={passkey}>
            Sign in with a passkey
          </Button>
        )}
      </form>
    </AuthFrame>
  );
}

// Mirrors USERNAME in shared/model.ts.
const USERNAME_RULE = "3–32 characters: lowercase letters, numbers, - and _, starting with a letter or number.";
/** Why a finished username doesn't fit the rule, in the person's terms. */
function usernameProblem(value: string) {
  if (USERNAME.test(value)) return "";
  if (value.length < 3) return "Use at least 3 characters.";
  if (!/^[a-z0-9]/.test(value)) return "Start with a letter or number.";
  return USERNAME_RULE;
}
const USERNAME_CHAR = /[a-z0-9_-]/;
/** Names what typing just refused, e.g. "Spaces can’t be used in a username." */
function describeRefused(typed: string) {
  const refused = [...new Set(typed)].filter((c) => !USERNAME_CHAR.test(c));
  const list = refused.map((c) => (c === " " ? "spaces" : `“${c}”`)).join(", ");
  return `${list[0].toUpperCase()}${list.slice(1)} can’t be used in a username.`;
}

type Invitation =
  | { state: "checking" }
  | { state: "open"; invite: InvitationCheck }
  | { state: "gone" }
  | { state: "error"; message: string };

export function Join({ token, onSignedIn }: { token: string; onSignedIn: (me: Me) => void }) {
  const [invitation, setInvitation] = useState<Invitation>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setInvitation({ state: "checking" });
    call(api.session.invitation, { params: { token } })
      .then((invite) => live && setInvitation({ state: "open", invite }))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && (e.status === 410 || e.status === 404)) setInvitation({ state: "gone" });
        else setInvitation({ state: "error", message: signInError(e) });
      });
    return () => {
      live = false;
    };
  }, [token, attempt]);
  const signInInstead = (
    <div className="auth-alt">
      <span className="muted">Already have an account?</span>{" "}
      <button type="button" className="link" onClick={() => navigate("/", true)}>
        Sign in
      </button>
    </div>
  );
  switch (invitation.state) {
    case "checking":
      return (
        <AuthFrame title="Create your account">
          <Spinner label="Checking your invitation" />
        </AuthFrame>
      );
    case "error":
      return (
        <AuthFrame title="Create your account">
          <p className="notice" role="alert">
            {invitation.message}
          </p>
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
          {signInInstead}
        </AuthFrame>
      );
    case "gone":
      return (
        <AuthFrame
          title="This invitation can’t be used"
          subtitle="It expired, was already used or was withdrawn. Ask the person who invited you for a new link."
        >
          {signInInstead}
        </AuthFrame>
      );
    case "open":
      return (
        <JoinForm
          token={token}
          invite={invitation.invite}
          onGone={() => setInvitation({ state: "gone" })}
          onSignedIn={onSignedIn}
          footer={signInInstead}
        />
      );
  }
}

function JoinForm({
  token,
  invite,
  onGone,
  onSignedIn,
  footer,
}: {
  token: string;
  invite: InvitationCheck;
  onGone: () => void;
  onSignedIn: (me: Me) => void;
  footer: ReactNode;
}) {
  const [username, setUsername] = useState("");
  const [usernameNote, setUsernameNote] = useState("");
  useEffect(() => {
    if (!usernameNote) return;
    const timer = setTimeout(() => setUsernameNote(""), 5000);
    return () => clearTimeout(timer);
  }, [usernameNote]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<FieldError<"username" | "password" | "confirm">>(null);
  const [busy, setBusy] = useState(false);
  const fields = {
    username: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  useFocusOnError(error, fields);
  const usernameError = error?.field === "username" ? error.message : "";
  // The rule stays under the field; a problem replaces it until the name is edited.
  const usernameHint = usernameError || (usernameNote ? `${usernameNote} ${USERNAME_RULE}` : "");
  const errorId = "join-error";
  const fieldProps = (field: "password" | "confirm") =>
    describedBy(error?.field === field, error?.field === field && errorId);
  return (
    <AuthFrame
      title="Create your account"
      subtitle={`${invite.invitedBy} invited you to Relay. This invitation works once, until ${dateTime(invite.expires)}.`}
    >
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          const name = username.trim();
          const problem = usernameProblem(name);
          if (problem) return setError({ field: "username", message: problem });
          if (password !== confirm) return setError({ field: "confirm", message: "The passwords don’t match." });
          setBusy(true);
          try {
            const me = await call(api.session.join, {
              body: { token, username: name, password, deviceName: browserName() },
            });
            navigate("/", true);
            onSignedIn(me);
          } catch (e) {
            if (e instanceof ApiError && e.status === 410) return onGone();
            if (e instanceof ApiError && e.status === 409) setError({ field: "username", message: e.message });
            else setError({ field: "password", message: signInError(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Username"
          after={
            <span
              id="join-username-hint"
              className={usernameHint ? "field-error" : "field-hint"}
              role={usernameError ? "alert" : undefined}
              aria-live={usernameError ? undefined : "polite"}
            >
              {usernameHint || USERNAME_RULE}
            </span>
          }
        >
          <input
            ref={fields.username}
            className="input"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            maxLength={32}
            value={username}
            onChange={(e) => {
              const typed = e.target.value.toLowerCase();
              const kept = [...typed].filter((c) => USERNAME_CHAR.test(c)).join("");
              // The note stays a few seconds, so it isn't wiped by the very next keystroke.
              if (kept !== typed) setUsernameNote(describeRefused(typed));
              else if (!kept) setUsernameNote("");
              if (error?.field === "username") setError(null);
              setUsername(kept);
            }}
            {...describedBy(!!usernameError, "join-username-hint")}
          />
        </Field>
        <Field label="Password" hint={`At least ${LIMITS.passwordMin} characters`}>
          <input
            ref={fields.password}
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={LIMITS.passwordMin}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            {...fieldProps("password")}
          />
        </Field>
        <Field label="Confirm password">
          <input
            ref={fields.confirm}
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={LIMITS.passwordMin}
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            {...fieldProps("confirm")}
          />
        </Field>
        {error && error.field !== "username" && (
          <p id={errorId} className="field-error" role="alert">
            {error.message}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          Create account
        </Button>
      </form>
      {footer}
    </AuthFrame>
  );
}

/** Long sign-in links survive code rotation, with the same expiry and one-time use as their code. */
function DeviceLinkSignIn({
  token,
  onSignedIn,
  onCancel,
}: {
  token: string;
  onSignedIn: (me: Me) => void;
  onCancel: () => void;
}) {
  const started = useRef(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  async function redeem() {
    setBusy(true);
    setError("");
    try {
      onSignedIn(await call(api.session.deviceLink, { body: { token, deviceName: browserName() } }));
    } catch (e) {
      setError(signInError(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void redeem();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the link's code is redeemed once, on load.
  }, []);
  return (
    <AuthFrame title="Sign in on this device">
      {busy ? (
        <p role="status">Signing in…</p>
      ) : (
        <>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" onClick={() => void redeem()}>
            Try again
          </Button>
          <Button onClick={onCancel}>Back to sign in</Button>
        </>
      )}
    </AuthFrame>
  );
}
