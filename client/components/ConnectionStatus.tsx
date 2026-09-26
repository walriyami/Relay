import { useEffect, useState, type ReactNode } from "react";
import { Check, Globe, Laptop, Loader2, Server, Smartphone } from "lucide-react";
import { retryNow, useConnection, type Connection } from "../lib/connection";
import { isBusy } from "../lib/transfers";
import { useTransfers } from "../features/send/TransferList";
import { Button } from "./ui";

// The server keeps a tab's unfinished uploads this long without hearing from it (tabLeaseMs), and
// gives every tab that long again when it restarts.
const LEASE_MINUTES = 5;

type Problem = "offline" | "no-network" | "down";
const problemOf = (c: Connection): Problem | null =>
  c.state === "offline" || c.state === "no-network" || c.state === "down" ? c.state : null;

/** What went wrong, in words: a headline and whose side it is on. */
export function describeProblem(problem: Problem) {
  switch (problem) {
    case "offline":
      return {
        title: "You’re offline",
        detail: "This device isn’t connected to the internet. Relay reconnects by itself when it is.",
      };
    case "no-network":
      return {
        title: "Your connection isn’t getting through",
        detail: "This device is on a network, but it isn’t reaching the internet. Check the Wi‑Fi or try mobile data.",
      };
    case "down":
      return {
        title: "Relay is down",
        detail: "Your internet is working. Relay’s server isn’t answering, so there’s nothing to fix on your side.",
      };
  }
}

/** What the pause means for uploads in this tab, if there are any. */
function uploadsLine(problem: Problem) {
  return problem === "down"
    ? "Uploads are paused and continue when Relay is back."
    : `Uploads are paused and continue if you’re back within ${LEASE_MINUTES} minutes.`;
}

const isPhone = () => typeof navigator !== "undefined" && /iPhone|Android.+Mobile/.test(navigator.userAgent);

/**
 * This device, the internet and Relay, with the link that's broken marked: the answer to "is it me
 * or is it Relay?" at a glance. The words beside it say the same for screen readers.
 */
export function ConnectionPath({ problem, large = false }: { problem: Problem | null; large?: boolean }) {
  const size = large ? 22 : 15;
  const near = problem === "offline" || problem === "no-network";
  const far = problem === "down";
  const Device = isPhone() ? Smartphone : Laptop;
  // What can't be reached from here is dimmed; the link that's broken is dashed.
  const hop = (broken: boolean) => <span className={`conn-hop${broken ? " is-broken" : ""}`} />;
  const node = (icon: ReactNode, label: string, cut: boolean) => (
    <span className={`conn-node${cut ? " is-cut" : ""}`}>
      <span className="conn-dot">{icon}</span>
      {large && <small>{label}</small>}
    </span>
  );
  return (
    <span className={`conn-path${large ? " is-large" : ""}`} aria-hidden>
      {node(<Device size={size} />, "You", false)}
      {hop(near)}
      {node(<Globe size={size} />, "Internet", near)}
      {hop(far)}
      {node(<Server size={size} />, "Relay", !!problem)}
    </span>
  );
}

/** Seconds until the next automatic check, counting down; re-renders each second while there is one. */
function useSecondsUntil(at: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** "Checking…", "Trying again in 8 s", and the one way to try now. Offline, the browser says when. */
export function RetryControl({ c, size = "sm" }: { c: Connection; size?: "sm" | "md" }) {
  const seconds = useSecondsUntil(c.retryAt);
  if (c.state === "offline") return null;
  return (
    <span className="conn-retry">
      {c.probing ? (
        <span className="conn-when">
          <Loader2 className="spin" size={14} aria-hidden /> Checking…
        </span>
      ) : seconds !== null ? (
        <span className="conn-when">Trying again in {seconds} s</span>
      ) : null}
      <Button size={size} variant={size === "md" ? "primary" : "secondary"} disabled={c.probing} onClick={retryNow}>
        Try now
      </Button>
    </span>
  );
}

/**
 * The one place that says Relay can't be reached: a line under the top bar with where the break is,
 * what it means for uploads, and the only retry. Everything else just waits quietly and picks up
 * again by itself. A moment's "back" confirms it's over. The status region is always present so
 * screen readers hear it change.
 */
export function ConnectionBar() {
  const c = useConnection();
  const uploading = useTransfers().some(isBusy);
  const problem = problemOf(c);
  const { title, detail } = problem ? describeProblem(problem) : { title: "", detail: "" };
  return (
    <div className="conn-region" role="status">
      {problem ? (
        <div className={`conn-bar is-${problem}`}>
          <div className="conn-inner">
            <ConnectionPath problem={problem} />
            <p className="conn-text">
              <strong>{title}.</strong> <span className="conn-detail">{uploading ? uploadsLine(problem) : detail}</span>
            </p>
            <RetryControl c={c} />
          </div>
        </div>
      ) : c.recovered ? (
        <div className="conn-bar is-back">
          <div className="conn-inner">
            <Check size={16} aria-hidden />
            <p className="conn-text">
              <strong>{c.recovered === "down" ? "Relay is back." : "You’re back online."}</strong>{" "}
              <span className="conn-detail">{uploading ? "Uploads are continuing." : "Everything is up to date."}</span>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A whole screen for when Relay can't be opened at all: the same diagnosis, larger. */
export function ConnectionScreen({ onRetry }: { onRetry: () => void }) {
  const c = useConnection();
  const problem = problemOf(c);
  const { title, detail } = problem
    ? describeProblem(problem)
    : { title: "Relay couldn’t open", detail: "Something went wrong while opening Relay. It keeps trying by itself." };
  return (
    <div className="conn-screen">
      <ConnectionPath problem={problem} large />
      <h1>{title}</h1>
      <p className="muted">{detail}</p>
      {problem ? (
        <RetryControl c={c} size="md" />
      ) : (
        <Button variant="primary" onClick={onRetry}>
          Try now
        </Button>
      )}
    </div>
  );
}

/** "Waiting for your connection", in place of a list that can't load while Relay is out of reach. */
export function waitingText(problem: Problem) {
  return problem === "down"
    ? "This loads by itself when Relay is back."
    : "This loads by itself when you’re back online.";
}
export { problemOf };
