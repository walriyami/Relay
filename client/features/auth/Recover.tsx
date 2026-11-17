// Administrator password recovery: the owner sets RELAY_RECOVER_ADMIN, restarts Relay and opens the
// one-time link it writes to the log (docs/hosting.md). This page names the account and sets its password.
import { useEffect, useRef, useState } from "react";
import { ApiError, api, call } from "../../api";
import { LIMITS } from "../../../shared/model";
import { dateTime } from "../../lib/format";
import { navigate } from "../../lib/router";
import { Button, Field, Spinner } from "../../components/ui";
import { AuthFrame } from "./Auth";

type State =
  | { kind: "checking" }
  | { kind: "ready"; username: string; expires: number }
  | { kind: "invalid"; message: string }
  | { kind: "done"; username: string };

const failure = (e: unknown) =>
  e instanceof ApiError && e.status === 429 ? "Too many attempts. Wait a minute and try again." : (e as Error).message;
/** Only the token is checked here, so a malformed request means a cut-off or mistyped link. */
const checkFailure = (e: unknown) =>
  e instanceof ApiError && e.status === 400
    ? "This link is incomplete or mistyped. Copy the whole link from the log and open it again."
    : failure(e);

export function RecoverPage() {
  // The token is a password in all but name: read it once, then take it out of the address bar and history.
  const [token] = useState(() => location.hash.slice(1));
  useEffect(() => {
    if (location.hash) history.replaceState(history.state, "", location.pathname);
  }, []);
  const [state, setState] = useState<State>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!token) {
      setState({
        kind: "invalid",
        message: "This address is missing its recovery code. Open the whole link from the log.",
      });
      return;
    }
    let cancelled = false;
    call(api.recovery.check, { body: { token } })
      .then((info) => !cancelled && setState({ kind: "ready", ...info }))
      .catch((e) => !cancelled && setState({ kind: "invalid", message: checkFailure(e) }));
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  if (state.kind === "checking")
    return (
      <AuthFrame title="Recover administrator access">
        <Spinner label="Checking the link" />
      </AuthFrame>
    );
  if (state.kind === "invalid")
    return (
      <AuthFrame title="This link can’t be used">
        <p role="alert">{state.message}</p>
        <p className="muted">
          A recovery link works once, for 24 hours. To get a new one, restart Relay with the recovery setting still on
          and open the link it writes to the log.
        </p>
        <div className="row">
          {state.message.startsWith("Too many") && <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
          <Button variant="primary" onClick={() => navigate("/", true)}>
            Go to sign in
          </Button>
        </div>
      </AuthFrame>
    );
  if (state.kind === "done")
    return (
      <AuthFrame title="Password changed">
        <p className="notice success" role="status">
          Sign in as <strong>{state.username}</strong> with the new password. Every device that was signed in to this
          account has been signed out, and its passkeys were removed.
        </p>
        <p className="muted">
          Now turn the recovery setting off again (set RELAY_RECOVER_ADMIN to nothing) so Relay stops offering links.
        </p>
        <Button variant="primary" autoFocus onClick={() => navigate("/", true)}>
          Go to sign in
        </Button>
      </AuthFrame>
    );
  return (
    <ResetForm
      token={token}
      username={state.username}
      expires={state.expires}
      onDone={(username) => setState({ kind: "done", username })}
    />
  );
}

function ResetForm({
  token,
  username,
  expires,
  onDone,
}: {
  token: string;
  username: string;
  expires: number;
  onDone: (username: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<{ field: "password" | "repeat"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const repeatInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!error) return;
    (error.field === "password" ? passwordInput : repeatInput).current?.focus();
  }, [error]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < LIMITS.passwordMin)
      return setError({ field: "password", message: `Use at least ${LIMITS.passwordMin} characters.` });
    if (password !== repeat) return setError({ field: "repeat", message: "The two passwords don’t match." });
    setError(null);
    setBusy(true);
    try {
      await call(api.recovery.reset, { body: { token, password } });
      onDone(username);
    } catch (e) {
      setError({ field: "password", message: failure(e) });
    } finally {
      setBusy(false);
    }
  }
  const errorId = "recover-error";
  return (
    <AuthFrame
      title="Recover administrator access"
      subtitle={
        <>
          Choose a new password for <strong>{username}</strong>. This link works once, until {dateTime(expires)}.
        </>
      }
    >
      <p className="muted">
        Saving signs this account out everywhere and removes its passkeys, so only the new password works afterwards.
      </p>
      <form className="stack" onSubmit={submit}>
        {/* Lets a password manager file the new password under the right account. */}
        <input type="hidden" name="username" autoComplete="username" value={username} readOnly />
        <Field label="New password">
          <input
            ref={passwordInput}
            className="input"
            type="password"
            name="new-password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            aria-invalid={error?.field === "password" || undefined}
            aria-describedby={error?.field === "password" ? errorId : undefined}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Repeat new password">
          <input
            ref={repeatInput}
            className="input"
            type="password"
            name="repeat-password"
            autoComplete="new-password"
            required
            value={repeat}
            aria-invalid={error?.field === "repeat" || undefined}
            aria-describedby={error?.field === "repeat" ? errorId : undefined}
            onChange={(e) => {
              setRepeat(e.target.value);
              setError(null);
            }}
          />
        </Field>
        {error && (
          <p id={errorId} className="field-error" role="alert">
            {error.message}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          Set password
        </Button>
      </form>
    </AuthFrame>
  );
}
