import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, call, type NewLoginCode } from "../../api";
import { notifyChange } from "../../lib/live";
import { Button, Modal } from "../../components/ui";
import { ShareAccess } from "../../components/ShareAccess";

type State = "idle" | "busy" | "used" | "gone";
/** The code plus its expiry on this device's clock, which may disagree with the server's. */
type Issued = NewLoginCode & { deadline: number };
type CodeOwner = { active: boolean; creating: boolean; id: string | null };
const withdraw = (id: string) => void call(api.loginCodes.revoke, { params: { id } }).catch(() => {});

export function AddDevice({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      size="sm"
      title="Add a device"
      subtitle="Scan the QR code, copy the sign-in link, or enter the code under “Use a code” on the sign-in page."
      onClose={onClose}
    >
      <DeviceCode
        added={() => (
          <Button variant="primary" data-main onClick={onClose}>
            Done
          </Button>
        )}
      />
    </Modal>
  );
}

/**
 * A one-time code that signs another of your devices in: its QR code, link and countdown, then
 * which device used it. A code still waiting when this closes is withdrawn.
 */
export function DeviceCode({
  intro,
  added,
  onAdded,
}: {
  /** Shown above the code while it waits: how to use it, when nothing around the code says so. */
  intro?: ReactNode;
  /** What to offer once a device has signed in; `again` makes a new code. */
  added: (again: () => void) => ReactNode;
  /** A device signed in with the code, by the name it gave (null when it gave none). */
  onAdded?: (name: string | null) => void;
}) {
  const [code, setCode] = useState<Issued | null>(null);
  const [state, setState] = useState<State>("busy");
  const [addedName, setAddedName] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  // When too many codes were made in a minute: this device's clock time a new one may be asked for.
  const [retryAt, setRetryAt] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  // Each effect lifetime owns its requests and issued code, including replies before React renders.
  const owner = useRef<CodeOwner | null>(null);
  async function create() {
    const current = owner.current;
    if (!current?.active || current.creating) return;
    current.creating = true;
    setCode(null);
    setAddedName(null);
    setNow(Date.now());
    setState("busy");
    setError("");
    setRetryAt(0);
    try {
      const issued = await call(api.loginCodes.create);
      if (!current.active) {
        withdraw(issued.id);
        return;
      }
      current.id = issued.id;
      setCode({ ...issued, deadline: Date.now() + issued.expiresIn });
    } catch (e) {
      if (!current.active) return;
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 429) setRetryAt(Date.now() + (e.retryAfter ?? 60) * 1000);
    } finally {
      current.creating = false;
    }
    setState("idle");
  }
  useEffect(() => {
    const current: CodeOwner = { active: true, creating: false, id: null };
    owner.current = current;
    // Effect replay can retire this owner before the request starts. A request already sent
    // still owns its reply and withdraws a late-issued code instead of publishing stale state.
    queueMicrotask(() => {
      if (current.active) void create();
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    const reconcile = () => {
      clearInterval(timer);
      if (document.hidden) return;
      setNow(Date.now());
      timer = setInterval(() => {
        if (!document.hidden) setNow(Date.now());
      }, 1000);
    };
    reconcile();
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      current.active = false;
      if (current.id) withdraw(current.id);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", reconcile);
    };
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
    let recheck = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const check = async () => {
      if (!active || document.hidden || checking || Date.now() >= code.deadline) {
        if (active && !document.hidden && Date.now() >= code.deadline) setNow(Date.now());
        return;
      }
      checking = true;
      try {
        const status = await call(api.loginCodes.status, { params: { id } });
        if (!active || document.hidden || Date.now() >= code.deadline) return;
        if (status.state === "used" || status.state === "gone") {
          if (owner.current?.id === id) owner.current.id = null;
          active = false;
          recheck = false;
          clearInterval(timer);
        }
        if (status.state === "used") {
          setAddedName(status.deviceName ?? null);
          setState("used");
          notifyChange("devices");
          onAdded?.(status.deviceName ?? null);
        } else if (status.state === "gone") setState("gone");
      } catch {
        /* Keep the code visible on transient network errors until its expiry. */
      } finally {
        checking = false;
        if (recheck) {
          recheck = false;
          if (active && !document.hidden) void check();
        }
      }
    };
    const reconcile = () => {
      clearInterval(timer);
      if (document.hidden) return;
      // A response that arrived while hidden was ignored. If it is still in flight, check again
      // as soon as it finishes instead of waiting for the next polling interval.
      if (checking) recheck = true;
      else void check();
      if (Date.now() < code.deadline) timer = setInterval(() => void check(), 3000);
    };
    reconcile();
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", reconcile);
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
  return (
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
          {added(() => void create())}
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
        <>
          {intro}
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
        </>
      ) : state === "busy" ? (
        <p className="muted">Creating a code…</p>
      ) : null}
    </div>
  );
}
