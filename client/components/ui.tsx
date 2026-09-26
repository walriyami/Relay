import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, CloudOff, Copy, Loader2, MoreHorizontal, X } from "lucide-react";
import { useConnection } from "../lib/connection";
import { useModalLayer } from "../lib/router";
import { lastFocused, returnFocus } from "../lib/focus";
import { copyText } from "../lib/format";
import { LIMITS } from "../../shared/model";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: ReactNode;
  busy?: boolean;
};
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy,
  children,
  className = "",
  type = "button",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <Loader2 className="spin" size={16} aria-hidden /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}
export function IconButton({
  label,
  icon,
  size = "md",
  variant = "ghost",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
  size?: "md" | "sm";
  variant?: "ghost" | "secondary";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`btn btn-${variant} btn-${size} btn-icon ${className}`}
      {...props}
    >
      {icon}
    </button>
  );
}

const ModalContext = createContext<() => void>(() => {});
export const useCloseModal = () => useContext(ModalContext);

const focusable =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** What Tab can stop on inside a dialog: its controls, and media players with their own controls. */
const tabStops = `${focusable},audio[controls],video[controls]`;

/** The opener of the dialog that closed last, for a dialog that opens straight after it. */
let handoff: { opener: HTMLElement | null; at: number } = { opener: null, at: 0 };
/** When a press outside last closed a menu or popover; that press does nothing else. */
let popupDismissedAt = -Infinity;
/** Open modals, innermost last; the page behind stops scrolling while any is open. */
const modalStack: HTMLElement[] = [];
/** What `shieldPage` made inert, so it can undo exactly that. */
const shielded = new Set<Element>();
/**
 * Makes everything behind the innermost modal inert, so no engine's Tab order (Safari skips
 * buttons by default and walks straight out) and no screen reader can reach it. Menus and
 * popovers opened from the modal come after it in the page and stay usable, as do toasts.
 */
function shieldPage() {
  for (const el of shielded) el.removeAttribute("inert");
  shielded.clear();
  const top = modalStack.at(-1);
  if (!top) return;
  for (const el of document.body.children) {
    if (el === top || el.classList.contains("toaster") || el.hasAttribute("inert")) continue;
    if (el.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING) {
      el.setAttribute("inert", "");
      shielded.add(el);
    }
  }
}

