// Charts for Usage and Admin, and the series both show. Each chart is drawn as SVG at the size it
// is shown, so text stays crisp and bars stay sharp; pointing at or arrowing through a chart reads out
// one day or month, and a hidden table gives screen readers the same numbers.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { StorageKind, UsageBucket, UsageRange, UsageReport } from "../../api";
import { bytes, plural } from "../../lib/format";
import { Segmented } from "../../components/ui";

/** Minutes east of UTC here, so days and months start at local midnight. */
export const timeZoneOffset = () => -new Date().getTimezoneOffset();

const RANGES: { value: UsageRange; label: string; short: string; span: string }[] = [
  { value: "7d", label: "7 days", short: "7 d", span: "the last 7 days" },
  { value: "30d", label: "30 days", short: "30 d", span: "the last 30 days" },
  { value: "90d", label: "90 days", short: "90 d", span: "the last 90 days" },
  { value: "12m", label: "12 months", short: "12 mo", span: "the last 12 months" },
];
/** "the last 30 days": what a range covers, in a sentence. */
export const rangeSpan = (range: UsageRange) => RANGES.find((r) => r.value === range)!.span;

export function RangeSwitch({ value, onChange }: { value: UsageRange; onChange: (range: UsageRange) => void }) {
  return (
    <Segmented
      label="Period"
      value={value}
      options={RANGES.map(({ value, label, short }) => ({ value, label, short }))}
      onChange={onChange}
    />
  );
}

export type Unit = "bytes" | "count";
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
/** A value as a sentence would say it. */
export const formatValue = (value: number, unit: Unit) => (unit === "bytes" ? bytes(value) : value.toLocaleString());
const axisValue = (value: number, unit: Unit) =>
  unit === "bytes" ? (value ? bytes(value) : "0") : compact.format(value);

/** Labels for each period: short under the axis, long in the readout. */
export function periodLabels(starts: number[], range: UsageRange) {
  const thisYear = new Date().getFullYear();
  return starts.map((start) => {
    const at = new Date(start);
    if (range === "12m")
      return {
        short: at.toLocaleDateString(undefined, { month: "short" }),
        long: at.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      };
    return {
      short: at.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      long: at.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: at.getFullYear() === thisYear ? undefined : "numeric",
      }),
    };
  });
}

/**
 * A round axis maximum at or above `max`, and the ticks up to it. Bytes step in binary units, so
 * the ticks read "2 GB" rather than "1.9 GB".
 */
