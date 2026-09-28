// Small drawings that move, in the page's own colours, for the walkthroughs' welcoming steps.
import type { CSSProperties } from "react";

/** A file travelling from a laptop to a phone, over and over. */
export function RelayScene() {
  return (
    <svg className="setup-scene scene-relay" viewBox="0 0 320 140" aria-hidden>
      <path className="scene-arc" d="M118 64 Q177 4 236 64" />
      <g className="scene-device">
        <rect x="22" y="38" width="92" height="60" rx="7" />
        <path d="M10 104h116l-6 8H16z" />
        <rect className="scene-line" x="34" y="52" width="40" height="5" rx="2.5" />
        <rect className="scene-line" x="34" y="63" width="62" height="5" rx="2.5" />
        <rect className="scene-line" x="34" y="74" width="28" height="5" rx="2.5" />
      </g>
      <g className="scene-device scene-phone">
        <rect x="238" y="30" width="50" height="86" rx="10" />
        <rect className="scene-line" x="256" y="37" width="14" height="3" rx="1.5" />
        <rect className="scene-landed" x="248" y="52" width="30" height="36" rx="5" />
        <path className="scene-landed-check" d="M256 70l5 5 9-10" />
      </g>
      <circle className="scene-ping" cx="263" cy="70" r="30" />
      <g className="scene-file-x">
        <g className="scene-file-y">
          <g className="scene-file">
            <path d="M-9-12h11l7 7v17a2 2 0 0 1-2 2H-9a2 2 0 0 1-2-2v-22a2 2 0 0 1 2-2z" />
            <path className="scene-file-fold" d="M2-12v7h7" />
          </g>
        </g>
      </g>
    </svg>
  );
}

const PEOPLE = [
  { x: 58, y: 48, tint: "a" },
  { x: 46, y: 116, tint: "b" },
  { x: 262, y: 40, tint: "c" },
  { x: 274, y: 110, tint: "a" },
  { x: 160, y: 142, tint: "c" },
];

/** People appearing around Relay, joined to it one by one. */
export function PeopleScene() {
  return (
    <svg className="setup-scene scene-people" viewBox="0 0 320 168" aria-hidden>
      {PEOPLE.map((p, i) => (
        <line
          key={`l${i}`}
          className="scene-tie"
          x1="160"
          y1="78"
          x2={p.x}
          y2={p.y}
          style={{ "--i": i } as CSSProperties}
        />
      ))}
      <circle className="scene-ping" cx="160" cy="78" r="30" />
      <g className="scene-hub">
        <rect x="136" y="54" width="48" height="48" rx="12" />
        <path d="M148 70h20m-6-6 6 6-6 6M172 86h-20m6 6-6-6 6-6" />
      </g>
      {PEOPLE.map((p, i) => (
        <g key={`p${i}`} className="scene-person-at" transform={`translate(${p.x} ${p.y})`}>
          <g className={`scene-person tint-${p.tint}`} style={{ "--i": i } as CSSProperties}>
            <circle r="17" />
            <circle className="scene-person-glyph" cy="-4" r="5" />
            <path className="scene-person-glyph" d="M-8 9a8 7 0 0 1 16 0z" />
          </g>
        </g>
      ))}
    </svg>
  );
}

// A QR code's three corner squares and a scatter of modules, 4 units each, on the laptop's screen.
const QR_FINDERS = [
  [77, 46],
  [101, 46],
  [77, 70],
];
const QR_MODULES = [
  [91, 46],
  [95, 51],
  [91, 56],
  [78, 61],
  [86, 61],
  [96, 61],
  [104, 62],
  [108, 57],
  [92, 66],
  [100, 68],
  [108, 70],
  [92, 74],
  [98, 77],
  [106, 77],
];

/** A phone scanning the code on a laptop, then signed in, over and over. */
export function DevicesScene() {
  return (
    <svg className="setup-scene scene-devices" viewBox="0 0 320 140" aria-hidden>
      <path className="scene-arc" d="M156 58 Q192 28 226 50" />
      <g className="scene-device">
        <rect x="40" y="28" width="108" height="70" rx="7" />
        <path d="M28 104h132l-6 8H34z" />
      </g>
      <g className="scene-qr">
        {QR_FINDERS.map(([x, y]) => (
          <g key={`${x},${y}`}>
            <rect className="scene-qr-finder" x={x} y={y} width="10" height="10" rx="1.5" />
            <rect x={x + 3} y={y + 3} width="4" height="4" rx="0.5" />
          </g>
        ))}
        {QR_MODULES.map(([x, y]) => (
          <rect key={`${x},${y}`} x={x} y={y} width="4" height="4" rx="0.5" />
        ))}
      </g>
      <g className="scene-arrive">
        <g className="scene-device">
          <rect x="232" y="26" width="52" height="90" rx="10" />
          <rect className="scene-line" x="251" y="33" width="14" height="3" rx="1.5" />
        </g>
        <path className="scene-finder" d="M244 57v-6h6M266 51h6v6M272 73v6h-6M250 79h-6v-6" />
        <rect className="scene-scan" x="246" y="52" width="24" height="2.5" rx="1.25" />
        <circle className="scene-joined" cx="258" cy="65" r="14" />
        <path className="scene-joined-check" d="M251 65l5 5 9-10" />
      </g>
      <circle className="scene-ping" cx="258" cy="65" r="30" />
    </svg>
  );
}

/** A check drawn once, with a small burst around it. */
export function DoneScene() {
  return (
    <svg className="setup-scene scene-done" viewBox="0 0 160 120" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <circle
          key={i}
          className="scene-spark"
          cx="80"
          cy="60"
          r={i % 2 ? 2.5 : 3.5}
          style={{ "--a": `${i * 36}deg` } as CSSProperties}
        />
      ))}
      <circle className="scene-done-ring" cx="80" cy="60" r="32" />
      <path className="scene-done-check" d="M66 61l10 10 19-21" />
    </svg>
  );
}
