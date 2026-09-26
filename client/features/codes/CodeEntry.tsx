import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api, call, type PickupResolution } from "../../api";
import { formatCode, normalizeCode, type CodeLength } from "../../../shared/codes";
import { useCodeConfig } from "./config";

/** Remove only Relay's visible separator. Invalid letters remain invalid at request boundaries. */
export const codeDigits = (code: string) => code.replaceAll("-", "");

const digitsIn = (value: string) => value.replaceAll("-", "");
function formatForLength(digits: string, length: CodeLength) {
  if (digits.length === length) return formatCode(digits);
  return length === 6 && digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
}
const charAt = (slot: number, length: CodeLength) => (length === 6 && slot >= 3 ? slot + 1 : slot);
const caretAt = (value: string, count: number, length: CodeLength) =>
  length === 6 && count > 3 && value.length > 3 ? count + 1 : count;

function exactCode(value: string, length: CodeLength): string | null {
  return normalizeCode(value, length);
}

/** Read a code from a copied Relay URL, a bare code, or a message that labels its code. */
function codeFromPaste(text: string, length: CodeLength) {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    // "Code: 123-456" parses as an address too; only a web link carries a code in its query.
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Not a link");
    const carried = url.searchParams.get("login") ?? url.searchParams.get("code");
    return carried ? (exactCode(carried.trim(), length) ?? "") : "";
  } catch {
    // Plain text can still contain a labeled code.
  }
  const exact = exactCode(trimmed, length);
  if (exact) return exact;
  const codePattern = length === 6 ? /(\d{3}-?\d{3}|\d{6})/ : /(\d{4})/;
  const labeled = trimmed.match(
    new RegExp(`(?:pickup\\s+)?(?:code|login)\\s*(?:is\\s*)?[:#]?\\s*${codePattern.source}(?![\\d-])`, "i"),
  );
  if (!labeled) return "";
  return exactCode(labeled[1], length) ?? "";
}

/** What a code lookup says about the code itself; asking again gives the same answer. */
class FinalAnswer extends Error {}

async function resolveCode(code: string, length: CodeLength) {
  const normalized = normalizeCode(code, length);
  if (!normalized) throw new FinalAnswer(`Enter a valid ${length}-digit code.`);
  try {
    return await call(api.pickup.resolve, { body: { code: normalized } });
  } catch (error) {
    // A code that was never issued (or mistyped) gets the general answer; one that exists but no
    // longer works says why ("This request is closed."), so nobody retypes a correct code.
    if (error instanceof ApiError && error.status === 404)
      throw new FinalAnswer("That code isn’t valid or has expired.");
    if (error instanceof ApiError && error.status === 410)
      throw new FinalAnswer(error.message || "That code isn’t valid or has expired.");
    throw error;
  }
}

