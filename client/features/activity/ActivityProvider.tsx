import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, call, type ActivityEntry, type ActivityFeed, type Delivery } from "../../api";
import { plural } from "../../lib/format";
import { useLive } from "../../lib/live";
import { chime, getLocalPrefs } from "../../lib/local-prefs";
import { navigate } from "../../lib/router";
import { setWaitingCount } from "../../lib/tab-title";
import { toast } from "../../components/ui";
import { downloadItem, errorToast, hasDownloads } from "../library/actions";
import { requestAddress } from "../requests/address";
import { ReceiveModal, type Received } from "../incoming/ReceiveModal";
import { answerDelivery, isPending } from "../incoming/answer";

type Activity = {
  /** Deliveries waiting for this device to accept or decline them, newest first. */
  pending: Delivery[];
  /** Deliveries this device already answered, newest first. */
  answered: Delivery[];
  entries: ActivityEntry[];
  /** Entries newer than this were not seen on any device. */
  seen: number;
  /** Pending deliveries plus unseen entries: the bell's badge and the tab title's count. */
  waiting: number;
  loading: boolean;
  deliveryError: string;
  feedError: string;
  reloadDeliveries: () => void;
  reloadFeed: () => void;
  /** Marks everything shown as seen, on every device of the account. */
  markSeen: () => void;
  /** Opens something received in the receive popup. */
  open: (received: Received) => void;
};
const ActivityContext = createContext<Activity | null>(null);

export function useActivity() {
  const value = useContext(ActivityContext);
  if (!value) throw new Error("Activity unavailable");
  return value;
}

const EMPTY_FEED: ActivityFeed = { entries: [], seen: 0 };
/** A tab in the background leaves an arrival to a visible tab of the same browser for this long. */
const BACKGROUND_GRACE = 1500;
const itemName = (d: Delivery) => d.item?.name || "an item";
const isNew = (e: ActivityEntry, seen: number) => !e.self && e.created > seen;