export function Modal({
  title,
  subtitle,
  onClose,
  size = "md",
  children,
  footer,
  actions,
  className = "",
  url,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** The address shown while this modal is open, so reloading or sharing it reopens it. */
  url?: string;
  size?: "sm" | "md" | "lg" | "xl";
  children: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const requestClose = useModalLayer(onClose, url);
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Captured while rendering, before any child effect can move focus into the dialog, so closing
  // returns focus to whatever opened it.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    // A dialog that replaces another in the same update was opened from inside it; by now the
    // closed one has returned focus to its own opener, which becomes this one's too.
    // One opened as another closes (a busy submit button blurs first) inherits that one's opener.
    const active = document.activeElement as HTMLElement | null;
    const usable = (el: HTMLElement | null) => !!el && el.isConnected && el !== document.body;
    // A control that went busy while this opened (Share creating its link) lost focus already;
    // it is still the opener, and gets focus back once it is enabled again.
    const recent = lastFocused();
    const previous = usable(opener)
      ? opener
      : usable(active)
        ? active
        : recent && usable(recent) && !panel.current?.contains(recent)
          ? recent
          : Date.now() - handoff.at < 3000
            ? handoff.opener
            : null;
    const node = panel.current;
    const first =
      node?.querySelector<HTMLElement>("[data-autofocus]") ||
      [
        ...(node?.querySelectorAll<HTMLElement>(".modal-body " + focusable.split(",").join(",.modal-body ")) ?? []),
      ].find((el) => el.tabIndex >= 0) ||
      node;
    const layer = backdrop.current;
    if (layer) modalStack.push(layer);
    shieldPage();
    first?.focus({ preventScroll: true });
    document.body.classList.add("modal-open");
    return () => {
      if (layer) modalStack.splice(modalStack.lastIndexOf(layer), 1);
      shieldPage();
      if (!modalStack.length) document.body.classList.remove("modal-open");
      handoff = { opener: previous, at: Date.now() };
      returnFocus(previous);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dialog takes and returns focus once, when it opens and closes.
  }, []);
  // Tab walks the dialog's own stops and wraps around. Only from a media player does the browser
  // move focus itself, so its built-in controls are reached; if that lands anywhere but the player
  // or the next stop (Safari skips buttons), focus goes to the next stop instead.
  const correction = useRef<ReturnType<typeof setTimeout>>(undefined);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || !panel.current) return;
    // A quick second Tab outruns the check after the first; it no longer applies.
    clearTimeout(correction.current);
    const node = panel.current;
    const active = document.activeElement as HTMLElement | null;
    const items = [...node.querySelectorAll<HTMLElement>(tabStops)].filter((el) => {
      if (!el.getClientRects().length || el.closest("[inert]") || el.tabIndex < 0) return false;
      // A radio group is one stop: its checked option (or its first), or the one already focused.
      if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
      const group = [...node.querySelectorAll<HTMLInputElement>(`input[type="radio"]`)].filter(
        (r) => r.name === el.name,
      );
      const stop = group.find((r) => r === active) ?? group.find((r) => r.checked) ?? group[0];
      return el === stop;
    });
    if (!items.length) return;
    const step = event.shiftKey ? -1 : 1;
    const at = items.findIndex((el) => el === active || el.contains(active));
    const next = items[at < 0 ? (event.shiftKey ? items.length - 1 : 0) : (at + step + items.length) % items.length];
    const media = at >= 0 ? items[at] : null;
    if (!media?.matches("audio,video")) {
      event.preventDefault();
      next.focus();
      return;
    }
    correction.current = setTimeout(() => {
      const now = document.activeElement;
      if (now === media || now === next) return;
      next.focus();
    });
  }
  return createPortal(
    <ModalContext.Provider value={requestClose}>
      <div
        ref={backdrop}
        className="modal-backdrop"
        onMouseDown={(event) => {
          // A press that only dismissed an open menu or popover leaves the dialog open.
          if (performance.now() - popupDismissedAt < 500) return;
          if (event.target === event.currentTarget) requestClose();
        }}
      >
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`modal modal-${size} ${className}`}
          onKeyDown={onKeyDown}
        >
          <div className="modal-head">
            <div className="modal-title">
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p className="muted">{subtitle}</p>}
            </div>
            <div className="modal-head-actions">
              {actions}
              <IconButton label="Close" icon={<X size={18} />} onClick={requestClose} />
            </div>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-foot">{footer}</footer>}
        </div>
      </div>
    </ModalContext.Provider>,
    document.body,
  );
}

// A panel anchored directly below its trigger, aligned to the trigger's right edge.
export function Popover({
  anchor,
  onClose,
  children,
  className = "",
  align = "end",
  label,
  flip = false,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  label: string;
  /** Open upwards when there isn't room below (menus near the bottom of the screen). */
  flip?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: -9999 });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = panel.current?.offsetWidth || 320;
      const height = panel.current?.offsetHeight || 0;
      let top = rect.bottom + 8;
      if (flip && top + height > window.innerHeight - 8 && rect.top - 8 - height >= 8) top = rect.top - 8 - height;
      if (align === "end") {
        const right = Math.max(8, window.innerWidth - rect.right);
        setPos({ top, right: Math.min(right, window.innerWidth - width - 8) });
      } else setPos({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, align, flip]);
  useEffect(() => {
    // Portals append in opening order, so a modal whose backdrop follows this panel was opened on
    // top of it (a dialog one of its items started) and owns the pointer and Escape. A modal below
    // it, such as the window its trigger sits in, is just "outside".
    const above = (backdrop: Element | null | undefined) =>
      !!backdrop &&
      !!panel.current &&
      !!(panel.current.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING);
    const down = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      if (above(target.closest?.(".modal-backdrop"))) return;
      popupDismissedAt = performance.now();
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const backdrops = document.querySelectorAll(".modal-backdrop");
      if (above(backdrops[backdrops.length - 1])) return;
      event.preventDefault();
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose, anchor]);
  useEffect(() => {
    // Opening moves focus in (unless a field inside took it already), so the panel is the next
    // thing the keyboard reaches in every engine, not something 27 Tabs down the page.
    const node = panel.current;
    if (!node || node.contains(document.activeElement)) return;
    const first = [...node.querySelectorAll<HTMLElement>(focusable)].find(
      (el) => el.getClientRects().length && el.tabIndex >= 0,
    );
    (first ?? node).focus({ preventScroll: true });
  }, []);
  // Tab walks the panel's own controls; past either end the panel closes and focus is back on its
  // button, so it is never left open behind the keyboard.
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || !panel.current) return;
    // A menu hands Tab on from its trigger itself.
    if ((event.target as Element).closest('[role="menu"]')) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter(
      (el) => el.getClientRects().length > 0 && el.tabIndex >= 0,
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (event.shiftKey ? -1 : 0) : at + (event.shiftKey ? -1 : 1);
    event.preventDefault();
    if (next >= 0 && next < items.length) items[next].focus();
    else {
      onClose();
      anchor.current?.focus();
    }
  }
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`popover ${className}`}
      style={{ top: pos.top, left: pos.left, right: pos.right }}
    >
      {children}
    </div>,
    document.body,
  );
}

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider before this item (e.g. before destructive actions). */
  separator?: boolean;
};
/**
 * Keyboard handling for a menu list: arrows move between enabled items (radios included), and
 * Tab closes the menu and continues from its trigger rather than from the end of the page.
 */
