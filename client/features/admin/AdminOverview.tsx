// What the owner opens Admin for, in that order: is anything wrong or waiting for me, and how much
// space is left; how storage, activity and each member have moved over time; and what happened,
// as a history they can filter. How the server itself runs stays folded away under Server details.
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  FileUp,
  HardDrive,
  KeyRound,
  Server,
  Share2,
  UserRound,
} from "lucide-react";
import {
  api,
  call,
  displayName,
  isDiskLow,
  type AdminOverview as Overview,
  type AdminUsageReport,
  type UsageRange,
} from "../../api";
import { HISTORY_GROUP_OF, type HistoryEntry, type HistoryGroup } from "../../../shared/model";
import { bytes, date, dateTime, percent, plural } from "../../lib/format";
import { notifyChange, useLive } from "../../lib/live";
import { usePeriodicRefresh } from "../../lib/refresh";
import { scrollMotion } from "../../lib/router";
import { Button, LoadFailed, PageLink, ProgressBar, Segmented } from "../../components/ui";
import {
  Chart,
  Delta,
  FLOW,
  Legend,
  RangeSwitch,
  STORED,
  Stat,
  StorageBar,
  periodLabels,
  rangeSpan,
  storageSegments,
  timeZoneOffset,
} from "../usage/charts";

export function AdminOverview({ data, invites }: { data: Overview; invites: number }) {
  // Trends can point History at what they summarise, so its filter lives here.
  const [filter, setFilter] = useState<HistoryFilter>({ group: null, member: null });
  const history = useRef<HTMLElement>(null);
  const showHistory = (next: HistoryFilter) => {
    setFilter(next);
    history.current?.scrollIntoView({ behavior: scrollMotion(), block: "start" });
  };
  return (
    <>
      <Status data={data} invites={invites} onShowProblems={() => showHistory({ group: "problems", member: null })} />
      <Trends data={data} onShowMember={(member) => showHistory({ group: null, member })} />
      <History ref={history} members={data.members} filter={filter} onFilter={setFilter} />
      <ServerDetails data={data} />
    </>
  );
}

type Alert = { text: string; tone: "danger" | "info"; to?: string; link?: string };

/** What needs the administrator, in plain words; "info" is waiting on them but isn't broken. */
function alerts(data: Overview, invites: number): Alert[] {
  const { operations: o, storage, integrity, usageBuffer, local, database } = data;
  const stale = (stage: Overview["operations"]["maintenance"][number]) =>
    o.sampled - stage.attempted > Math.max(5 * 60_000, 3 * o.maintenanceIntervalMs);
  const damaged = integrity.missing + integrity.corrupt + integrity.errors;
  const suspended = data.members.filter((m) => m.disabled);
  const used = storage.used + storage.reserved;
  const danger = [
    database.failure?.damaged &&
      "Relay’s database is damaged. Restart Relay; if it won’t start, its message says what to do next.",
    database.failure &&
      !database.failure.damaged &&
      `Relay couldn’t save a change to its database (${database.failure.message}). Changes may fail until storage recovers; check free space and the data drive.`,
    isDiskLow(storage.diskFree, storage.diskTotal) &&
      `The disk is almost full: ${bytes(storage.diskFree)} left. Free space on the server before uploads start failing.`,
    used > storage.capacity &&
      `Members have saved more than the total storage (${bytes(used)} of ${bytes(storage.capacity)}). New uploads are refused until something is deleted or the total is raised in Settings.`,
    damaged > 0 &&
      `${plural(damaged, "stored file")} ${damaged === 1 ? "is" : "are"} missing or damaged. Server details lists whose; they see which items are affected and can upload those files again. Check the server’s data drive.`,
    integrity.lastError && "The last file check couldn’t finish. Run it again under Server details.",
    o.maintenance.some((stage) => stage.failed) &&
      "A cleanup job failed. Relay retries it on its next round; History shows which one.",
    o.maintenance.some(stale) && "Cleanup hasn’t run recently. Check that the server is running normally.",
    usageBuffer.failed && "Statistics couldn’t be saved. Relay keeps them and tries again when storage recovers.",
    usageBuffer.discarded > 0 &&
      "Some statistics were lost while storage was failing, so the charts may show less than happened. Files and limits aren’t affected.",
    local.state === "down" &&
      `Direct transfers aren’t working${local.problem ? `: ${local.problem}` : "."} Transfers go over the internet meanwhile.`,
  ];
  const waiting: (Alert | false)[] = [
    invites > 0 && {
      text: `${plural(invites, "invitation")} ${invites === 1 ? "hasn’t" : "haven’t"} been used yet.`,
      tone: "info",
      to: "/admin/members#admin-invites",
      link: "See invitations",
    },
    suspended.length > 0 && {
      text: `${suspended.map((m) => m.username).join(", ")} ${suspended.length === 1 ? "is" : "are"} suspended and can’t sign in.`,
      tone: "info",
      to: "/admin/members",
      link: "Manage members",
    },
    !!data.codeAttackAt &&
      Date.now() - data.codeAttackAt < 7 * 24 * 3_600_000 && {
        text: `Someone tried many wrong codes on ${dateTime(data.codeAttackAt)}. Each network got only a few tries, and codes kept working for everyone else.`,
        tone: "info",
      },
    !integrity.lastFullCheck &&
      !integrity.running && {
        text: "Stored files haven’t been checked for damage yet.",
        tone: "info",
        to: "#admin-server",
        link: "Check now",
      },
  ];
  return [
    ...danger.filter((text): text is string => !!text).map((text) => ({ text, tone: "danger" as const })),
    ...waiting.filter((alert): alert is Alert => !!alert),
  ];
}
const problems = (data: Overview) => alerts(data, 0).filter((a) => a.tone === "danger");

