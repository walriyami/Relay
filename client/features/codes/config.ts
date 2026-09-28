import { useSyncExternalStore } from "react";
import { api, call } from "../../api";
import type { CodeLength, PickupProtection } from "../../../shared/codes";
import { coalesce } from "../../lib/coalesce";
import { onChange } from "../../lib/live";

type ConfigState = {
  codeLength: CodeLength | null;
  protection: PickupProtection | null;
  loading: boolean;
  error: string;
};

// One copy for the whole tab: every mounted entry surface and notice shares its requests.
let state: ConfigState = { codeLength: null, protection: null, loading: true, error: "" };
const subscribers = new Set<() => void>();
function update(next: ConfigState) {
  state = next;
  subscribers.forEach((fn) => fn());
}

const refresher = coalesce(
  async () => {
    try {
      const response = await call(api.pickup.config);
      const codeLength = response.codeLength;
      if (codeLength !== 4 && codeLength !== 6) throw new Error("Relay returned an unsupported code length.");
      update({ codeLength, protection: response.protection, loading: false, error: "" });
    } catch (error) {
      update({
        ...state,
        loading: false,
        error: (error as Error)?.message || "Could not load the current code settings.",
      });
      throw error;
    }
  },
  { delay: 150, interval: 1000 },
);

/** Keeps the shared copy current while anything shows it. */
function watch() {
  const refreshWhenVisible = () => {
    if (document.visibilityState === "visible") void refresher.request();
  };
  // Members hear about changes from the event stream; focus and online cover visitors and another
  // device, and the visible timer catches changes while a surface stays open.
  const offCodes = onChange("codes", refreshWhenVisible);
  window.addEventListener("focus", refreshWhenVisible);
  window.addEventListener("online", refreshWhenVisible);
  document.addEventListener("visibilitychange", refreshWhenVisible);
  const timer = window.setInterval(refreshWhenVisible, 60_000);
  void refresher.request(true);
  return () => {
    offCodes();
    window.removeEventListener("focus", refreshWhenVisible);
    window.removeEventListener("online", refreshWhenVisible);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
    window.clearInterval(timer);
  };
}
let unwatch: (() => void) | null = null;
function subscribe(fn: () => void) {
  subscribers.add(fn);
  unwatch ??= watch();
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size) {
      unwatch?.();
      unwatch = null;
    }
  };
}

/** Reads the code length afresh, for a submission that must use the current one. */
async function refetch(): Promise<CodeLength> {
  await refresher.request(true);
  return state.codeLength!;
}

/** The active deployment-wide code length, shared by every mounted entry surface. */
export function useCodeConfig(): ConfigState & { refetch: () => Promise<CodeLength> } {
  const current = useSyncExternalStore(subscribe, () => state);
  return { ...current, refetch };
}
