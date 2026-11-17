import { useSyncExternalStore } from "react";
import { navigate } from "./router";

// Relay as an installed app: its service worker (public/sw.js), the browser's install offer, and
// what this device can do (iPhones and iPads only allow notifications in the Home Screen app).

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let installOffer: InstallPrompt | null = null;
let worker: Promise<ServiceWorkerRegistration | null> | null = null;

export const isIOS =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS asks for desktop pages and says it is a Mac.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Running as the installed app (Home Screen, or an installed desktop app). */
export function isInstalled() {
  if (typeof window === "undefined") return false;
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Registers the service worker, once. Only built Relay has one; the dev server's reloads need none. */
export function startServiceWorker() {
  if (worker) return worker;
  if (!("serviceWorker" in navigator) || !isSecureContext || !import.meta.env.PROD)
    return (worker = Promise.resolve(null));
  worker = navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  // A tapped notification opens its page in a Relay window that's already open.
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string; url?: unknown }>) => {
    const url = event.data?.url;
    if (event.data?.type === "relay-open" && typeof url === "string" && url.startsWith("/") && !url.startsWith("//"))
      navigate(url);
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    // Kept for Settings' "Install Relay" instead of the browser's own banner at a random moment.
    event.preventDefault();
    installOffer = event as InstallPrompt;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installOffer = null;
    emit();
  });
  return worker;
}

/** The service worker, once it is running; null where there is none. */
export const serviceWorker = () => worker ?? Promise.resolve(null);

/** Whether the browser offered to install Relay (Chromium browsers, not yet installed). */
export function useInstallOffer() {
  return useSyncExternalStore(subscribe, () => installOffer);
}

/** Shows the browser's install dialog. Resolves true when the person installed Relay. */
export async function install() {
  const offer = installOffer;
  if (!offer) return false;
  await offer.prompt();
  const { outcome } = await offer.userChoice;
  installOffer = null;
  emit();
  return outcome === "accepted";
}