/** Leads the other Admin tabs when something needs a look, and links to the overview. */
export function HealthNotice({ data }: { data: Overview }) {
  const found = problems(data);
  if (!found.length) return null;
  return (
    <div className="notice health-notice" role="status">
      <strong>Relay needs attention</strong>
      <span>{found.length === 1 ? found[0].text : `${found.length} problems were found.`}</span>
      <PageLink to="/admin">See the overview</PageLink>
    </div>
  );
}

function Status({ data, invites, onShowProblems }: { data: Overview; invites: number; onShowProblems: () => void }) {
  const list = alerts(data, invites);
  const trouble = list.some((a) => a.tone === "danger");
  const { storage } = data;
  const used = storage.used + storage.reserved;
  const left = Math.max(0, storage.capacity - used);
  return (
    <section
      className={`settings-section card-surface admin-status ${trouble ? "is-danger" : "is-ok"}`}
      aria-labelledby="admin-status"
    >
      <div className="admin-status-head">
        <span className="admin-status-icon" aria-hidden>
          {trouble ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
        </span>
        <div>
          <h2 id="admin-status">{trouble ? "Relay needs attention" : "Everything looks fine"}</h2>
          <p className="muted">
            {plural(data.members.length, "member")}
            {data.activity.activeUploads > 0 && ` · ${plural(data.activity.activeUploads, "upload")} in progress`}
          </p>
        </div>
      </div>
      <div className={`storage-meter${used >= storage.capacity * 0.9 ? " is-tight" : ""}`}>
        <span className="storage-meter-text">
          <strong>{bytes(left)} left</strong> · {bytes(used)} of {bytes(storage.capacity)} used (
          {percent(used, storage.capacity)})
        </span>
        <ProgressBar value={used} max={storage.capacity} label="Storage used on this Relay" minVisible />
      </div>
      {storage.diskFree < left && (
        <p className="field-hint">
          The disk has only {bytes(storage.diskFree)} free, less than the storage has left, so uploads will stop when
          the disk fills first.
        </p>
      )}
      {list.length > 0 && (
        <ul className="admin-alerts" aria-label={trouble ? "Problems and things waiting" : "Waiting for you"}>
          {list.map((alert) => (
            <li key={alert.text} className={`admin-alert is-${alert.tone}`}>
              <span>{alert.text}</span>
              {alert.to?.startsWith("#") ? (
                <a
                  className="link"
                  href={alert.to}
                  onClick={(event) => {
                    event.preventDefault();
                    openServerDetails();
                  }}
                >
                  {alert.link}
                </a>
              ) : (
                alert.to && <PageLink to={alert.to}>{alert.link}</PageLink>
              )}
            </li>
          ))}
          {trouble && (
            <li className="admin-alert-more">
              <button type="button" className="link" onClick={onShowProblems}>
                See problems in History
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Storage, activity and each member over a period the administrator picks. */
function Trends({ data, onShowMember }: { data: Overview; onShowMember: (member: string) => void }) {
  const [range, setRange] = useState<UsageRange>("30d");
  const usage = useLive(api.admin.usage, { query: { range, tz: timeZoneOffset() } }, ["items", "account"], null);
  // Downloads aren't announced live; catch up now and then.
  usePeriodicRefresh(usage.reload, 60_000);
  const report = usage.data;
  return (
    <section className="admin-trends stack" aria-labelledby="admin-trends">
      <div className="admin-range">
        <h2 id="admin-trends">Over {rangeSpan(range)}</h2>
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      {usage.error && report && <LoadFailed banner error={usage.error} onRetry={usage.reload} />}
      {usage.error && !report ? (
        <LoadFailed title="The charts couldn’t be loaded" error={usage.error} onRetry={usage.reload} />
      ) : !report ? (
        <div className="admin-trends-skeleton skeleton waiting" aria-hidden />
      ) : (
        <Report data={data} report={report} range={range} onShowMember={onShowMember} />
      )}
    </section>
  );
}

function Report({
  data,
  report,
  range,
  onShowMember,
}: {
  data: Overview;
  report: AdminUsageReport;
  range: UsageRange;
  onShowMember: (member: string) => void;
}) {
  const { storage, totals, previous } = report;
  const labels = periodLabels(
    report.buckets.map((b) => b.start),
    range,
  );
  const into = totals.uploaded + totals.received;
  const out = totals.downloaded + totals.shared;
  const unit = range === "12m" ? "month" : "day";
  const first = report.buckets[0]?.stored ?? storage.used;
  return (
    <>
      <div className="stats" role="list" aria-label={`Over ${rangeSpan(range)}`}>
        <div role="listitem">
          <Stat
            icon={<HardDrive size={16} />}
            color="var(--chart-2)"
            label="Saved now"
            value={bytes(storage.used)}
            detail={
              storage.used === first
                ? "unchanged"
                : `${storage.used > first ? "up" : "down"} ${bytes(Math.abs(storage.used - first))}`
            }
          />
        </div>
        <div role="listitem">
          <Stat
            icon={<ArrowUpFromLine size={16} />}
            color="var(--chart-1)"
            label="Uploaded"
            value={bytes(into)}
            delta={<Delta now={into} before={previous.uploaded + previous.received} range={range} />}
            detail={totals.received ? `${bytes(totals.received)} from guests` : "by members"}
          />
        </div>
        <div role="listitem">
          <Stat
            icon={<ArrowDownToLine size={16} />}
            color="var(--chart-3)"
            label="Downloaded"
            value={bytes(out)}
            delta={<Delta now={out} before={previous.downloaded + previous.shared} range={range} />}
            detail={totals.shared ? `${bytes(totals.shared)} through shared links` : "by members"}
          />
        </div>
        <div role="listitem">
          <Stat
            icon={<FileUp size={16} />}
            color="var(--chart-4)"
            label="Files added"
            value={totals.files.toLocaleString()}
            delta={<Delta now={totals.files} before={previous.files} range={range} />}
            detail={`${plural(totals.visitors, "visitor")} on shared links`}
          />
        </div>
      </div>

      <section className="usage-card card-surface" aria-labelledby="admin-stored">
        <div className="usage-card-head">
          <h3 id="admin-stored">Storage</h3>
          <p className="usage-headline">
            <strong>{bytes(storage.used + storage.reserved)}</strong>
            <span className="muted"> of {bytes(report.capacity)}</span>
          </p>
        </div>
        <Chart
          kind="area"
          title={`What everyone kept at the end of each ${unit}`}
          buckets={report.buckets}
          labels={labels}
          series={[STORED]}
          unit="bytes"
          height={180}
          empty="Nothing kept yet."
        />
        <StorageBar segments={storageSegments(storage)} max={report.capacity} label="What storage holds now" />
        <p className="field-hint">
          Change the total under <PageLink to="/admin/settings">Settings</PageLink>.
        </p>
      </section>

      <section className="usage-card card-surface" aria-labelledby="admin-moved">
        <div className="usage-card-head">
          <h3 id="admin-moved">Uploads and downloads</h3>
          <p className="usage-headline">
            <strong>{bytes(into + out)}</strong>
            <span className="muted"> in and out</span>
          </p>
        </div>
        <Legend items={FLOW.map((s) => ({ ...s, value: bytes(totals[s.key]) }))} />
        <Chart
          kind="columns"
          title={`Data moved each ${unit}, by everyone`}
          buckets={report.buckets}
          labels={labels}
          series={FLOW}
          unit="bytes"
          empty={`Nothing moved in ${rangeSpan(range)}.`}
        />
        <Reliability report={report} range={range} />
      </section>

      <MemberUsage data={data} report={report} range={range} onShowMember={onShowMember} />
    </>
  );
}

/** Whether people could count on the server over the period, instead of a count of requests. */
function Reliability({ report, range }: { report: AdminUsageReport; range: UsageRange }) {
  const requests = report.traffic.reduce((sum, t) => sum + t.requests, 0);
  const failures = report.traffic.reduce((sum, t) => sum + t.failures, 0);
  if (!requests) return null;
  return (
    <p className={`admin-reliability${failures ? " is-danger" : ""}`}>
      {failures ? <AlertTriangle size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
      <span>
        {failures
          ? `Something went wrong on the server ${plural(failures, "time")} in ${rangeSpan(range)}, out of ${requests.toLocaleString()} things people did (${percent(requests - failures, requests)} worked). History lists them under Problems.`
          : `Everything people did in ${rangeSpan(range)} worked, without a server error.`}
      </span>
    </p>
  );
}

/** Each member's share: what they keep now against their limit, and what they moved over the range. */
function MemberUsage({
  data,
  report,
  range,
  onShowMember,
}: {
  data: Overview;
  report: AdminUsageReport;
  range: UsageRange;
  onShowMember: (member: string) => void;
}) {
  const details = new Map(data.members.map((m) => [m.id, m]));
  const members = [...report.members].sort(
    (a, b) =>
      b.used - a.used ||
      b.totals.uploaded + b.totals.received - (a.totals.uploaded + a.totals.received) ||
      a.username.localeCompare(b.username),
  );
  const most = Math.max(...members.map((m) => details.get(m.id)?.limits.storage ?? m.used), 1);
  return (
    <section className="usage-card card-surface" aria-labelledby="admin-member-usage">
      <div className="usage-card-head">
        <h3 id="admin-member-usage">By member</h3>
        <p className="muted">Stored now, and moved over {rangeSpan(range)}. Choose a name to see their history.</p>
      </div>
      <div className="member-table" role="table" aria-labelledby="admin-member-usage">
        <div className="member-table-row member-table-head" role="row">
          <span role="columnheader">Member</span>
          <span role="columnheader">Stored</span>
          <span role="columnheader">Uploaded</span>
          <span role="columnheader">Downloaded</span>
        </div>
        {members.map((m) => {
          const member = details.get(m.id);
          const limit = member?.limits.storage ?? null;
          return (
            <div className="member-table-row" role="row" key={m.id}>
              <span role="cell" className="member-table-name">
                <span className="avatar is-small" aria-hidden>
                  {displayName(m)[0]?.toUpperCase()}
                </span>
                <span>
                  <button
                    type="button"
                    className="link member-table-link"
                    onClick={() => onShowMember(m.id)}
                    aria-label={`${displayName(m)}: show history`}
                  >
                    {displayName(m)}
                  </button>
                  <span className="muted member-table-seen">
                    {member?.disabled
                      ? "Suspended"
                      : member?.lastActive
                        ? `Active ${date(member.lastActive)}`
                        : "Not seen yet"}
                  </span>
                </span>
              </span>
              <span role="cell" className="member-table-stored">
                <span className="member-table-value">
                  {bytes(m.used)}
                  {limit !== null && <span className="muted"> of {bytes(limit)}</span>}
                </span>
                <span className="member-table-bar" aria-hidden>
                  <span style={{ width: `${Math.min(100, (m.used / (limit ?? most)) * 100)}%` }} />
                </span>
              </span>
              <span role="cell" data-label="Uploaded">
                {bytes(m.totals.uploaded + m.totals.received)}
              </span>
              <span role="cell" data-label="Downloaded">
                {bytes(m.totals.downloaded + m.totals.shared)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type HistoryFilter = { group: HistoryGroup | null; member: string | null };
const GROUPS: { value: HistoryGroup | "all"; label: string; short?: string }[] = [
  { value: "all", label: "Everything", short: "All" },
  { value: "people", label: "Members" },
  { value: "sharing", label: "Sending and sharing", short: "Sharing" },
  { value: "signin", label: "Sign-in problems", short: "Sign-in" },
  { value: "problems", label: "Problems" },
];
const PAGE = 50;

/** What happened, newest first, by day: filtered by kind and member, with older entries on request. */
function History({
  ref,
  members,
  filter,
  onFilter,
}: {
  ref?: React.Ref<HTMLElement>;
  members: Overview["members"];
  filter: HistoryFilter;
  onFilter: (filter: HistoryFilter) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  // A new filter starts from the newest page again.
  useEffect(() => setLimit(PAGE), [filter.group, filter.member]);
  const query = {
    limit,
    ...(filter.group ? { group: filter.group } : {}),
    ...(filter.member ? { member: filter.member } : {}),
  };
  const { data, error, reload, loading } = useLive(api.admin.history, { query }, ["history", "account"], null);
  const days = groupByDay(data?.entries ?? []);
  const known = members.some((m) => m.id === filter.member);
  return (
    <section ref={ref} className="settings-section card-surface admin-history" aria-labelledby="admin-history">
      <div className="settings-section-head">
        <h2 id="admin-history">History</h2>
        <p className="muted">The last 90 days. File names and contents are never recorded.</p>
      </div>
      <div className="admin-history-filters">
        <Segmented
          label="Show"
          value={filter.group ?? "all"}
          options={GROUPS}
          onChange={(group) => onFilter({ ...filter, group: group === "all" ? null : group })}
        />
        <label className="admin-history-member">
          <span className="visually-hidden">Member</span>
          <select
            className="input"
            value={known ? (filter.member ?? "") : ""}
            onChange={(event) => onFilter({ ...filter, member: event.target.value || null })}
          >
            <option value="">All members</option>
            {[...members]
              .sort((a, b) => displayName(a).localeCompare(displayName(b)))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {displayName(m)}
                </option>
              ))}
          </select>
        </label>
      </div>
      {error && data && <LoadFailed banner error={error} onRetry={reload} />}
      {error && !data ? (
        <LoadFailed title="History couldn’t be loaded" error={error} onRetry={reload} />
      ) : !data ? (
        <div className="admin-history-skeleton skeleton waiting" aria-hidden />
      ) : !data.entries.length ? (
        <p className="muted admin-history-empty">
          {filter.group || filter.member ? "Nothing like that has happened in the last 90 days." : "Nothing yet."}
        </p>
      ) : (
        <>
          {days.map(([day, entries]) => (
            <div className="admin-history-day" key={day}>
              <h3>{day}</h3>
              <ol className="admin-history-list">
                {entries.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} />
                ))}
              </ol>
            </div>
          ))}
          {data.more && limit < 500 && (
            <Button busy={loading && data.entries.length < limit} onClick={() => setLimit((n) => n + PAGE)}>
              Show older
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function groupByDay(entries: HistoryEntry[]): [string, HistoryEntry[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const days = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const day = new Date(entry.created).toDateString();
    const label = day === today ? "Today" : day === yesterday ? "Yesterday" : date(entry.created);
    days.set(label, [...(days.get(label) ?? []), entry]);
  }
  return [...days];
}

const ICONS: Record<HistoryGroup, React.ReactNode> = {
  people: <UserRound size={16} />,
  sharing: <Share2 size={16} />,
  signin: <KeyRound size={16} />,
  problems: <AlertTriangle size={16} />,
};

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const group = HISTORY_GROUP_OF[entry.kind];
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <li className={`admin-history-row is-${group}`}>
      <span className="admin-history-icon" aria-hidden>
        {ICONS[group]}
      </span>
      <span className="admin-history-text">{describe(entry)}</span>
      <span className="admin-history-time muted">
        {entry.count > 1 && `${entry.count} times · `}
        {time(entry.created)}
        {time(entry.last) !== time(entry.created) && `–${time(entry.last)}`}
      </span>
    </li>
  );
}

const files = (n: number, size: number) => `${plural(n, "file")} (${bytes(size)})`;

/** One sentence per event, in the words someone running Relay would use. */
function describe(e: HistoryEntry): string {
  switch (e.kind) {
    case "joined":
      return e.via === "setup"
        ? `${e.username} set up Relay`
        : e.via === "sso"
          ? `${e.username} joined with single sign-on`
          : `${e.username} joined${e.by ? ` with an invitation from ${e.by}` : ""}`;
    case "removed":
      return `${e.by} removed ${e.username}’s account, deleting ${plural(e.items, "item")} and freeing ${bytes(e.bytes)}`;
    case "suspended":
      return `${e.by} suspended ${e.username}`;
    case "restored":
      return `${e.by} let ${e.username} sign in again`;
    case "role":
      return e.admin
        ? `${e.by} made ${e.username} an administrator`
        : `${e.by} took ${e.username}’s administrator role away`;
    case "password":
      return e.by
        ? `${e.by} reset ${e.username}’s password`
        : `${e.username}’s password was reset with the recovery link from the server`;
    case "sent":
      return e.to === "device"
        ? `${e.username} sent ${files(e.files, e.bytes)} to ${e.device ?? "one of their devices"}`
        : e.to === "link"
          ? `${e.username} shared ${files(e.files, e.bytes)} as a link`
          : `${e.username} uploaded ${files(e.files, e.bytes)} to Files`;
    case "shared":
      return e.what === "link" ? `${e.username} made a shared link` : `${e.username} asked for files with a request`;
    case "received":
      return `Someone sent ${e.username} ${files(e.files, e.bytes)} through a request`;
    case "signin":
      return e.reason === "locked"
        ? `${e.username} was locked out for an hour after too many wrong passwords`
        : e.reason === "suspended"
          ? `${e.username} tried to sign in while suspended`
          : e.username
            ? `Wrong password for ${e.username}`
            : "Someone tried to sign in with a username that doesn’t exist";
    case "error":
      return `Something went wrong with ${e.area}. ${e.detail}`;
  }
}

/** Opens Server details and brings it into view, for "Check now" in the status card. */
function openServerDetails() {
  const details = document.querySelector<HTMLDetailsElement>("#admin-server-details");
  if (details) details.open = true;
  details?.scrollIntoView({ behavior: scrollMotion(), block: "start" });
}

/** How the server runs, for when something is wrong. Open by itself only then. */
function ServerDetails({ data }: { data: Overview }) {
  const { operations: o, storage } = data;
  // Opens by itself when something goes wrong or a check runs, but never folds away while being read.
  const attention = problems(data).length > 0 || data.integrity.running;
  const [open, setOpen] = useState(attention);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  return (
    <section className="settings-section card-surface" aria-labelledby="admin-server">
      <details
        id="admin-server-details"
        className="health-details"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>
          <Server size={16} aria-hidden />
          <span id="admin-server">Server details</span>
        </summary>
        <div className="stack">
          <IntegrityCheck integrity={data.integrity} />
          {data.integrity.affected.length > 0 && (
            <section aria-labelledby="admin-damaged">
              <h3 id="admin-damaged" className="field-label">
                Members with damaged files
              </h3>
              <ul className="list">
                {data.integrity.affected.map((m) => (
                  <li className="list-row" key={m.userId}>
                    <span>{m.username}</span>
                    <span className="muted">
                      {plural(m.files, "file")} in {plural(m.items, "item")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ul className="list" aria-label="Cleanup jobs">
            {o.maintenance.map((stage) => (
              <li className="list-row" key={stage.name}>
                <span className="list-text static">
                  <strong>{stage.name}</strong>
                  <span className="muted">
                    {stage.succeeded ? `Last ran ${dateTime(stage.succeeded)}` : "Hasn’t run successfully yet"}
                    {stage.failures > 0 ? ` · ${plural(stage.failures, "failure")} since startup` : ""}
                  </span>
                </span>
                <span className={`pill ${stage.failed ? "danger" : "success"}`}>{stage.failed ? "Failed" : "OK"}</span>
              </li>
            ))}
          </ul>
          <dl className="health-facts">
            <dt>Last hour</dt>
            <dd>
              {o.recent.failures
                ? `${plural(o.recent.failures, "server error")} out of ${o.recent.requests.toLocaleString()} things people did`
                : `No server errors in ${o.recent.requests.toLocaleString()} things people did`}
              {o.recent.limited > 0 && ` · ${plural(o.recent.limited, "attempt")} slowed down for coming too fast`}
            </dd>
            <dt>Stored content</dt>
            <dd>
              {bytes(storage.blobBytes)} on disk, with copies of the same file stored once · {bytes(storage.trashBytes)}{" "}
              in Trash. Excludes previews and the database.
            </dd>
            <dt>Disk</dt>
            <dd>
              {bytes(storage.diskFree)} free of {bytes(storage.diskTotal)}
            </dd>
            <dt>Process</dt>
            <dd>
              {bytes(o.memoryBytes)} memory · started {dateTime(o.started)}. Counts reset on restart.
            </dd>
            <dt>Version</dt>
            <dd>{buildLine(data.build)}</dd>
            <dt>Statistics</dt>
            <dd>
              {data.usageBuffer.pending
                ? `${plural(data.usageBuffer.pending, "change")} waiting to be saved`
                : "Up to date"}
              {data.usageBuffer.discarded > 0 &&
                ` · ${plural(data.usageBuffer.discarded, "change")} lost since startup`}
            </dd>
            <dt>Direct transfers</dt>
            <dd>{directTransfers(data.local)}</dd>
            <dt>Startup file check</dt>
            <dd>
              {dateTime(o.reconciliation.checked)} · {plural(o.reconciliation.removedOrphans, "leftover file")} removed
            </dd>
          </dl>
          <p className="field-hint">Updates every 30 seconds while this page is open.</p>
        </div>
      </details>
    </section>
  );
}

/** Which saved version of the code is running, so a deploy can be matched to its commit. */
function buildLine({ version, commit, committed }: Overview["build"]) {
  if (!commit) return `Relay ${version} · a development copy, not built from a saved commit`;
  const when = committed ? `, saved ${dateTime(Date.parse(committed))}` : "";
  return `Relay ${version} · commit ${commit.slice(0, 7)}${when}`;
}

function directTransfers(local: Overview["local"]) {
  if (local.state === "off") return "Off (RELAY_DIRECT). Everything goes over the internet.";
  if (local.state === "starting") return "Starting";
  if (local.state === "down")
    return `Unavailable${local.problem ? `: ${local.problem}` : ". Relay is starting them again."}`;
  return `On · ${plural(local.links, "browser")} connected`;
}

function IntegrityCheck({ integrity }: { integrity: Overview["integrity"] }) {
  const result = integrity.lastResult;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = async () => {
    setBusy(true);
    setError("");
    try {
      await call(api.admin.integrity, { body: result?.nextAfter ? { after: result.nextAfter } : {} });
      notifyChange("account");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const running = busy || integrity.running;
  return (
    <div className="setting-row">
      <span className="setting-label">
        <strong>File check</strong>
        <span className="field-hint">
          Reads every stored file to make sure it is still whole.{" "}
          {integrity.lastFullCheck
            ? `Last finished ${dateTime(integrity.lastFullCheck)}.`
            : "It hasn’t finished a full check yet."}{" "}
          A large library is checked in parts; continue until it finishes.
        </span>
        {running && (
          <span className="field-hint" role="status">
            Checking stored files… A large file can take a while.
          </span>
        )}
        {!running && result && (
          <span className="field-hint" role="status">
            Last part: {plural(result.checked, "file")} · {bytes(result.bytes)} read ·{" "}
            {plural(result.missing + result.corrupt + result.errors, "problem")}.{" "}
            {result.cancelled ? "Stopped." : result.complete ? "Finished." : "More files remain."}
          </span>
        )}
        {(error || integrity.lastError) && (
          <span className="field-error" role="alert">
            {error || "The file check couldn’t finish. Try again when the data drive is available."}
          </span>
        )}
      </span>
      <Button onClick={() => void check()} busy={running}>
        {result?.nextAfter ? "Continue file check" : "Check stored files"}
      </Button>
    </div>
  );
}