function notifySystem(body: string, tag: string, onClick?: () => void) {
  const prefs = getLocalPrefs();
  if (!prefs.system || !document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const notice = new Notification("Relay", { body, tag });
  notice.onclick = () => {
    window.focus();
    onClick?.();
    notice.close();
  };
}

/**
 * The signed-in member's Activity: what arrived for this device, and what happened on the account.
 * It announces new arrivals as this browser's settings ask, accepts them automatically when that is
 * on, and hosts the receive popup so anything can open one.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const deliveries = useLive(
    api.deliveries.list,
    { query: { direction: "incoming" } },
    // Item changes that affect a delivery (trash, expiry) are published on "deliveries" too.
    ["deliveries"],
    [] as Delivery[],
  );
  const feed = useLive(api.activity.list, {}, ["activity"], EMPTY_FEED);
  const [viewing, setViewing] = useState<Received | null>(null);
  const [queue, setQueue] = useState<string[]>([]);

  const pending = useMemo(() => deliveries.data.filter(isPending), [deliveries.data]);
  const answered = useMemo(
    () => deliveries.data.filter((d) => d.state !== "available" && d.available),
    [deliveries.data],
  );
  const { entries, seen } = feed.data;
  const unseen = entries.filter((e) => isNew(e, seen)).length;
  const waiting = pending.length + unseen;
  useEffect(() => {
    setWaitingCount(waiting);
    return () => setWaitingCount(0);
  }, [waiting]);

  // Arrivals: anything that wasn't there when this tab first looked.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (deliveries.loading) return;
    if (!known.current) {
      // A failed first load isn't a baseline: everything would look new once it loads.
      if (!deliveries.error) known.current = new Set(deliveries.data.map((d) => d.id));
      return;
    }
    const fresh = deliveries.data.filter((d) => !known.current!.has(d.id) && isPending(d));
    for (const d of deliveries.data) known.current.add(d.id);
    if (!fresh.length) return;
    const prefs = getLocalPrefs();
    const first = fresh[0];
    const message =
      fresh.length > 1
        ? `${plural(fresh.length, "item")} arrived`
        : `${first.from?.name || "Another device"} sent “${itemName(first)}”`;
    if (prefs.sound) chime();
    notifySystem(message, `delivery:${first.id}`);
    for (const d of [...fresh].reverse()) arrive(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- announce arrivals only when the delivery list changes.
  }, [deliveries.data, deliveries.loading, deliveries.error]);

  function arrive(d: Delivery) {
    const prefs = getLocalPrefs();
    const show = () => (prefs.popups ? setQueue((q) => [...q, d.id]) : announce(d, prefs.autoAccept));
    if (!prefs.autoAccept) return show();
    // Accepting is claimed on the server, so with several tabs open only one downloads it; a tab
    // in the background gives a visible one the first chance.
    setTimeout(
      () =>
        void answerDelivery(d, "accepted")
          .then(async (won) => {
            if (!won) return;
            if (d.item && hasDownloads(d.item)) await downloadItem(d.item);
            show();
          })
          .catch(errorToast),
      document.hidden ? BACKGROUND_GRACE : 0,
    );
  }

  function announce(d: Delivery, accepted: boolean) {
    const from = d.from?.name || "Another device";
    toast(
      accepted && d.item && hasDownloads(d.item)
        ? `Downloading “${itemName(d)}” from ${from}`
        : `${from} sent “${itemName(d)}”`,
      {
        key: `delivery:${d.id}`,
        action: { label: accepted ? "View" : "Open", onClick: () => setViewing({ delivery: d }) },
      },
    );
  }

  // Popups wait for this tab to be visible and for any dialog, menu or popover already open,
  // instead of taking focus from it. Anything answered elsewhere meanwhile opens only if it was
  // accepted here.
  useEffect(() => {
    if (viewing || !queue.length) return;
    const next = () => {
      if (document.hidden || document.body.classList.contains("modal-open") || document.querySelector(".popover"))
        return;
      const [id, ...rest] = queue;
      setQueue(rest);
      const current = deliveries.data.find((d) => d.id === id);
      if (current?.available && current.state !== "declined") setViewing({ delivery: current });
    };
    next();
    document.addEventListener("visibilitychange", next);
    // Dialogs mark the body; menus and popovers are portals added to and removed from it.
    const dialogs = new MutationObserver(next);
    dialogs.observe(document.body, { attributes: true, attributeFilter: ["class"], childList: true });
    return () => {
      document.removeEventListener("visibilitychange", next);
      dialogs.disconnect();
    };
  }, [queue, viewing, deliveries.data]);

  // New files through a request: "New files for Tax documents · View".
  const knownEntries = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (feed.loading) return;
    if (!knownEntries.current) {
      if (!feed.error) knownEntries.current = new Set(entries.map((e) => e.id));
      return;
    }
    const fresh = entries.filter((e) => !knownEntries.current!.has(e.id));
    for (const e of entries) knownEntries.current.add(e.id);
    const uploads = fresh.filter((e): e is Extract<ActivityEntry, { kind: "upload" }> => e.kind === "upload");
    if (!uploads.length) return;
    const requests = [...new Map(uploads.map((u) => [u.requestId, u])).values()];
    const one = requests.length === 1 ? requests[0] : null;
    const message = one ? `New files for ${one.request}` : `New files for ${plural(requests.length, "request")}`;
    const view = () => navigate(one ? requestAddress(one.requestId) : "/requests");
    toast(message, { key: `request-files:${one?.requestId ?? "many"}`, action: { label: "View", onClick: view } });
    if (getLocalPrefs().sound) chime();
    notifySystem(message, `request:${one?.requestId ?? "many"}`, view);
  }, [entries, feed.loading, feed.error]);

  const newest = entries[0]?.created ?? 0;
  const markSeen = useCallback(() => {
    if (newest > seen) void call(api.activity.seen, { body: { until: newest } }).catch(() => {});
  }, [newest, seen]);

  // The popup follows the delivery live: accepted in the footer, or answered on another tab.
  const shown =
    viewing && "delivery" in viewing
      ? { delivery: deliveries.data.find((d) => d.id === viewing.delivery.id) ?? viewing.delivery }
      : viewing;

  const value: Activity = {
    pending,
    answered,
    entries,
    seen,
    waiting,
    loading: deliveries.loading || feed.loading,
    deliveryError: deliveries.error,
    feedError: feed.error,
    reloadDeliveries: deliveries.reload,
    reloadFeed: feed.reload,
    markSeen,
    open: setViewing,
  };
  return (
    <ActivityContext.Provider value={value}>
      {children}
      {shown && <ReceiveModal received={shown} onClose={() => setViewing(null)} />}
    </ActivityContext.Provider>
  );
}