export function menuKeys(
  list: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
  close: () => void,
) {
  return (event: React.KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>("button:not([disabled])") || [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === "Tab") {
      trigger.current?.focus();
      close();
    }
  };
}

export function Menu({
  label,
  items,
  trigger,
  size = "sm",
  variant = "ghost",
  align = "end",
}: {
  label: string;
  items: MenuItem[];
  trigger?: ReactNode;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
  /** Which edge of the trigger the menu lines up with: "start" for a trigger at the start of a row. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);
  const onKeyDown = menuKeys(list, button, () => setOpen(false));
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn btn-${variant} btn-${size} ${trigger ? "" : "btn-icon"}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {trigger || <MoreHorizontal size={18} />}
      </button>
      {open && (
        <Popover
          anchor={button}
          onClose={() => setOpen(false)}
          label={label}
          className="menu-popover"
          align={align}
          flip
        >
          <div role="menu" ref={list} onKeyDown={onKeyDown} className="menu">
            {items.map((item) => [
              item.separator && <div key={item.label + ":sep"} role="separator" className="menu-sep" />,
              <button
                key={item.label}
                role="menuitem"
                type="button"
                disabled={item.disabled}
                className={`menu-item ${item.danger ? "danger" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // Focus the trigger first so a dialog the item opens returns focus there.
                  button.current?.focus();
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>,
            ])}
          </div>
        </Popover>
      )}
    </>
  );
}

// Toasts
type ToastItem = {
  id: number;
  message: ReactNode;
  detail?: ReactNode;
  tone?: "info" | "success" | "error";
  action?: { label: string; onClick: () => void };
  timeout?: number;
  /** A toast with the same key replaces the earlier one and can be dismissed by key. */
  key?: string;
};
let toastSerial = 0;
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
/** Auto-dismiss clocks. They stop while the pointer or focus is on the toasts (WCAG 2.2.1). */
const toastClocks = new Map<number, { left: number; since: number; timer?: ReturnType<typeof setTimeout> }>();
let toastsHeld = false;
function setToasts(next: ToastItem[]) {
  toasts = next;
  toastListeners.forEach((fn) => fn());
}
function runClock(id: number) {
  const clock = toastClocks.get(id);
  if (!clock || toastsHeld) return;
  clock.since = Date.now();
  clock.timer = setTimeout(() => dismissToast(id), clock.left);
}
function holdToasts(held: boolean) {
  if (held === toastsHeld) return;
  toastsHeld = held;
  for (const [id, clock] of toastClocks) {
    if (held) {
      clearTimeout(clock.timer);
      clock.left = Math.max(1000, clock.left - (Date.now() - clock.since));
    } else runClock(id);
  }
}
export function toast(message: ReactNode, options: Omit<ToastItem, "id" | "message"> = {}) {
  const id = ++toastSerial;
  const rest = options.key ? toasts.filter((t) => t.key !== options.key) : toasts;
  for (const dropped of toasts) if (!rest.slice(-3).includes(dropped)) forgetClock(dropped.id);
  setToasts([...rest.slice(-3), { id, message, ...options }]);
  // Errors and anything with an action (such as Undo) stay long enough to read and act on.
  const timeout = options.timeout ?? (options.tone === "error" || options.action ? 8000 : 4000);
  if (timeout > 0) {
    toastClocks.set(id, { left: timeout, since: Date.now() });
    runClock(id);
  }
  return id;
}
function forgetClock(id: number) {
  clearTimeout(toastClocks.get(id)?.timer);
  toastClocks.delete(id);
}
export function dismissToast(id: number) {
  forgetClock(id);
  setToasts(toasts.filter((t) => t.id !== id));
}
/** Dismisses toasts whose key is `key`, or starts with it when it ends in ":" (e.g. "undo:"). */
export function dismissToastKey(key: string) {
  const matches = (t: ToastItem) => !!t.key && (key.endsWith(":") ? t.key.startsWith(key) : t.key === key);
  const gone = toasts.filter(matches);
  if (!gone.length) return;
  gone.forEach((t) => forgetClock(t.id));
  setToasts(toasts.filter((t) => !matches(t)));
}
export function Toaster() {
  const items = useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn);
      return () => toastListeners.delete(fn);
    },
    () => toasts,
  );
  return createPortal(
    <div
      className="toaster"
      aria-live="polite"
      onPointerEnter={() => holdToasts(true)}
      onPointerLeave={() => holdToasts(false)}
      onFocus={() => holdToasts(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) holdToasts(false);
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={`toast toast-${item.tone || "info"}`}
          role={item.tone === "error" ? "alert" : "status"}
        >
          <div className="toast-text">
            <strong>{item.message}</strong>
            {item.detail && <span className="muted">{item.detail}</span>}
          </div>
          {item.action && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                dismissToast(item.id);
                item.action!.onClick();
              }}
            >
              {item.action.label}
            </Button>
          )}
          <IconButton size="sm" label="Dismiss" icon={<X size={16} />} onClick={() => dismissToast(item.id)} />
        </div>
      ))}
    </div>,
    document.body,
  );
}

