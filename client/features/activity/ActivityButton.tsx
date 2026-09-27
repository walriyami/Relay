import { useEffect, useRef, useState } from "react";
import { Bell, Settings } from "lucide-react";
import type { ActivityEntry, Delivery } from "../../api";
import { ago } from "../../lib/format";
import { navigate } from "../../lib/router";
import { ownerSource } from "../../lib/source";
import { Thumbnail } from "../../components/Thumbnail";
import { Button, IconButton, InlineEmpty, LoadFailed, Popover } from "../../components/ui";
import { useSession } from "../../app/session";
import { errorToast } from "../library/actions";
import { linkAddress } from "../links/address";
import { requestAddress } from "../requests/address";
import { acceptDelivery, declineDelivery } from "../incoming/answer";
import { describeAnswered, describeDelivery, describeEntry, type Described } from "./describe";
import { useActivity } from "./ActivityProvider";

/** The list shows at most this many lines; older ones are still in the feed's own limit. */
const SHOWN = 50;
type Line = { key: string; at: number; described: Described; fresh: boolean; onOpen?: () => void };

/** The bell in the top bar: items waiting for this device, then everything that happened. */
export function ActivityButton() {
  const activity = useActivity();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { waiting } = activity;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn btn-ghost btn-md btn-icon activity-button ${open ? "active" : ""}`}
        aria-label={waiting ? `Activity, ${waiting} new` : "Activity"}
        title="Activity"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <Bell size={20} aria-hidden />
        {waiting > 0 && <span className="badge">{waiting > 9 ? "9+" : waiting}</span>}
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Activity" className="activity-popover">
          <ActivityPanel close={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

function ActivityPanel({ close }: { close: () => void }) {
  const { me } = useSession();
  const {
    pending,
    answered,
    entries,
    seen,
    loading,
    deliveryError,
    feedError,
    reloadDeliveries,
    reloadFeed,
    markSeen,
    open,
  } = useActivity();
  // What was new when the panel opened stays marked while it is open, though it is now seen.
  const [seenAtOpen] = useState(seen);
  useEffect(markSeen, [markSeen]);
  const go = (to: string) => {
    close();
    navigate(to);
  };
  const view = (d: Delivery) => {
    close();
    open({ delivery: d });
  };
  const entryAction = (e: ActivityEntry) =>
    e.kind === "upload"
      ? () => go(requestAddress(e.requestId))
      : e.kind === "link"
        ? () => go(linkAddress(e.linkId))
        : e.kind === "joined" && me.user.admin
          ? () => go("/admin")
          : undefined;
  const lines: Line[] = [
    ...entries.map((e) => ({
      key: e.id,
      at: e.created,
      described: describeEntry(e),
      fresh: !e.self && e.created > seenAtOpen,
      onOpen: entryAction(e),
    })),
    ...(me.prefs.activity.received ? answered : []).map((d) => ({
      key: `delivery:${d.id}`,
      at: d.answered ?? d.created,
      described: describeAnswered(d),
      fresh: false,
      onOpen: () => view(d),
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, SHOWN);

  return (
    <>
      <div className="popover-head">
        <strong>Activity</strong>
        <IconButton
          size="sm"
          label="Activity settings"
          icon={<Settings size={16} />}
          onClick={() => go("/settings#s-activity")}
        />
      </div>
      <div className="activity-scroll">
        {deliveryError && (
          <LoadFailed
            banner
            title="Deliveries couldn’t be loaded"
            error={`Deliveries: ${deliveryError}`}
            onRetry={reloadDeliveries}
          />
        )}
        {feedError && (
          <LoadFailed
            banner
            title="Account activity couldn’t be loaded"
            error={`Account activity: ${feedError}`}
            onRetry={reloadFeed}
          />
        )}
        {pending.length > 0 && (
          <section className="activity-section" aria-labelledby="activity-waiting">
            <h3 id="activity-waiting" className="activity-heading">
              Waiting for you
            </h3>
            <ul className="activity-list">
              {pending.map((d) => (
                <PendingRow key={d.id} d={d} onOpen={() => view(d)} />
              ))}
            </ul>
          </section>
        )}
        {lines.length > 0 ? (
          <section className="activity-section" aria-label="Recent activity">
            <h3 className="activity-heading">Recent</h3>
            <ul className="activity-list">
              {lines.map((line) => (
                <EntryRow key={line.key} line={line} />
              ))}
            </ul>
          </section>
        ) : !pending.length && loading ? (
          <p className="muted popover-empty waiting">Loading activity…</p>
        ) : !pending.length && !deliveryError && !feedError ? (
          <div className="popover-empty">
            <InlineEmpty icon={<Bell size={20} />} title="No activity yet">
              Items from your other devices, files sent to your requests and sign-ins appear here.
            </InlineEmpty>
          </div>
        ) : null}
      </div>
    </>
  );
}

function PendingRow({ d, onOpen }: { d: Delivery; onOpen: () => void }) {
  const [busy, setBusy] = useState<"" | "accept" | "decline">("");
  const name = d.item?.name || "Removed item";
  async function run(action: "accept" | "decline") {
    setBusy(action);
    try {
      await (action === "accept" ? acceptDelivery(d) : declineDelivery(d));
    } catch (error) {
      errorToast(error);
      setBusy("");
    }
  }
  return (
    <li className="activity-item is-pending">
      <button type="button" className="activity-open" onClick={onOpen}>
        <span className="activity-thumb">
          {d.item?.preview ? (
            <Thumbnail compact source={ownerSource} entry={d.item.preview} />
          ) : (
            <Thumbnail compact entry={{ path: name, kind: "text" }} />
          )}
        </span>
        <span className="activity-text">
          <strong>{name}</strong>
          {/* Beside Accept and Decline there is less room, so who and when, then what, each on a line. */}
          <span className="muted">{[d.from && `From ${d.from.name}`, ago(d.created)].filter(Boolean).join(" · ")}</span>
          {d.item && <span className="muted">{describeDelivery(d)}</span>}
        </span>
      </button>
      <span className="activity-answer">
        <Button
          size="sm"
          variant="ghost"
          busy={busy === "decline"}
          disabled={!!busy}
          onClick={() => void run("decline")}
        >
          Decline
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy === "accept"}
          disabled={!!busy}
          onClick={() => void run("accept")}
        >
          Accept
        </Button>
      </span>
    </li>
  );
}

function EntryRow({ line }: { line: Line }) {
  const { described: d, fresh, onOpen, at } = line;
  const body = (
    <>
      <span className={`activity-icon ${d.tone === "warn" ? "is-warn" : ""}`} aria-hidden>
        {d.icon}
      </span>
      <span className="activity-text">
        <strong>
          {fresh && (
            <>
              <span className="unread-dot" aria-hidden />
              <span className="visually-hidden">New: </span>
            </>
          )}
          {d.title}
        </strong>
        <span className="muted">
          {d.detail} · {ago(at)}
        </span>
      </span>
    </>
  );
  return (
    <li className={`activity-item ${fresh ? "is-fresh" : ""}`}>
      {onOpen ? (
        <button type="button" className="activity-open" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="activity-open">{body}</div>
      )}
    </li>
  );
}
