import { useSyncExternalStore } from "react";

// Preferences that belong to this browser only.
export type LocalPrefs = {
  theme: "system" | "light" | "dark";
  /** Items sent to this device from your others download as soon as they arrive. */
  autoAccept: boolean;
  /** Arrivals open the receive popup; otherwise they wait in Activity. */
  popups: boolean;
  sound: boolean;
  system: boolean;
};
const KEY = "relay-local-prefs";
const defaults: LocalPrefs = { theme: "system", autoAccept: true, popups: true, sound: false, system: false };
function read(): LocalPrefs {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<LocalPrefs>) };
  } catch {
    return defaults;
  }
}
let prefs = typeof localStorage !== "undefined" ? read() : defaults;
const listeners = new Set<() => void>();
export function setLocalPrefs(patch: Partial<LocalPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private mode: keep the setting for this session only.
  }
  applyTheme();
  listeners.forEach((fn) => fn());
}
export const getLocalPrefs = () => prefs;
export function useLocalPrefs() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => prefs,
  );
}
export function applyTheme() {
  const dark =
    prefs.theme === "dark" || (prefs.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0c0e" : "#f6f6f4");
}
if (typeof window !== "undefined") {
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  // A change made in another tab applies here too, so every tab of this browser agrees.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    prefs = read();
    applyTheme();
    listeners.forEach((fn) => fn());
  });
}
export function chime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    // Audio unavailable.
  }
}
