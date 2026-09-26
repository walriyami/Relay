import { useEffect, useRef, useState } from "react";
import { ApiError, api, call, type NewLoginCode } from "../../api";
import { notifyChange } from "../../lib/live";
import { Button, Modal } from "../../components/ui";
import { ShareAccess } from "../../components/ShareAccess";

type State = "idle" | "busy" | "used" | "gone";
/** The code plus its expiry on this device's clock, which may disagree with the server's. */
type Issued = NewLoginCode & { deadline: number };

export function AddDevice({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<Issued | null>(null);
  const [state, setState] = useState<State>("busy");
  const [addedName, setAddedName] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  // When too many codes were made in a minute: this device's clock time a new one may be asked for.
  const [retryAt, setRetryAt] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  async function create() {
    setCode(null);
    setAddedName(null);
    setNow(Date.now());
    setState("busy");
    setError("");
    setRetryAt(0);
    try {
      const issued = await call(api.loginCodes.create);
      setCode({ ...issued, deadline: Date.now() + issued.expiresIn });
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 429) setRetryAt(Date.now() + (e.retryAfter ?? 60) * 1000);
    }
    setState("idle");
  }
  useEffect(() => {
    void create();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const expired = !!code && code.deadline <= now;
  const waiting = !!code && !expired && state === "idle";
  // Only the server knows which device actually redeemed this particular code. A different
  // sign-in during the countdown must never be mistaken for success.
  useEffect(() => {
    if (!waiting || !code) return;
    const id = code.id;
    let active = true;
    let checking = false;
    const check = async () => {
      if (!active || checking || Date.now() >= code.deadline) {
        if (Date.now() >= code.deadline) setNow(Date.now());
        return;
      }
      checking = true;
      try {
        const status = await call(api.loginCodes.status, { params: { id } });
        if (!active || Date.now() >= code.deadline) return;
        if (status.state === "used") {
          setAddedName(status.deviceName ?? null);
          setState("used");
          notifyChange("devices");
        } else if (status.state === "gone") setState("gone");
      } catch {
        /* Keep the code visible on transient network errors until its expiry. */
      } finally {
        checking = false;
      }
    };
    void check();
    const t = setInterval(() => void check(), 3000);
    return () => {
      active = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll per code, not per render.
  }, [code?.id, waiting]);
  const url = code ? `${location.origin}/?device=${encodeURIComponent(code.token)}` : "";
  const left = code ? Math.max(0, Math.ceil((code.deadline - now) / 1000)) : 0;
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  const view =
    state === "used" ? "used" : expired || state === "gone" ? "ended" : error ? "error" : code ? "code" : "busy";
  // Each new state puts focus on its main action, as every other handoff does: Copy sign-in link
  // once the code is shown, otherwise Done, Create a new code or Try again.
  useEffect(() => {
    if (view === "busy") return;
    body.current?.querySelector<HTMLElement>(".share-access-copy, [data-main]")?.focus({ preventScroll: true });
  }, [view, code?.id]);
  const close = () => {
    if (waiting && code) void call(api.loginCodes.revoke, { params: { id: code.id } }).catch(() => {});
    onClose();
  };
  return (
    <Modal
      size="sm"
      title="Add a device"
      subtitle="Scan the QR code, copy the sign-in link, or enter the code under “Use a code” on the sign-in page."
      onClose={close}
    >
      <div className="login-code" ref={body}>
        {error && (
          <p className="notice" role="alert">
            {retryAt ? "Too many new codes in a minute." : error}
          </p>
        )}
        {state === "used" ? (
          <>
            <p className="notice success" role="status">
              {addedName ? `${addedName} is signed in.` : "The new device is signed in."}
            </p>
            <Button variant="primary" data-main onClick={onClose}>
              Done
            </Button>
          </>
        ) : expired || state === "gone" ? (
          <>
            <p className="muted" role="status">
              {expired ? "This code expired." : "This code no longer works."}
            </p>
            <Button variant="primary" data-main onClick={() => void create()}>
              Create a new code
            </Button>
          </>
        ) : error ? (
          <Button
            variant="primary"
            data-main
            // Unavailable rather than disabled while it counts down, so focus stays on it.
            aria-disabled={wait > 0 || undefined}
            onClick={() => wait === 0 && void create()}
          >
            {wait > 0 ? `Try again in ${wait} s` : "Try again"}
          </Button>
        ) : code ? (
          <ShareAccess
            url={url}
            code={code.code}
            codeLabel="Sign-in code"
            purpose="device sign-in"
            copyLabel="Copy sign-in link"
            detail={
              <>
                <p role="timer" aria-live="off">
                  Works once · Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                </p>
                <p className="field-hint">Anyone with this code can sign in as you. Only use it on your own devices.</p>
              </>
            }
          />
        ) : state === "busy" ? (
          <p className="muted">Creating a code…</p>
        ) : null}
      </div>
    </Modal>
  );
}
