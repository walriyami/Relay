// What is happening on this Relay: what it keeps against its total storage, what moved in and out
// over a period, who uses it, and how the server itself is doing.
import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileUp, HardDrive, Server } from "lucide-react";
import {
  api,
  call,
  displayName,
  type AdminOverview as Overview,
  type AdminUsageReport,
  type UsageRange,
} from "../../api";
import { bytes, dateTime, percent, plural } from "../../lib/format";
import { notifyChange, useLive } from "../../lib/live";
import { usePeriodicRefresh } from "../../lib/refresh";
import { scrollMotion } from "../../lib/router";
import { Button, LoadFailed, Spinner } from "../../components/ui";
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
  type Series,
} from "../usage/charts";

type Traffic = AdminUsageReport["traffic"][number];
const TRAFFIC: Series<Traffic>[] = [
  { key: "answered", label: "Answered", color: "var(--chart-2)", value: (t) => t.requests - t.failures },
  { key: "failures", label: "Server errors", color: "var(--danger)", value: (t) => t.failures },
];

export function AdminOverview({ data }: { data: Overview }) {
  const [range, setRange] = useState<UsageRange>("30d");
  const usage = useLive(api.admin.usage, { query: { range, tz: timeZoneOffset() } }, ["items", "account"], null);
  // Downloads and requests aren't announced live; catch up now and then.
  usePeriodicRefresh(usage.reload, 60_000);
  const report = usage.data;
  return (
    <>
      <div className="admin-range">
        <p className="muted">Over {rangeSpan(range)}</p>
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      {usage.error && report && <LoadFailed banner error={usage.error} onRetry={usage.reload} />}
      {usage.error && !report ? (
        <LoadFailed title="Statistics couldn’t be loaded" error={usage.error} onRetry={usage.reload} />
      ) : usage.loading || !report ? (
        <Spinner label="Loading statistics" />
      ) : (
        <Report data={data} report={report} range={range} />
      )}
      <ServiceHealth data={data} />
    </>
  );
}