// Confirmation dialog that returns a promise.
type ConfirmRequest = {
  title: string;
  body?: ReactNode;
  confirm: string;
  /** The dismiss button's label, when "Cancel" would be ambiguous (e.g. "Keep uploading"). */
  cancel?: string;
  danger?: boolean;
  input?: {
    label: string;
    value: string;
    hint?: string;
    optional?: boolean;
    /** Runs on submit; a rejection is shown on the field and the dialog stays open for another try. */
    apply?: (value: string) => Promise<unknown>;
  };
  resolve: (value: string | boolean) => void;
  id?: number;
};
let confirmSerial = 0;
/** Requests wait their turn, so a second confirmation never strands the first one's promise. */
let confirmQueue: ConfirmRequest[] = [];
const confirmListeners = new Set<() => void>();
function enqueueConfirm(request: ConfirmRequest) {
  confirmQueue = [...confirmQueue, { ...request, id: ++confirmSerial }];
  confirmListeners.forEach((fn) => fn());
}
export function confirmDialog(options: Omit<ConfirmRequest, "resolve">) {
  return new Promise<boolean>((resolve) => enqueueConfirm({ ...options, resolve: (v) => resolve(!!v) }));
}
/**
 * Resolves to the trimmed value, or null when cancelled. `optional` lets an empty value through;
 * `apply` saves it before the dialog closes, so a refused value can be corrected in place.
 */
