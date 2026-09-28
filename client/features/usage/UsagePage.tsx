// A member's own usage: what they keep, what moved in and out over a period, and how their links
// and requests were used. Everything here is theirs; Admin has the same for the whole server.
import { useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileUp, Inbox, Link2, Share2, Users } from "lucide-react";
import { api, type UsageRange, type UsageReport } from "../../api";
import { useSession } from "../../app/session";
import { bytes } from "../../lib/format";
import { useLive } from "../../lib/live";
import { usePeriodicRefresh } from "../../lib/refresh";
import { LoadFailed, PageLink, Spinner } from "../../components/ui";
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
  type FlowKey,
} from "./charts";

export function UsagePage() {
  const { me } = useSession();
  const [range, setRange] = useState<UsageRange>("30d");
  const { data, loading, error, reload } = useLive(
    api.usage,
    { query: { range, tz: timeZoneOffset() } },
    ["items", "links", "requests", "account"],
    null,
  );
  // Downloads through links change nothing a member is told about live; catch up now and then.
  usePeriodicRefresh(reload, 60_000);
  return (
    <div className="page usage">
      <div className="page-head">
        <div>
          <h1>Usage</h1>
          <p className="muted">What you keep in Relay, and what moved in and out over {rangeSpan(range)}.</p>
        </div>
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      {error && data && <LoadFailed banner error={error} onRetry={reload} />}
      {error && !data ? (
        <LoadFailed title="Usage couldn’t be loaded" error={error} onRetry={reload} />
      ) : loading || !data ? (
        <Spinner label="Loading usage" />
      ) : (
        <Report report={data} range={range} admin={me.user.admin} />
      )}
    </div>
  );
}

function Report({ report, range, admin }: { report: UsageReport; range: UsageRange; admin: boolean }) {
  const { storage, totals, previous, counts } = report;
  const used = storage.used + storage.reserved;
  const max = report.limit ?? used + report.available;
  const labels = periodLabels(
    report.buckets.map((b) => b.start),
    range,
  );
  const biggest = report.largest[0]?.bytes ?? 0;
  const moved = FLOW.reduce((sum, s) => sum + totals[s.key], 0);
  return (
    <>
      <section className="usage-card card-surface usage-storage" aria-labelledby="usage-storage">
        <div className="usage-card-head">
          <h2 id="usage-storage">Storage</h2>
          <p className="usage-headline">
            <strong>{bytes(used)}</strong>
            <span className="muted">
              {report.limit === null ? ` used · ${bytes(report.available)} free` : ` of ${bytes(report.limit)} used`}
            </span>
          </p>
        </div>
        <StorageBar segments={storageSegments(storage)} max={max} label="Your storage" />
        <p className="field-hint">
          {report.limit === null
            ? `You have no storage limit of your own; the ${bytes(report.available)} free is shared with everyone on this Relay.`
            : `${bytes(report.available) === bytes(report.limit) && used > 0 ? "Almost all" : bytes(report.available)} left of your ${bytes(report.limit)}. ${admin ? "" : "Your administrator can give you more."}`}{" "}
          {storage.trash > 0 && (
            <>
              Trash still counts until it’s emptied. <PageLink to="/trash">Open Trash</PageLink>
            </>
          )}
        </p>
        <div className="usage-storage-foot">
          <dl className="usage-counts">
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
          {report.largest.length > 0 && (
            <div className="usage-largest">
              <h3>Largest in Files</h3>
              <ol>
                {report.largest.map((item) => (
                  <li key={item.id}>
                    <PageLink to={`/files/${item.id}`} className="usage-largest-link">
                      <span className="usage-largest-name">{item.name}</span>
                      <span className="usage-largest-size">{bytes(item.bytes)}</span>
                      <span className="usage-largest-bar" aria-hidden>
                        <span style={{ width: `${(item.bytes / biggest) * 100}%` }} />
                      </span>
                    </PageLink>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </section>

      <div className="stats" role="list" aria-label={`Over ${rangeSpan(range)}`}>
        {FLOW.map((s) => (
          <div role="listitem" key={s.key}>
            <Stat
              icon={FLOW_ICONS[s.key]}
              color={s.color}
              label={s.label}
              value={bytes(totals[s.key])}
              delta={<Delta now={totals[s.key]} before={previous[s.key]} range={range} />}
              detail={s.hint}
            />
          </div>
        ))}
      </div>

      <section className="usage-card card-surface" aria-labelledby="usage-moved">
        <div className="usage-card-head">
          <h2 id="usage-moved">Data moved</h2>
          <p className="usage-headline">
            <strong>{bytes(moved)}</strong>
            <span className="muted"> in and out</span>
          </p>
        </div>
        <Legend items={FLOW.map((s) => ({ ...s, value: bytes(totals[s.key]) }))} />
        <Chart
          kind="columns"
          title={`Data moved each ${range === "12m" ? "month" : "day"}`}
          buckets={report.buckets}
          labels={labels}
          series={FLOW}
          unit="bytes"
          empty={`Nothing moved in ${rangeSpan(range)}.`}
        />
      </section>

      <div className="usage-pair">
        <section className="usage-card card-surface" aria-labelledby="usage-stored">
          <div className="usage-card-head">
            <h2 id="usage-stored">Storage over time</h2>
          </div>
          <Chart
            kind="area"
            title="What you kept at the end of each period"
            buckets={report.buckets}
            labels={labels}
            series={[STORED]}
            unit="bytes"
            height={180}
            empty="Nothing kept yet."
          />
        </section>
        <section className="usage-card card-surface" aria-labelledby="usage-reach">
          <div className="usage-card-head">
            <h2 id="usage-reach">Sharing</h2>
          </div>
          <div className="stats is-compact">
            <Stat
              icon={<FileUp size={16} />}
              label="Files added"
              value={totals.files.toLocaleString()}
              delta={<Delta now={totals.files} before={previous.files} range={range} />}
            />
            <Stat
              icon={<Users size={16} />}
              label="People who opened your links"
              value={totals.visitors.toLocaleString()}
              delta={<Delta now={totals.visitors} before={previous.visitors} range={range} />}
            />
            <Stat
              icon={<Link2 size={16} />}
              label="Downloads through your links"
              value={totals.downloads.toLocaleString()}
              delta={<Delta now={totals.downloads} before={previous.downloads} range={range} />}
            />
          </div>
        </section>
      </div>
    </>
  );
}

export const FLOW_ICONS: Record<FlowKey, ReactNode> = {
  uploaded: <ArrowUpFromLine size={16} />,
  received: <Inbox size={16} />,
  downloaded: <ArrowDownToLine size={16} />,
  shared: <Share2 size={16} />,
};