function Report({ data, report, range }: { data: Overview; report: AdminUsageReport; range: UsageRange }) {
  const { storage, totals, previous, counts } = report;
  const used = storage.used + storage.reserved;
  const labels = periodLabels(
    report.buckets.map((b) => b.start),
    range,
  );
  const into = totals.uploaded + totals.received;
  const out = totals.downloaded + totals.shared;
  const requests = report.traffic.reduce((sum, t) => sum + t.requests, 0);
  const failures = report.traffic.reduce((sum, t) => sum + t.failures, 0);
  const unit = range === "12m" ? "month" : "day";
  return (
    <>
      <div className="stats" role="list" aria-label={`Over ${rangeSpan(range)}`}>
        <div role="listitem">
          <Stat
            icon={<HardDrive size={16} />}
            color="var(--chart-2)"
            label="Saved"
            value={bytes(storage.used)}
            detail={`${storage.reserved > 0 ? `${bytes(storage.reserved)} uploading · ` : ""}${percent(used, report.capacity)} of ${bytes(report.capacity)}${used > report.capacity ? " · Over limit" : ""}`}
          />
        </div>
        <div role="listitem">
          <Stat
            icon={<ArrowUpFromLine size={16} />}
            color="var(--chart-1)"
            label="Uploaded"
            value={bytes(into)}
            delta={<Delta now={into} before={previous.uploaded + previous.received} range={range} />}
            detail={totals.received ? `${bytes(totals.received)} through requests` : "by members"}
          />
        </div>
        <div role="listitem">
          <Stat
            icon={<ArrowDownToLine size={16} />}
            color="var(--chart-3)"
            label="Downloaded"
            value={bytes(out)}
            delta={<Delta now={out} before={previous.downloaded + previous.shared} range={range} />}
            detail={totals.shared ? `${bytes(totals.shared)} through links` : "by members"}
          />
        </div>
        <div role="listitem">
          <Stat
            icon={<FileUp size={16} />}
            color="var(--chart-4)"
            label="Files added"
            value={totals.files.toLocaleString()}
            delta={<Delta now={totals.files} before={previous.files} range={range} />}
            detail={`${plural(totals.downloads, "download")} through links`}
          />
        </div>
      </div>

      <section className="usage-card card-surface" aria-labelledby="admin-moved">
        <div className="usage-card-head">
          <h2 id="admin-moved">Data moved</h2>
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
      </section>

      <section className="usage-card card-surface" aria-labelledby="admin-storage">
        <div className="usage-card-head">
          <h2 id="admin-storage">Storage</h2>
          <p className="usage-headline">
            <strong>{bytes(used)}</strong>
            <span className="muted"> of {bytes(report.capacity)} used</span>
          </p>
        </div>
        <StorageBar segments={storageSegments(storage)} max={report.capacity} label="Storage on this Relay" />
        <dl className="usage-counts">
          <div>
            <dt>Free on disk</dt>
            <dd>
              {bytes(data.storage.diskFree)}
              <span className="muted"> of {bytes(data.storage.diskTotal)}</span>
            </dd>
          </div>
          <div>
            <dt>Uploading now</dt>
            <dd>{data.activity.activeUploads ? plural(data.activity.activeUploads, "upload") : "None"}</dd>
          </div>
          <div>
            <dt>Items in Files</dt>
            <dd>{counts.items.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>{counts.files.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Links working</dt>
            <dd>{counts.links.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Requests open</dt>
            <dd>{counts.requests.toLocaleString()}</dd>
          </div>
        </dl>
        {data.storage.diskFree < report.capacity - used && (
          <p className="field-hint">
            The disk has less free space than is left of the total storage, so uploads stop when the disk fills first.
          </p>
        )}
      </section>

      <div className="usage-pair">
        <section className="usage-card card-surface" aria-labelledby="admin-stored">
          <div className="usage-card-head">
            <h2 id="admin-stored">Storage over time</h2>
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
        </section>
        <section className="usage-card card-surface" aria-labelledby="admin-traffic">
          <div className="usage-card-head">
            <h2 id="admin-traffic">Requests served</h2>
            <p className="usage-headline">
              <strong>{requests.toLocaleString()}</strong>
              {failures > 0 && <span className="muted"> · {plural(failures, "server error")}</span>}
            </p>
          </div>
          <Chart
            kind="columns"
            title={`Requests the server answered each ${unit}`}
            buckets={report.traffic}
            labels={labels}
            series={TRAFFIC}
            unit="count"
            height={180}
            empty={`No requests in ${rangeSpan(range)}.`}
          />
        </section>
      </div>

      <MemberUsage report={report} range={range} />
    </>
  );
}

/** Each member's share: what they keep now, and what they moved over the range. */
function MemberUsage({ report, range }: { report: AdminUsageReport; range: UsageRange }) {
  const members = [...report.members].sort(
    (a, b) =>
      b.used - a.used ||
      b.totals.uploaded + b.totals.received - (a.totals.uploaded + a.totals.received) ||
      a.username.localeCompare(b.username),
  );
  const most = Math.max(...members.map((m) => m.used), 1);
  const total = Math.max(
    members.reduce((sum, m) => sum + m.used, 0),
    1,
  );
  return (
    <section className="usage-card card-surface" aria-labelledby="admin-member-usage">
      <div className="usage-card-head">
        <h2 id="admin-member-usage">By member</h2>
        <p className="muted">Stored now, and moved over {rangeSpan(range)}.</p>
      </div>
      <div className="member-table" role="table" aria-labelledby="admin-member-usage">
        <div className="member-table-row member-table-head" role="row">
          <span role="columnheader">Member</span>
          <span role="columnheader">Stored</span>
          <span role="columnheader">Uploaded</span>
          <span role="columnheader">Downloaded</span>
        </div>
        {members.map((m) => (
          <div className="member-table-row" role="row" key={m.id}>
            <span role="cell" className="member-table-name">
              <span className="avatar is-small" aria-hidden>
                {displayName(m)[0]?.toUpperCase()}
              </span>
              <span>
                <strong>{displayName(m)}</strong>
                {m.name && <span className="muted"> {m.username}</span>}
              </span>
            </span>
            <span role="cell" className="member-table-stored">
              <span className="member-table-value">
                {bytes(m.used)}
                <span className="muted"> · {percent(m.used, total)}</span>
              </span>
              <span className="member-table-bar" aria-hidden>
                <span style={{ width: `${(m.used / most) * 100}%` }} />
              </span>
            </span>
            <span role="cell" data-label="Uploaded">
              {bytes(m.totals.uploaded + m.totals.received)}
            </span>
            <span role="cell" data-label="Downloaded">
              {bytes(m.totals.downloaded + m.totals.shared)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** What needs the administrator, if anything; everything else about the service can wait below. */
function healthProblems({ operations: o, storage, integrity, usageBuffer, local }: Overview) {
  const stale = (stage: Overview["operations"]["maintenance"][number]) =>
    o.sampled - stage.attempted > Math.max(5 * 60_000, 3 * o.maintenanceIntervalMs);
  return [
    storage.diskFree < Math.min(1024 ** 3, storage.diskTotal * 0.05) &&
      "Disk space is low. Free space on the host before uploads fail.",
    integrity.missing + integrity.corrupt + integrity.errors > 0 &&
      `${plural(integrity.missing + integrity.corrupt + integrity.errors, "stored file")} unavailable or damaged. Check the data volume and restore affected files from a verified backup.`,
    integrity.lastError && "The last file check failed. Retry the check when storage is available.",
    usageBuffer.failed && "Usage statistics could not be saved. Buffered counts will retry when storage recovers.",
    usageBuffer.discarded > 0 &&
      "The usage buffer filled during a storage outage. Some reporting samples were lost; stored files and storage limits are unaffected.",
    o.maintenance.some((stage) => stage.failed) &&
      "Maintenance failed. Other cleanup jobs continue; failed jobs retry on the next sweep. Inspect server logs for the affected job.",
    o.maintenance.some(stale) &&
      "Maintenance has not run recently. Check the process and its configured sweep interval.",
    local.state === "down" &&
      `Direct transfers are unavailable${local.problem ? `: ${local.problem}` : "."} Uploads and downloads on Relay’s network go over the internet until Relay gets them running again.`,
  ].filter((problem): problem is string => !!problem);
}

/** Leads every Admin tab when the service needs a look, and points to the details. */
export function HealthNotice({ data, onShow }: { data: Overview; onShow: () => void }) {
  const problems = healthProblems(data);
  if (!problems.length) return null;
  return (
    <div className="notice health-notice" role="status">
      <strong>Relay needs attention</strong>
      <span>{problems.length === 1 ? problems[0] : `${problems.length} problems were found.`}</span>
      <a
        className="link"
        href="/admin#admin-health"
        onClick={(event) => {
          event.preventDefault();
          onShow();
        }}
      >
        See service health
      </a>
    </div>
  );
}

export const showHealth = () =>
  document.getElementById("admin-health")?.scrollIntoView({ behavior: scrollMotion(), block: "start" });

function ServiceHealth({ data }: { data: Overview }) {
  const { operations: o, storage } = data;
  const problems = healthProblems(data);
  const jobs = o.maintenance.length;
  return (
    <section className="settings-section card-surface" aria-labelledby="admin-health">
      <div className="settings-section-head health-head">
        <h2 id="admin-health">
          <Server size={18} aria-hidden /> Service health
        </h2>
        <span className={`pill ${problems.length ? "danger" : "success"}`}>
          {problems.length ? "Needs attention" : "No active alerts"}
        </span>
      </div>
      {problems.map((problem) => (
        <p key={problem} className="notice">
          {problem}
        </p>
      ))}
      {!problems.length && (
        <p className="muted">
          {jobs === 1 ? "The maintenance job is" : `All ${jobs} maintenance jobs are`} running on schedule. Last hour:{" "}
          {plural(o.recent.requests, "request")}, {plural(o.recent.failures, "server error")}.
        </p>
      )}
      <IntegrityCheck integrity={data.integrity} />
      {/* Open by itself when something failed, since then the detail is the point. */}
      <details className="health-details" open={problems.length > 0}>
        <summary>Details</summary>
        <ul className="list">
          {o.maintenance.map((stage) => (
            <li className="list-row" key={stage.name}>
              <span className="list-text static">
                <strong>{stage.name}</strong>
                <span className="muted">
                  {stage.succeeded ? `Last succeeded ${dateTime(stage.succeeded)}` : "No successful run yet"}
                  {stage.failures > 0 ? ` · ${plural(stage.failures, "failure")} since startup` : ""}
                </span>
              </span>
              <span className={`pill ${stage.failed ? "danger" : ""}`}>{stage.failed ? "Failed" : "OK"}</span>
            </li>
          ))}
        </ul>
        <dl className="health-facts">
          <dt>Last hour</dt>
          <dd>
            {plural(o.recent.requests, "request")} · {plural(o.recent.failures, "server error")} · {o.recent.limited}{" "}
            rate limited
          </dd>
          <dt>Stored content</dt>
          <dd>
            {bytes(storage.blobBytes)} unique · {bytes(storage.trashBytes)} in{" "}
            {plural(storage.trashItems, "trashed item")}. Excludes temporary files, previews and the database.
          </dd>
          <dt>Process</dt>
          <dd>
            {bytes(o.memoryBytes)} memory · started {dateTime(o.started)}. Counters reset on restart.
          </dd>
          <dt>Usage reporting</dt>
          <dd>
            {plural(data.usageBuffer.pending, "buffered row")} ·{" "}
            {plural(data.usageBuffer.discarded, "discarded sample")} since startup
          </dd>
          <dt>Direct transfers</dt>
          <dd>{directTransfers(data.local)}</dd>
          <dt>File check</dt>
          <dd>
            At startup {dateTime(o.reconciliation.checked)} · {plural(o.reconciliation.removedOrphans, "orphan file")}{" "}
            removed
          </dd>
        </dl>
        <p className="field-hint">Updates every 30 seconds while this page is visible.</p>
      </details>
    </section>
  );
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
  return (
    <div className="stack">
      <p className="muted">
        {integrity.lastFullCheck
          ? `Last full integrity check: ${dateTime(integrity.lastFullCheck)}.`
          : "No full integrity check has completed yet."}{" "}
        Check stored files against their original hashes. Large libraries are checked in batches; continue until the
        check finishes.
      </p>
      <Button onClick={() => void check()} busy={busy || integrity.running}>
        {result?.nextAfter ? "Continue file check" : "Check stored files"}
      </Button>
      {(busy || integrity.running) && <p role="status">Checking stored files… A large file may take longer.</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {integrity.lastError && !error && (
        <p role="alert" className="notice">
          The file check could not finish. Try again when storage is available.
        </p>
      )}
      {result && !busy && !integrity.running && (
        <p role="status" className="muted">
          Last batch: {plural(result.checked, "file")} · {bytes(result.bytes)} read ·{" "}
          {plural(result.missing + result.corrupt + result.errors, "problem")}.{" "}
          {result.cancelled ? "Check stopped." : result.complete ? "Check finished." : "More files remain."}
        </p>
      )}
    </div>
  );
}
