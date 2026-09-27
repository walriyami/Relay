import { Component, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CloudOff } from "lucide-react";
import { Button, confirmDialog } from "../components/ui";
import { getDraft } from "../lib/draft";
import { connection, onConnectivity, reportFailure } from "../lib/connection";
import { navigate } from "../lib/router";
import { isBusy, snapshot, subscribe, transfers } from "../lib/transfers";

let retries = 0;
/** How many times "Try again" was chosen, so a lazily loaded page knows to fetch its code anew. */
export const pageRetries = () => retries;

/** Keep the shell, session and tab-owned transfers alive when one page fails to render or load. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  constructor(props: { children: ReactNode }) {
    super(props);
    // Each visit to a section is a fresh attempt at a page whose code failed to load before.
    retries++;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <PageFailure
        retry={() => {
          retries++;
          // Focus waits on the page's main area, as after any navigation, not on what sits beside it.
          document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
          this.setState({ failed: false });
        }}
      />
    ) : (
      this.props.children
    );
  }
}

function PageFailure({ retry }: { retry: () => void }) {
  useSyncExternalStore(subscribe, snapshot);
  const busy = transfers.some(isBusy);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  // Most pages fail to load because the connection went: find out, and load again once it's back.
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    reportFailure();
    return onConnectivity(() => {
      if (connection().state === "ok" && connection().recovered) latest.current();
    });
  }, []);

  async function reload() {
    // Check live state as well as disabling the button: a transfer can start while a dialog is open.
    if (transfers.some(isBusy)) return;
    if (getDraft().items.length) {
      const confirmed = await confirmDialog({
        title: "Reload and clear selected files?",
        body: "You’ll need to select these files and folders again. Your typed text stays in this tab.",
        confirm: "Reload page",
        cancel: "Keep selection",
      });
      if (!confirmed) return;
    }
    if (!transfers.some(isBusy)) location.reload();
  }

  return (
    <div className="page not-found">
      <span className="empty-icon">
        <CloudOff size={26} aria-hidden />
      </span>
      <h1 ref={heading} tabIndex={-1}>
        This page couldn’t load
      </h1>
      <p className="muted">Check your connection and try again, return to Send, or reload the page.</p>
      <p id="page-reload-help" className="muted" role="status">
        {busy ? "Uploads are still open. Return to Send to finish or cancel them before reloading." : ""}
      </p>
      <div className="row center">
        <Button variant="primary" onClick={retry}>
          Try again
        </Button>
        <Button onClick={() => navigate("/")}>Go to Send</Button>
        <Button disabled={busy} aria-describedby={busy ? "page-reload-help" : undefined} onClick={() => void reload()}>
          Reload page
        </Button>
      </div>
    </div>
  );
}
