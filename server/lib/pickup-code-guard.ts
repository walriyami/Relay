import type { Context } from "../context.ts";
import type { PickupProtection } from "../../shared/codes.ts";
import { fail } from "./errors.ts";
import { addressKey as normalizeAddress } from "../modules/auth/limits.ts";

const WINDOW_MS = 60_000;
const MAX_PER_ADDRESS = 5;
const MAX_GLOBAL = 10;
const ADDRESS_BASE_PAUSE_MS = 60_000;
const GLOBAL_BASE_PAUSE_MS = 2 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;
const QUIET_MS = 15 * 60_000;
const STRIKE_RESET_MS = 24 * 60 * 60_000;
const TOUCH_PERSIST_MS = 30_000;
const MAX_ADDRESSES = 1024;
const SETTING = "pickupCodeProtection";

type SavedAddress = {
  key: string;
  windowStartedAt: number;
  failures: number;
  pausedUntil: number | null;
  strikes: number;
  lastAttackAt: number;
};

type SavedState = {
  version: 1;
  pausedUntil: number | null;
  globalStrikes: number;
  lastGlobalAttackAt: number | null;
  globalWindowStartedAt: number | null;
  lastAttackAt: number | null;
  lastFailureAt: number | null;
  heightenedUntil: number | null;
  addresses: SavedAddress[];
};

type AddressState = SavedAddress;

type Runtime = SavedState & {
  globalFailures: number;
  persistedAt: number;
  addresses: AddressState[];
};

const states = new WeakMap<Context, Runtime>();

const freshState = (): Runtime => ({
  version: 1,
  pausedUntil: null,
  globalStrikes: 0,
  lastGlobalAttackAt: null,
  globalWindowStartedAt: null,
  globalFailures: 0,
  lastAttackAt: null,
  lastFailureAt: null,
  heightenedUntil: null,
  addresses: [],
  persistedAt: 0,
});

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hydrate(ctx: Context, now: number): Runtime {
  const state = freshState();
  try {
    const raw = ctx.db.setting(SETTING);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<SavedState>;
      if (saved.version === 1) {
        state.pausedUntil = isTime(saved.pausedUntil) ? saved.pausedUntil : null;
        state.globalStrikes = Number.isSafeInteger(saved.globalStrikes) ? Math.max(0, saved.globalStrikes!) : 0;
        state.lastGlobalAttackAt = isTime(saved.lastGlobalAttackAt) ? saved.lastGlobalAttackAt : null;
        state.globalWindowStartedAt = isTime(saved.globalWindowStartedAt) ? saved.globalWindowStartedAt : null;
        state.lastAttackAt = isTime(saved.lastAttackAt) ? saved.lastAttackAt : null;
        state.lastFailureAt = isTime(saved.lastFailureAt) ? saved.lastFailureAt : null;
        state.heightenedUntil = isTime(saved.heightenedUntil) ? saved.heightenedUntil : null;
        state.addresses = (Array.isArray(saved.addresses) ? saved.addresses : [])
          .filter(
            (entry): entry is SavedAddress =>
              !!entry &&
              typeof entry.key === "string" &&
              isTime(entry.windowStartedAt) &&
              Number.isSafeInteger(entry.failures) &&
              (entry.pausedUntil === null || isTime(entry.pausedUntil)) &&
              Number.isSafeInteger(entry.strikes) &&
              isTime(entry.lastAttackAt),
          )
          .slice(-MAX_ADDRESSES);

        if (state.lastFailureAt !== null && now - state.lastFailureAt > STRIKE_RESET_MS) {
          state.globalStrikes = 0;
          state.lastGlobalAttackAt = null;
          state.heightenedUntil = null;
        }
        if (
          state.globalWindowStartedAt !== null &&
          now >= state.globalWindowStartedAt &&
          now - state.globalWindowStartedAt < WINDOW_MS &&
          (state.pausedUntil ?? 0) <= now
        ) {
          // A restart cannot grant a fresh guessing window. Since individual failures are not
          // written to SQLite, a recent durable marker conservatively leaves one attempt.
          state.globalFailures = MAX_GLOBAL - 1;
        } else {
          state.globalWindowStartedAt = null;
        }
        for (const address of state.addresses) {
          if (now - address.lastAttackAt > STRIKE_RESET_MS) {
            address.strikes = 0;
            address.pausedUntil = null;
            address.failures = 0;
          } else if (
            address.pausedUntil !== null &&
            address.pausedUntil <= now &&
            now >= address.windowStartedAt &&
            now - address.windowStartedAt < WINDOW_MS
          ) {
            // As above, a recent per-address marker survives restart conservatively.
            address.failures = MAX_PER_ADDRESS - 1;
          }
        }
      }
    }
  } catch {
    // Corrupt guard state must not make numeric credentials more permissive. Fail closed for one
    // maximum backoff and replace the unreadable state on the next recorded attempt.
    state.pausedUntil = now + MAX_PAUSE_MS;
    state.heightenedUntil = state.pausedUntil;
    state.lastAttackAt = now;
  }
  state.persistedAt = now;
  return state;
}

