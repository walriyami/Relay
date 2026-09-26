import type { Transfer } from "./transfers";

/**
 * The tab title is status, never navigation: always "Relay", led by what is worth seeing from
 * another tab. Uploads running in this tab show their combined progress ("↑ 42%"), and the number
 * of things waiting for you (items to accept, new activity) is shown in brackets:
 * "(2) ↑ 42% · Relay".
 */
const NAME = "Relay";

type Progress = Pick<Transfer, "status" | "totalBytes" | "sentBytes">;

/** Upload progress across this tab's in-flight transfers, or "" when nothing is uploading. */
export function uploadStatus(inFlight: readonly Progress[]) {
  const running = inFlight.filter((t) => t.status !== "cancelling");
  if (!running.length) return "";
  // Some files failed, or everything is saved but the link or delivery didn't go through.
  if (running.some((t) => t.status === "attention" || t.status === "destination")) return "Upload needs attention";
  const total = running.reduce((n, t) => n + t.totalBytes, 0);
  const sent = running.reduce((n, t) => n + Math.min(t.sentBytes, t.totalBytes), 0);
  // Never 100% until the server has confirmed everything: the last bytes are still being saved.
  const percent = total ? Math.min(99, Math.floor((sent / total) * 100)) : 0;
  if (running.every((t) => t.status === "paused")) return `Paused ${percent}%`;
  if (running.every((t) => t.status === "finishing")) return "↑ Finishing";
  return `↑ ${percent}%`;
}

export function tabTitle(count: number, upload: string) {
  return [count > 0 ? `(${count > 99 ? "99+" : count})` : "", upload ? `${upload} ·` : "", NAME]
    .filter(Boolean)
    .join(" ");
}

let waiting = 0;
let inFlight: () => readonly Progress[] = () => [];

function render() {
  const next = tabTitle(waiting, uploadStatus(inFlight()));
  if (document.title !== next) document.title = next;
}

/** How many things wait for the signed-in member; 0 when signed out or on a public page. */
export function setWaitingCount(count: number) {
  waiting = count;
  render();
}

/** Keeps the title in step with this tab's uploads, read from `running` whenever `subscribe` fires. */
export function installTabTitle(subscribe: (listener: () => void) => unknown, running: () => readonly Progress[]) {
  inFlight = running;
  subscribe(render);
  render();
}