export function promptDialog({
  label,
  value,
  hint,
  optional,
  apply,
  ...options
}: Omit<ConfirmRequest, "resolve" | "input"> & NonNullable<ConfirmRequest["input"]>) {
  return new Promise<string | null>((resolve) =>
    enqueueConfirm({
      ...options,
      input: { label, value, hint, optional, apply },
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    }),
  );
}
export function ConfirmHost() {
  const request = useSyncExternalStore(
    (fn) => {
      confirmListeners.add(fn);
      return () => confirmListeners.delete(fn);
    },
    () => confirmQueue[0] ?? null,
  );
  if (!request) return null;
  const done = (ok: boolean) => {
    if (confirmQueue[0] !== request) return;
    confirmQueue = confirmQueue.slice(1);
    confirmListeners.forEach((fn) => fn());
    request.resolve(ok);
  };
  return (
    // Keyed so the next queued request mounts a fresh dialog.
    <Modal key={request.id} title={request.title} size="sm" onClose={() => done(false)}>
      <ConfirmBody request={request} />
    </Modal>
  );
}
function ConfirmBody({ request }: { request: ConfirmRequest }) {
  const close = useCloseModal();
  const [value, setValue] = useState(request.input?.value || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const field = useRef<HTMLInputElement>(null);
  const submit = async () => {
    const input = request.input;
    if (busy || (input && !input.optional && !value.trim())) return;
    if (input?.apply) {
      setBusy(true);
      setError("");
      try {
        await input.apply(value.trim());
      } catch (e) {
        setBusy(false);
        setError((e as Error).message || "That didn’t work. Try again.");
        field.current?.focus();
        return;
      }
    }
    // Resolve first; the history-driven close then reports nothing further.
    const resolve = request.resolve;
    request.resolve = () => {};
    resolve(input ? value.trim() : true);
    close();
  };
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {request.body && <div className="muted">{request.body}</div>}
      {request.input && (
        <Field label={request.input.label} hint={request.input.hint}>
          <input
            ref={field}
            className="input"
            data-autofocus
            value={value}
            maxLength={LIMITS.nameLength}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
            onFocus={(event) => {
              const dot = event.target.value.lastIndexOf(".");
              event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
            }}
          />
        </Field>
      )}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        {/* Something that can't be undone starts on Cancel, so a reflexive Enter loses nothing. */}
        <Button data-autofocus={!request.input && request.danger ? true : undefined} onClick={close}>
          {request.cancel ?? "Cancel"}
        </Button>
        <Button
          data-autofocus={request.input || request.danger ? undefined : true}
          type="submit"
          busy={busy}
          variant={request.danger ? "danger" : "primary"}
        >
          {request.confirm}
        </Button>
      </div>
    </form>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  /** `short` replaces the label on narrow screens so every option fits on one line. */
  options: { value: T; label: string; short?: string }[];
  onChange: (value: T) => void;
}) {
  // One Tab stop for the group, on the chosen option; arrow keys choose another, as radios do.
  const found = options.findIndex((o) => o.value === value);
  const chosen = Math.max(0, found);
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: chosen - 1,
      ArrowUp: chosen - 1,
      ArrowRight: chosen + 1,
      ArrowDown: chosen + 1,
      Home: 0,
      End: options.length - 1,
    };
    if (!(event.key in moves) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    // With nothing chosen yet, forward arrows start at the first option and back arrows at the last.
    const back = ["ArrowLeft", "ArrowUp", "End"].includes(event.key);
    const next = found < 0 ? (back ? options.length - 1 : 0) : (moves[event.key] + options.length) % options.length;
    onChange(options[next].value);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option, index) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.short ? option.label : undefined}
          tabIndex={index === chosen ? 0 : -1}
          className={option.value === value ? "on" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.short ? (
            <>
              <span className="seg-long">{option.label}</span>
              <span className="seg-short">{option.short}</span>
            </>
          ) : (
            option.label
          )}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  after,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  /** Shown under the control but outside its label, e.g. a hint that carries its own id. */
  after?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // The hint sits outside the label so it describes the control instead of joining its name.
  const hintId = useId();
  const control =
    hint && isValidElement<{ "aria-describedby"?: string }>(children)
      ? cloneElement(children, {
          "aria-describedby": [children.props["aria-describedby"], hintId].filter(Boolean).join(" "),
        })
      : children;
  return (
    <div className={`field ${className}`}>
      <label className="field-body">
        <span className="field-label">{label}</span>
        {control}
      </label>
      {hint && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {after}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2 className="empty-title">{title}</h2>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

/** A quiet placeholder for an empty section inside a page, dialog or settings card. */
export function InlineEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="inline-empty">
      <span className="inline-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="inline-empty-copy">
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      {action && <div className="inline-empty-action">{action}</div>}
    </div>
  );
}