/** The one code entry used on sign-in, the public code page, and the signed-in Enter code button. */
export function CodeEntryForm({
  onOpen,
  autoFocus,
  initialCode = "",
  page = false,
  fieldLabel,
  description,
}: {
  onOpen: (destination: PickupResolution, code: string) => void | Promise<void>;
  autoFocus?: boolean;
  initialCode?: string;
  page?: boolean;
  fieldLabel?: string;
  description?: string;
}) {
  const { codeLength, loading: configLoading, error: configError, refetch } = useCodeConfig();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [retryConfig, setRetryConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const activeAttempt = useRef<{ code: string; revision: number } | null>(null);
  const queuedAttempt = useRef<{ code: string; revision: number } | null>(null);
  const initialSubmitStarted = useRef(false);
  const codeValue = useRef(code);
  const codeRevision = useRef(0);
  const previousLength = useRef<CodeLength | null>(null);
  const [activeSlot, setActiveState] = useState(0);
  const active = useRef(activeSlot);
  const setActiveSlot = (slot: number) => {
    active.current = slot;
    setActiveState(slot);
  };
  const field = useRef<HTMLInputElement>(null);
  // Where the selection was just before the latest edit, so a refused one puts it back exactly.
  const lastSelection = useRef<[number, number]>([0, 0]);
  const pointing = useRef(false);
  // Where the selection goes once the new value is on screen: a box (its character selected, so
  // typing replaces it) or a bare caret position.
  const caret = useRef<{ slot: number } | { at: number } | null>(null);
  const errorId = useId();
  const digits = digitsIn(code);

  const setCurrentCode = (formatted: string) => {
    codeValue.current = formatted;
    setCode(formatted);
  };

  function clearAfterLengthChange(length: CodeLength) {
    queuedAttempt.current = null;
    codeRevision.current++;
    setCurrentCode("");
    setActiveSlot(0);
    setError(`Code length changed to ${length} digits. Enter the code again.`);
    setRetryConfig(false);
  }

  // Changing the server's length invalidates any partially entered or in-flight code.
  useEffect(() => {
    if (codeLength === null) return;
    if (previousLength.current !== null && previousLength.current !== codeLength) clearAfterLengthChange(codeLength);
    previousLength.current = codeLength;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to a change of the server's code length.
  }, [codeLength]);

  async function submitCode(value: string) {
    if (codeLength === null) return;
    const normalized = exactCode(value, codeLength);
    const revision = codeRevision.current;
    // Incomplete input waits for the next character.
    if (!normalized) {
      queuedAttempt.current = null;
      return;
    }
    if (submitting.current) {
      const activeAttemptNow = activeAttempt.current;
      if (activeAttemptNow?.revision !== revision || activeAttemptNow.code !== normalized)
        queuedAttempt.current = { code: normalized, revision };
      return;
    }
    submitting.current = true;
    activeAttempt.current = { code: normalized, revision };
    setBusy(true);
    setError("");
    setRetryConfig(false);
    try {
      // Read the global setting immediately before resolving. A stale six-digit value must never
      // be looked up after the deployment has moved to four digits (or the reverse).
      const latestLength = await refetch();
      if (codeRevision.current !== revision || exactCode(codeValue.current, codeLength) !== normalized) return;
      if (latestLength !== codeLength) {
        clearAfterLengthChange(latestLength);
        return;
      }
      const destination = await resolveCode(normalized, latestLength);
      // Ignore a response that no longer belongs to the value in the field.
      if (codeRevision.current !== revision || exactCode(codeValue.current, latestLength) !== normalized) return;
      await onOpen(destination, normalized);
      if (codeRevision.current === revision && exactCode(codeValue.current, latestLength) === normalized) {
        codeRevision.current++;
        setCurrentCode("");
        setActiveSlot(0);
      }
    } catch (e) {
      if (codeRevision.current === revision && exactCode(codeValue.current, codeLength) === normalized) {
        setError((e as Error).message || "Could not check this code. Try again.");
        // A failure that may pass (offline, busy, a limit) is retried with Enter or this action;
        // an answer about the code itself would only come back the same.
        const status = e instanceof ApiError ? e.status : 0;
        const final = e instanceof FinalAnswer || (status >= 400 && status < 500 && status !== 408 && status !== 429);
        if (previousLength.current !== null && !final) setRetryConfig(true);
      }
    } finally {
      submitting.current = false;
      activeAttempt.current = null;
      const queued = queuedAttempt.current;
      queuedAttempt.current = null;
      if (
        queued &&
        queued.revision === codeRevision.current &&
        queued.code === exactCode(codeValue.current, codeLength)
      ) {
        void submitCode(queued.code);
      } else {
        setBusy(false);
      }
    }
  }

  // A typed letter or symbol never reaches the field, so the caret and chosen box stay put. Other
  // input (autofill, keyboards that can't be refused) is checked after the fact in onChange.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const before = (event: InputEvent) => {
      lastSelection.current = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
      if (event.inputType === "insertText" && event.data?.length === 1 && /\D/.test(event.data) && event.cancelable)
        event.preventDefault();
    };
    el.addEventListener("beforeinput", before);
    return () => el.removeEventListener("beforeinput", before);
  }, [codeLength]);

  // A complete code passed in by a deep link is intentional input. Validate it against the
  // fetched deployment setting once; malformed and wrong-length links never get partly accepted.
  useEffect(() => {
    if (initialSubmitStarted.current || codeLength === null) return;
    initialSubmitStarted.current = true;
    if (!initialCode) return;
    const initial = exactCode(initialCode.trim(), codeLength);
    if (!initial) {
      setError(`That link must contain exactly ${codeLength} digits.`);
      return;
    }
    const formatted = formatForLength(initial, codeLength);
    codeRevision.current++;
    setCurrentCode(formatted);
    setActiveSlot(codeLength - 1);
    void submitCode(formatted);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a code in the link is submitted once the code length is known.
  }, [codeLength]);

  // The code is shown formatted as it is typed or pasted. The caret stays after the same digit it
  // followed, so editing in the middle works for both configured lengths.
  function selectSlot(slot: number) {
    const el = field.current;
    if (!el || codeLength === null) return;
    const value = el.value;
    const count = digitsIn(value).length;
    const target = Math.max(0, Math.min(slot, count, codeLength - 1));
    const char = charAt(target, codeLength);
    if (target < count) el.setSelectionRange(char, char + 1);
    else el.setSelectionRange(caretAt(value, count, codeLength), caretAt(value, count, codeLength));
    setActiveSlot(target);
  }

  useLayoutEffect(() => {
    const next = caret.current;
    if (next === null || document.activeElement !== field.current || codeLength === null) return;
    caret.current = null;
    if ("slot" in next) selectSlot(next.slot);
    else field.current!.setSelectionRange(next.at, next.at);
  });

  /** The box under a pointer, from the boxes' own positions (the input lies over them). */
  function slotAt(x: number) {
    const slots = [...(field.current?.parentElement?.querySelectorAll<HTMLElement>("[data-code-slot]") ?? [])];
    let best = 0;
    slots.forEach((el, index) => {
      if (x >= el.getBoundingClientRect().left) best = index;
    });
    return best;
  }

  if (codeLength === null) {
    return (
      <form className={page ? "stack" : "code-entry-form"} aria-busy={configLoading || undefined}>
        {configLoading ? (
          <span className="field-hint" role="status">
            Loading code settings…
          </span>
        ) : (
          <>
            <p className="field-error" role="alert">
              Could not load the current code settings. {configError}
            </p>
            <button type="button" className="btn btn-secondary" onClick={() => void refetch().catch(() => {})}>
              Retry
            </button>
          </>
        )}
      </form>
    );
  }

  const input = (
    <span className="code-entry-field" data-invalid={error ? "true" : undefined} data-code-length={codeLength}>
      <input
        ref={field}
        className="code-entry-field-native"
        type="text"
        name="relay-code"
        autoComplete="one-time-code"
        data-1p-ignore="true"
        data-lpignore="true"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={codeLength === 6 ? "XXX-XXX" : "XXXX"}
        inputMode="numeric"
        enterKeyHint="go"
        value={code}
        aria-busy={busy || undefined}
        autoFocus={autoFocus}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errorId : undefined}
        // Taps and clicks land on the input itself (so the browser offers Paste there) and then
        // act on the box under the pointer. Touch keeps the native long-press menu.
        onPointerDown={(e) => {
          pointing.current = true;
          if (e.pointerType !== "mouse" || e.button !== 0) return;
          e.preventDefault();
          field.current?.focus({ preventScroll: true });
          selectSlot(slotAt(e.clientX));
        }}
        onPointerUp={(e) => {
          pointing.current = false;
          if (e.pointerType === "mouse" || e.button !== 0) return;
          const slot = slotAt(e.clientX);
          selectSlot(slot);
          setTimeout(() => {
            if (active.current === slot) selectSlot(slot);
          });
        }}
        onMouseUp={(e) => e.button === 0 && selectSlot(slotAt(e.clientX))}
        onPointerCancel={() => (pointing.current = false)}
        onFocus={() => {
          if (!pointing.current) selectSlot(active.current);
        }}
        onKeyDown={(e) => {
          // A selection of several digits collapses to its start or end, as in any text field.
          const el = e.currentTarget;
          const from = digitsIn(el.value.slice(0, el.selectionStart ?? 0)).length;
          const to = digitsIn(el.value.slice(0, el.selectionEnd ?? 0)).length;
          const wide = to - from > 1;
          const move = {
            ArrowLeft: wide ? from : activeSlot - 1,
            ArrowRight: wide ? to : activeSlot + 1,
            Home: 0,
            End: codeLength - 1,
          }[e.key as "ArrowLeft"];
          if (move === undefined || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          selectSlot(move);
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          lastSelection.current = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
          const slot = digitsIn(el.value.slice(0, el.selectionStart ?? 0)).length;
          const next = Math.min(slot, codeLength - 1);
          if (next !== active.current) setActiveSlot(next);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const pasted = codeFromPaste(e.clipboardData.getData("text"), codeLength);
          if (!pasted) {
            setError(`Paste a valid ${codeLength}-digit Relay code.`);
            return;
          }
          const formatted = formatForLength(pasted, codeLength);
          caret.current = { slot: codeLength - 1 };
          codeRevision.current++;
          codeValue.current = formatted;
          setCode(formatted);
          setActiveSlot(codeLength - 1);
          setError("");
          void submitCode(formatted);
        }}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          const at = e.currentTarget.selectionStart ?? raw.length;
          const inputType = (e.nativeEvent as InputEvent).inputType ?? "";
          const deleting = inputType.startsWith("delete");
          // Digits, and for six-digit codes one dash wherever an edit left it: typing before the dash
          // shifts it (123-56 becomes 1237-56 for a moment), and the digits are regrouped below.
          const validShape = /^\d*$/.test(raw) || (codeLength === 6 && /^\d*-\d*$/.test(raw));
          let next = digitsIn(raw);
          let before = digitsIn(raw.slice(0, at)).length;
          // Backspace over the dash alone would change nothing; remove the character before it.
          if (inputType === "deleteContentBackward" && next === digits && raw.length < code.length && before > 0) {
            next = next.slice(0, before - 1) + next.slice(before);
            before--;
          }
          // Reject letters, extra separators, and overlong edits atomically. In particular, never
          // truncate an overlong value into a different valid code.
          const refuse = () => {
            e.currentTarget.value = code;
            const [start, end] = lastSelection.current;
            e.currentTarget.setSelectionRange(Math.min(start, code.length), Math.min(end, code.length));
          };
          if (!validShape || next.length > codeLength) return refuse();
          const formatted = formatForLength(next, codeLength);
          // The same digits: a digit typed over itself stands; only a stray separator is undone.
          if (formatted === code) return raw === code ? undefined : refuse();
          codeRevision.current++;
          codeValue.current = formatted;
          // While digits are missing, typing inserts at a plain caret; once the code is full, the
          // next box is chosen so typing on replaces rather than overflowing.
          caret.current =
            deleting || next.length < codeLength
              ? { at: caretAt(formatted, Math.min(before, codeLength), codeLength) }
              : { slot: Math.min(before, codeLength - 1) };
          setActiveSlot(Math.min(before, codeLength - 1));
          setCode(formatted);
          setError("");
          setRetryConfig(false);
          void submitCode(formatted);
        }}
      />
      <span className="code-entry-field-boxes" aria-hidden="true" data-code-length={codeLength}>
        {Array.from({ length: codeLength }, (_, index) => (
          <Fragment key={index}>
            {codeLength === 6 && index === 3 && <span className="code-entry-field-separator">-</span>}
            <span
              className="code-entry-field-slot"
              data-code-slot={index}
              data-current={activeSlot === index || undefined}
            >
              {digits[index] || ""}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );

  return (
    <form
      className={page ? "stack" : "code-entry-form"}
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (codeLength !== null && !exactCode(codeValue.current, codeLength)) {
          const missing = codeLength - digitsIn(codeValue.current).length;
          setError(missing > 0 ? `Enter all ${codeLength} digits.` : `Enter a valid ${codeLength}-digit code.`);
          return;
        }
        void submitCode(codeValue.current);
      }}
    >
      <label className="field">
        <span className="field-label">{fieldLabel || "Pickup code"}</span>
        {input}
      </label>
      {description && <span className="field-hint">{description}</span>}
      {busy && (
        <span className="field-hint" role="status" aria-live="polite">
          Checking code…
        </span>
      )}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      {retryConfig && (
        <button type="button" className="link" onClick={() => void submitCode(codeValue.current)}>
          Retry
        </button>
      )}
    </form>
  );
}