function stateOf(ctx: Context, now: number): Runtime {
  let state = states.get(ctx);
  if (!state) {
    state = hydrate(ctx, now);
    states.set(ctx, state);
  }
  if (state.lastFailureAt !== null && now - state.lastFailureAt > STRIKE_RESET_MS) {
    state.globalStrikes = 0;
    state.lastGlobalAttackAt = null;
    state.heightenedUntil = null;
  }
  state.addresses = state.addresses.filter((entry) => now - entry.lastAttackAt <= STRIKE_RESET_MS);
  return state;
}

function persist(ctx: Context, state: Runtime, now: number) {
  const saved: SavedState = {
    version: 1,
    pausedUntil: state.pausedUntil,
    globalStrikes: state.globalStrikes,
    lastGlobalAttackAt: state.lastGlobalAttackAt,
    globalWindowStartedAt: state.globalWindowStartedAt,
    lastAttackAt: state.lastAttackAt,
    lastFailureAt: state.lastFailureAt,
    heightenedUntil: state.heightenedUntil,
    addresses: state.addresses.slice(-MAX_ADDRESSES),
  };
  ctx.db.setSetting(SETTING, JSON.stringify(saved));
  state.persistedAt = now;
}

function addressOf(ctx: Context, address: string) {
  return ctx.secrets.pickupAddressKey(normalizeAddress(address));
}

function addressState(ctx: Context, state: Runtime, address: string, now: number): AddressState {
  const key = addressOf(ctx, address);
  const index = state.addresses.findIndex((item) => item.key === key);
  if (index >= 0) {
    const [entry] = state.addresses.splice(index, 1);
    state.addresses.push(entry);
    return entry;
  }
  const entry: AddressState = {
    key,
    windowStartedAt: now,
    failures: 0,
    pausedUntil: null,
    strikes: 0,
    lastAttackAt: now,
  };
  state.addresses.push(entry);
  if (state.addresses.length > MAX_ADDRESSES) state.addresses.shift();
  return entry;
}

function backoff(baseMs: number, strikes: number) {
  return Math.min(MAX_PAUSE_MS, baseMs * 2 ** Math.min(Math.max(0, strikes - 1), 10));
}

function noteAttempt(ctx: Context, state: Runtime, now: number, address?: AddressState) {
  state.lastFailureAt = now;
  if (address) address.lastAttackAt = now;
  const activeProtection =
    (state.pausedUntil ?? 0) > now || (state.heightenedUntil ?? 0) > now || (address?.pausedUntil ?? 0) > now;
  if (activeProtection) {
    state.lastAttackAt = now;
    state.heightenedUntil = Math.max(state.pausedUntil ?? 0, now + QUIET_MS);
  }
  if (now - state.persistedAt >= TOUCH_PERSIST_MS) persist(ctx, state, now);
}

function rejectPaused(): never {
  return fail(429, "Too many incorrect codes. Code entry is temporarily paused.");
}

/** Refuses attempts during either lockout. Blocked probes extend the quiet period, with bounded writes. */
export function checkPickupCodeAttempt(ctx: Context, address: string, now = Date.now()) {
  const state = stateOf(ctx, now);
  const entry = state.addresses.find((item) => item.key === addressOf(ctx, address));
  if ((state.pausedUntil ?? 0) > now || (entry?.pausedUntil ?? 0) > now) {
    noteAttempt(ctx, state, now, entry);
    rejectPaused();
  }
}

