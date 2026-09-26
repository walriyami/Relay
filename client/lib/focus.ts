/**
 * Keeps keyboard focus somewhere sensible when the focused control goes away: a trashed card, a
 * row whose link was turned off, the Done button of a finished transfer. Without this the browser
 * drops focus to <body>, the next Tab starts again from the top and screen readers lose their place.
 *
 * Every focused element remembers where it sat (its ancestors and their neighbours). When it is
 * removed while focused, focus goes to the nearest surviving neighbour at the closest level, then
 * to the first control in the closest surviving container, and finally to the page's main area.
 * Inside an open dialog it stays inside that dialog. A control that is disabled while focused
 * (a busy button, a destination already used) gets focus back if it is enabled again soon, or else
 * hands it to a neighbour.
 */
const FOCUSABLE =
  'button:not([disabled]),[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type Level = { parent: Element; prev: Element | null; next: Element | null };
const trails = new WeakMap<Element, Level[]>();
let last: HTMLElement | null = null;
/** The element that received focus most recently, even if it has lost it since (a busy button). */
let recent: HTMLElement | null = null;
export const lastFocused = () => recent;

function trailOf(el: Element): Level[] {
  const levels: Level[] = [];
  for (let at: Element = el; at.parentElement && at.parentElement !== document.body; at = at.parentElement)
    levels.push({ parent: at.parentElement, prev: at.previousElementSibling, next: at.nextElementSibling });
  return levels;
}

const visible = (el: HTMLElement) => el.getClientRects().length > 0 && !el.closest("[hidden],[inert]");

function firstIn(el: Element | null): HTMLElement | null {
  if (!el?.isConnected) return null;
  if (el instanceof HTMLElement && el.matches(FOCUSABLE) && visible(el)) return el;
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible) ?? null;
}

/** Focuses the first visible control inside `el`; false when there is none. */
export function focusFirstIn(el: Element | null) {
  const target = firstIn(el);
  target?.focus({ preventScroll: true });
  return !!target;
}

const lost = () => !document.activeElement || document.activeElement === document.body;
const disabled = (el: Element) => (el as HTMLButtonElement).disabled === true;
const LAYERS = '[role="dialog"],[role="menu"],.popover';

/** Moves focus to what is left around `gone` (removed or disabled), if focus was lost with it. */
export function recoverFocus(gone: Element | null) {
  if (!gone || (gone.isConnected && !disabled(gone)) || !lost()) return;
  const levels = trails.get(gone) ?? [];
  // A dialog or menu that closed returns focus itself. One still open keeps focus inside it.
  const layer = levels.findIndex((l) => l.parent.matches(LAYERS));
  if (layer >= 0 && !levels[layer].parent.isConnected) return;
  for (const { parent, prev, next } of layer >= 0 ? levels.slice(0, layer + 1) : levels) {
    if (!parent.isConnected) continue;
    // Once nothing is left inside the page's main area, focus the area itself rather than the
    // first control around it, which would be a skip link or the navigation.
    if (!parent.closest("main")) {
      const main = parent.querySelector<HTMLElement>("main");
      if (main) return main.focus({ preventScroll: true });
    }
    const target = firstIn(next) || firstIn(prev) || firstIn(parent);
    if (target) return target.focus({ preventScroll: true });
  }
  if (layer >= 0) return (levels[layer].parent as HTMLElement).focus({ preventScroll: true });
  document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
}

/**
 * Returns focus to a dialog's opener. An opener that is busy (disabled) gets it back once it is
 * enabled again; one that is gone hands over to its neighbours.
 */
export function returnFocus(opener: HTMLElement | null) {
  // A dialog that opened by itself (something arrived) has no opener: leave focus on the page.
  if (!opener) {
    setTimeout(() => lost() && document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true }));
    return;
  }
  if (!opener.isConnected) return recoverFocus(opener);
  opener.focus({ preventScroll: true });
  if (document.activeElement === opener) return;
  const started = Date.now();
  const retry = () => {
    if (!lost() || Date.now() - started > 5000) return;
    if (!opener.isConnected) return recoverFocus(opener);
    opener.focus({ preventScroll: true });
    if (document.activeElement !== opener) setTimeout(retry, 50);
  };
  setTimeout(retry, 50);
}

/** Busy for a moment: take focus back when it is enabled again; still disabled: move on. */
function afterDisabled(gone: HTMLElement) {
  const started = Date.now();
  const check = () => {
    if (!lost()) return;
    if (gone.isConnected && !disabled(gone)) return gone.focus({ preventScroll: true });
    if (!gone.isConnected || Date.now() - started > 1000) return recoverFocus(gone);
    setTimeout(check, 50);
  };
  setTimeout(check, 50);
}

export function installFocusRecovery() {
  // Some browsers drop focus from a disabled control only after the change was observed.
  document.addEventListener("focusout", (event) => {
    const el = event.target;
    if (event.relatedTarget || !(el instanceof HTMLElement) || !disabled(el)) return;
    if (last === el) last = null;
    afterDisabled(el);
  });
  document.addEventListener("focusin", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement) || el === document.body) return;
    last = el;
    recent = el;
    trails.set(el, trailOf(el));
  });
  new MutationObserver((records) => {
    if (!last || !lost()) return;
    const gone = last;
    if (!gone.isConnected) {
      last = null;
      // After React's own effects, which may already place focus (a dialog returning it).
      setTimeout(() => recoverFocus(gone));
    } else if (
      disabled(gone) &&
      // Only when it was disabled just now; focus left deliberately (a click on the page) stays put.
      records.some((r) => r.type === "attributes" && r.target instanceof Node && r.target.contains(gone))
    ) {
      last = null;
      afterDisabled(gone);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
}