export function niceAxis(max: number, unit: Unit, count = 4) {
  if (max <= 0) return { top: 1, ticks: [0] };
  const base = unit === "bytes" ? 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024))) : 1;
  const raw = max / base / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * magnitude >= raw) ?? 10) * magnitude;
  // Counts don't have halves.
  const size = unit === "count" ? Math.max(1, Math.ceil(step)) * base : step * base;
  const top = Math.ceil(max / size) * size;
  return { top, ticks: Array.from({ length: Math.round(top / size) + 1 }, (_, i) => i * size) };
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A column with rounded top corners. */
const column = (x: number, y: number, w: number, h: number, r: number) => {
  const c = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + c}Q${x},${y} ${x + c},${y}H${x + w - c}Q${x + w},${y} ${x + w},${y + c}V${y + h}Z`;
};

export type Series<B> = { key: string; label: string; color: string; value: (bucket: B) => number };

const MARGIN = { top: 12, right: 4, bottom: 26 };

/**
 * Columns (stacked when there is more than one series) or an area, one point per period.
 * `title` names the chart for assistive technology; the readout names each period.
 */
export function Chart<B>({
  kind,
  title,
  buckets,
  labels,
  series,
  unit,
  height = 200,
  empty,
}: {
  kind: "columns" | "area";
  title: string;
  buckets: B[];
  labels: { short: string; long: string }[];
  series: Series<B>[];
  unit: Unit;
  height?: number;
  /** Said in the chart while every value is zero. */
  empty: string;
}) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const totals = buckets.map((b) => series.reduce((sum, s) => sum + s.value(b), 0));
  const axis = niceAxis(Math.max(...totals, 0), unit);
  const left = Math.max(...axis.ticks.map((t) => axisValue(t, unit).length)) * 6.5 + 10;
  const plot = { w: Math.max(0, width - left - MARGIN.right), h: height - MARGIN.top - MARGIN.bottom };
  const n = buckets.length;
  const band = n ? plot.w / n : 0;
  const y = (value: number) => MARGIN.top + plot.h - (value / axis.top) * plot.h;
  const cx = (i: number) => left + band * (i + 0.5);
  // Enough room between labels for "Sep 30"; the last period is always labelled.
  const every = Math.max(1, Math.ceil((n * 64) / Math.max(plot.w, 1)));
  const nothing = totals.every((t) => t === 0);

  const pick = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    const i = Math.floor((clientX - rect.left - left) / band);
    setActive(i >= 0 && i < n ? i : null);
  };
  function onKeyDown(event: React.KeyboardEvent) {
    const from = active ?? n;
    const next: Record<string, number> = {
      ArrowLeft: Math.max(0, from - 1),
      ArrowRight: Math.min(n - 1, active === null ? n - 1 : from + 1),
      Home: 0,
      End: n - 1,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    setActive(next[event.key]);
  }

  let marks: ReactNode = null;
  if (width && !nothing) {
    if (kind === "columns") {
      const barW = Math.max(1, Math.min(band * 0.68, 26));
      marks = buckets.map((b, i) => {
        let base = 0;
        const parts = series.map((s) => ({ s, value: s.value(b) })).filter((p) => p.value > 0);
        return (
          <g key={i} className={active !== null && active !== i ? "chart-dim" : undefined}>
            {parts.map(({ s, value }, j) => {
              const top = y(base + value);
              const bottom = y(base);
              base += value;
              const x = cx(i) - barW / 2;
              // At least a hairline, so a small day never looks like nothing happened.
              const h = Math.max(bottom - top, 1);
              return j === parts.length - 1 ? (
                <path key={s.key} d={column(x, bottom - h, barW, h, 3)} fill={s.color} />
              ) : (
                <rect key={s.key} x={x} y={bottom - h} width={barW} height={h} fill={s.color} />
              );
            })}
          </g>
        );
      });
    } else {
      const s = series[0];
      const points = buckets.map((b, i) => [cx(i), y(s.value(b))] as const);
      const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
      const gradient = `${tableId}-fill`;
      marks = (
        <>
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <path d={`${line}L${points.at(-1)![0]},${y(0)}L${points[0][0]},${y(0)}Z`} fill={`url(#${gradient})`} />
          <path d={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {active !== null && (
            <circle
              cx={points[active][0]}
              cy={points[active][1]}
              r={4}
              fill="var(--surface)"
              stroke={s.color}
              strokeWidth={2}
            />
          )}
        </>
      );
    }
  }

  const readout = active === null ? null : buckets[active];
  const tipLeft = active === null ? 0 : Math.min(Math.max(cx(active), 90), Math.max(width - 90, 90));
  return (
    <figure className="chart">
      <div
        ref={box}
        className="chart-box"
        style={{ height }}
        tabIndex={nothing ? undefined : 0}
        role="group"
        aria-label={`${title}. Use the arrow keys to read each ${labels.length === 12 ? "month" : "day"}.`}
        aria-describedby={tableId}
        onPointerMove={(e) => !nothing && pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden>
            {axis.ticks.map((t) => (
              <g key={t}>
                <line
                  x1={left}
                  x2={width - MARGIN.right}
                  y1={Math.round(y(t)) + 0.5}
                  y2={Math.round(y(t)) + 0.5}
                  className={t ? "chart-grid" : "chart-baseline"}
                />
                {!nothing && (
                  <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">
                    {axisValue(t, unit)}
                  </text>
                )}
              </g>
            ))}
            {active !== null && (
              <rect x={left + band * active} y={MARGIN.top} width={band} height={plot.h} className="chart-hover" />
            )}
            {marks}
            {labels.map((label, i) =>
              (n - 1 - i) % every === 0 ? (
                <text key={i} x={cx(i)} y={height - 8} textAnchor="middle" className="chart-tick">
                  {label.short}
                </text>
              ) : null,
            )}
          </svg>
        )}
        {nothing && width > 0 && <p className="chart-empty">{empty}</p>}
        {readout !== null && active !== null && (
          <div className="chart-readout" style={{ left: tipLeft }} aria-live="polite">
            <strong>{labels[active].long}</strong>
            {series.map((s) => (
              <span key={s.key} className="chart-readout-row">
                <span className="chart-swatch" style={{ background: s.color }} aria-hidden />
                <span>{s.label}</span>
                <span className="chart-readout-value">{formatValue(s.value(readout), unit)}</span>
              </span>
            ))}
            {series.length > 1 && (
              <span className="chart-readout-row chart-readout-total">
                <span>Total</span>
                <span className="chart-readout-value">{formatValue(totals[active], unit)}</span>
              </span>
            )}
          </div>
        )}
      </div>
      {/* A table sizes to its content whatever its width, so the wrapper is what stays out of view. */}
      <div className="visually-hidden">
        <table id={tableId}>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              <tr key={i}>
                <th scope="row">{labels[i].long}</th>
                {series.map((s) => (
                  <td key={s.key}>{formatValue(s.value(b), unit)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** The key under a chart: each series with its total over the range. */
export function Legend({ items }: { items: { key: string; label: string; color: string; value?: string }[] }) {
  return (
    <ul className="chart-legend">
      {items.map((item) => (
        <li key={item.key}>
          <span className="chart-swatch" style={{ background: item.color }} aria-hidden />
          <span>{item.label}</span>
          {item.value !== undefined && <strong>{item.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

/** How a total compares with the same span just before: "↑ 24%", "New", or nothing to say. */
export function Delta({ now, before, range }: { now: number; before: number; range: UsageRange }) {
  if (now === 0 && before === 0) return null;
  const span = rangeSpan(range).replace("the last", "the previous");
  if (before === 0)
    return (
      <span className="delta is-new">
        New<span className="visually-hidden"> since {span}</span>
      </span>
    );
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return <span className="delta">Same as {span}</span>;
  const up = change > 0;
  return (
    <span className={`delta ${up ? "is-up" : "is-down"}`} title={`Compared with ${span}`}>
      {up ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownRight size={14} aria-hidden />}
      <span className="visually-hidden">{up ? "Up" : "Down"} </span>
      {Math.abs(change) > 999 ? ">999" : Math.abs(change)}%<span className="visually-hidden"> from {span}</span>
    </span>
  );
}

/** One figure over the range, with what it means and how it moved. */
export function Stat({
  icon,
  label,
  value,
  detail,
  delta,
  color,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: ReactNode;
  delta?: ReactNode;
  color?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">
        <span className="stat-icon" style={color ? { color } : undefined} aria-hidden>
          {icon}
        </span>
        {label}
      </span>
      <strong className="stat-value">{value}</strong>
      {(detail || delta) && (
        <span className="stat-detail">
          {delta}
          {detail && <span className="muted">{detail}</span>}
        </span>
      )}
    </div>
  );
}

export const KINDS: Record<StorageKind, { label: string; color: string }> = {
  images: { label: "Images", color: "var(--chart-1)" },
  videos: { label: "Videos", color: "var(--chart-2)" },
  documents: { label: "Documents", color: "var(--chart-3)" },
  archives: { label: "Archives", color: "var(--chart-4)" },
  audio: { label: "Audio", color: "var(--chart-5)" },
  other: { label: "Other", color: "var(--chart-6)" },
};

export type Segment = { key: string; label: string; bytes: number; color: string; detail?: string; pattern?: boolean };

/**
 * What storage holds, as one bar against the most it can hold, with a key underneath. Segments are
 * drawn in the order given; empty ones are left out of both.
 */
export function StorageBar({ segments, max, label }: { segments: Segment[]; max: number; label: string }) {
  const shown = segments.filter((s) => s.bytes > 0);
  const total = shown.reduce((sum, s) => sum + s.bytes, 0);
  const scale = Math.max(max, total, 1);
  return (
    <div className="storage-bar">
      <div
        className="storage-bar-track"
        role="img"
        aria-label={`${label}: ${bytes(total)} of ${bytes(max)}, ${shown.map((s) => `${s.label} ${bytes(s.bytes)}`).join(", ") || "nothing yet"}.`}
      >
        {shown.map((s) => (
          <span
            key={s.key}
            className={s.pattern ? "is-pattern" : undefined}
            style={{ width: `${Math.max((s.bytes / scale) * 100, 0.6)}%`, background: s.color, color: s.color }}
          />
        ))}
      </div>
      {shown.length > 0 && (
        <ul className="storage-bar-key">
          {shown.map((s) => (
            <li key={s.key}>
              <span
                className={`chart-swatch${s.pattern ? " is-pattern" : ""}`}
                style={{ background: s.color, color: s.color }}
                aria-hidden
              />
              <span className="storage-bar-name">{s.label}</span>
              <strong>{bytes(s.bytes)}</strong>
              {s.detail && <span className="muted">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Data in and out, in the colours every usage chart uses: warm coming in, cool going out. */
export type FlowKey = "uploaded" | "received" | "downloaded" | "shared";
export const FLOW: (Series<UsageBucket> & { key: FlowKey; hint: string })[] = [
  { key: "uploaded", label: "Uploaded", color: "var(--chart-1)", value: (b) => b.uploaded, hint: "from your devices" },
  { key: "received", label: "Received", color: "var(--chart-4)", value: (b) => b.received, hint: "through requests" },
  {
    key: "downloaded",
    label: "Downloaded",
    color: "var(--chart-2)",
    value: (b) => b.downloaded,
    hint: "to your devices",
  },
  { key: "shared", label: "Shared", color: "var(--chart-3)", value: (b) => b.shared, hint: "through your links" },
];
export const STORED: Series<UsageBucket> = {
  key: "stored",
  label: "Stored",
  color: "var(--chart-2)",
  value: (b) => b.stored,
};

/** What storage holds, by kind of file, then Trash and uploads still arriving. */
export function storageSegments(storage: UsageReport["storage"]): Segment[] {
  return [
    ...[...storage.kinds]
      .sort((a, b) => b.bytes - a.bytes)
      .map((k) => ({
        key: k.kind,
        label: KINDS[k.kind].label,
        bytes: k.bytes,
        color: KINDS[k.kind].color,
        detail: plural(k.files, "file"),
      })),
    { key: "trash", label: "Trash", bytes: storage.trash, color: "var(--muted)", pattern: true },
    { key: "uploading", label: "Uploading", bytes: storage.reserved, color: "var(--accent)", pattern: true },
  ];
}