/** Records an invalid code from either public numeric-code endpoint. */
export function recordPickupCodeFailure(ctx: Context, address: string, now = Date.now()) {
  const state = stateOf(ctx, now);
  const entry = addressState(ctx, state, address, now);
  const previousAddressAttack = entry.lastAttackAt;
  noteAttempt(ctx, state, now);

  const startNewGlobalWindow =
    state.globalWindowStartedAt === null ||
    now < state.globalWindowStartedAt ||
    now - state.globalWindowStartedAt >= WINDOW_MS;
  if (startNewGlobalWindow) {
    state.globalWindowStartedAt = now;
    state.globalFailures = 0;
  }
  const startNewAddressWindow = now < entry.windowStartedAt || now - entry.windowStartedAt >= WINDOW_MS;
  if (startNewAddressWindow) {
    entry.windowStartedAt = now;
    entry.failures = 0;
  }

  state.globalFailures++;
  entry.failures++;
  entry.lastAttackAt = now;

  // Persist one durable marker at the start of each global window. Individual failures stay in
  // memory; restart hydration conservatively restores the window to one attempt from its limit.
  let shouldPersist = startNewGlobalWindow;
  let addressTriggered = false;
  let globalTriggered = false;
  if (entry.failures >= MAX_PER_ADDRESS) {
    entry.strikes =
      previousAddressAttack === 0 || now - previousAddressAttack > STRIKE_RESET_MS ? 1 : Math.max(1, entry.strikes + 1);
    entry.pausedUntil = now + backoff(ADDRESS_BASE_PAUSE_MS, entry.strikes);
    entry.failures = 0;
    entry.windowStartedAt = now;
    state.lastAttackAt = now;
    state.heightenedUntil = Math.max(state.pausedUntil ?? 0, now + QUIET_MS);
    addressTriggered = true;
    shouldPersist = true;
  }

  if (state.globalFailures >= MAX_GLOBAL) {
    state.globalStrikes =
      state.lastGlobalAttackAt === null || now - state.lastGlobalAttackAt > STRIKE_RESET_MS
        ? 1
        : state.globalStrikes + 1;
    state.lastGlobalAttackAt = now;
    state.lastAttackAt = now;
    state.pausedUntil = now + backoff(GLOBAL_BASE_PAUSE_MS, state.globalStrikes);
    state.heightenedUntil = Math.max(state.pausedUntil, now + QUIET_MS);
    globalTriggered = true;
    shouldPersist = true;
  }

  if (shouldPersist) persist(ctx, state, now);
  // A lockout changes what code entry shows everywhere: the pause, or heightened protection.
  if (addressTriggered || globalTriggered) ctx.events.broadcast("codes");
  return { addressTriggered, globalTriggered };
}

/** The requester sees its own address lockout; administrators receive the deployment-wide view. */
export function pickupProtectionOf(ctx: Context, address?: string, now = Date.now()): PickupProtection {
  const state = stateOf(ctx, now);
  const preferred = ctx.db.setting("pickupCodeLength");
  const preferredCodeLength = preferred === "4" ? 4 : 6;
  const entry = address ? state.addresses.find((item) => item.key === addressOf(ctx, address)) : undefined;
  return {
    preferredCodeLength,
    pausedUntil: state.pausedUntil !== null && state.pausedUntil > now ? state.pausedUntil : null,
    addressPausedUntil:
      entry?.pausedUntil !== null && entry?.pausedUntil !== undefined && entry.pausedUntil > now
        ? entry.pausedUntil
        : null,
    heightenedUntil: state.heightenedUntil !== null && state.heightenedUntil > now ? state.heightenedUntil : null,
    lastAttackAt: state.lastAttackAt,
    numericCodeResolutionUnavailable: ctx.db.setting("pickupCodeResolutionUnavailable") === "1",
  };
}

export function adminPickupProtectionOf(
  ctx: Context,
  effectiveCodeLength: 4 | 6,
  now = Date.now(),
): Omit<PickupProtection, "addressPausedUntil"> & { effectiveCodeLength: 4 | 6 } {
  const { addressPausedUntil: _addressPausedUntil, ...protection } = pickupProtectionOf(ctx, undefined, now);
  return { ...protection, effectiveCodeLength };
}

/** Used by code-length reconciliation to decide whether the temporary stronger namespace remains active. */
export function pickupCodeHeightened(ctx: Context, now = Date.now()) {
  return pickupProtectionOf(ctx, undefined, now).heightenedUntil !== null;
}