/**
 * A list that couldn't be loaded. With nothing loaded yet it takes the list's place, so a failure
 * never reads as "nothing here"; over a list already shown it's a banner and the list stays.
 */
export function LoadFailed({
  title,
  error,
  onRetry,
  banner = false,
}: {
  /** Shown only in place of the list. */
  title?: string;
  error: string;
  onRetry: () => void;
  banner?: boolean;
}) {
  // While Relay can't be reached, the bar under the header says so and retries for everything;
  // each view waits quietly and reloads by itself when it's back.
  const { state } = useConnection();
  if (state !== "ok") {
    if (banner) return null;
    return (
      <div className="load-waiting">
        <EmptyState
          icon={<CloudOff size={28} />}
          title={
            state === "checking"
              ? "Checking the connection…"
              : state === "down"
                ? "Waiting for Relay"
                : "Waiting for your connection"
          }
        >
          {state === "checking" ? undefined : "This loads by itself as soon as it can."}
        </EmptyState>
      </div>
    );
  }
  const retry = (
    <Button size={banner ? "sm" : "md"} onClick={onRetry}>
      Retry
    </Button>
  );
  return banner ? (
    <div className="notice between" role="alert">
      <span>{error}</span>
      {retry}
    </div>
  ) : (
    <div role="alert">
      <EmptyState icon={<CloudOff size={28} />} title={title ?? "Couldn’t load this"} action={retry}>
        {error}
      </EmptyState>
    </div>
  );
}

export function ProgressBar({
  value,
  max,
  label,
  minVisible,
}: {
  value: number;
  max: number;
  label: string;
  minVisible?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  // A meter with some usage never looks empty.
  const shown = minVisible && value > 0 ? Math.max(pct, 1.5) : pct;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div style={{ width: `${shown}%` }} />
    </div>
  );
}

/** "Copy link" → "Link copied": what was copied, not the button's own verb again. */
export function copiedMessage(label: string) {
  const what = label.replace(/^copy\b\s*/i, "");
  return what ? `${what[0].toUpperCase()}${what.slice(1)} copied` : "Copied";
}

export function CopyButton({
  value,
  label = "Copy",
  variant = "secondary",
  size = "md",
  autofocus,
  className,
  failureMessage,
  iconOnly = false,
}: {
  value: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  /** Takes the dialog's first focus (Modal looks for data-autofocus). */
  autofocus?: boolean;
  className?: string;
  failureMessage?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={`${iconOnly ? "btn-icon" : ""} ${className ?? ""}`.trim()}
        data-autofocus={autofocus || undefined}
        aria-label={iconOnly ? label : copied ? "Copied" : label}
        icon={copied ? <Check size={16} /> : <Copy size={16} />}
        onClick={async () => {
          if (await copyText(value)) setCopied(true);
          else toast(failureMessage || "Copy failed. Select the text and copy it manually.", { tone: "error" });
        }}
      >
        {!iconOnly && (copied ? "Copied" : label)}
      </Button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? copiedMessage(label) : ""}
      </span>
    </>
  );
}

export function QrCode({
  value,
  size = 176,
  label = "QR code for this link",
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const [state, setState] = useState<{ url?: string; failed?: boolean }>({});
  const style = { "--qr-size": `${size}px` } as CSSProperties;
  useEffect(() => {
    let live = true;
    setState({});
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(value, { width: size * 2, margin: 1 }))
      .then((url) => live && setState({ url }))
      .catch(() => live && setState({ failed: true }));
    return () => {
      live = false;
    };
  }, [value, size]);
  if (state.url) return <img className="qr" style={style} src={state.url} width={size} height={size} alt={label} />;
  if (state.failed)
    return (
      <p className="qr qr-failed muted" style={style}>
        The QR code couldn’t be drawn. Copy the link instead.
      </p>
    );
  return <div className="qr skeleton" style={style} aria-hidden />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <Loader2 className="spin" size={18} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span>
        <span className="toggle-label">{label}</span>
        {description && <span className="field-hint">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function useInView<T extends HTMLElement>(ref: RefObject<T | null>, margin = "200px") {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    if (!("IntersectionObserver" in window)) {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, seen, margin]);
  return seen;
}
