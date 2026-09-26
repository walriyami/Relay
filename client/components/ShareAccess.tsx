import type { ReactNode } from "react";
import { CopyButton, QrCode } from "./ui";
import { api } from "../api";
import { useLive } from "../lib/live";

/** The handoff people see after creating or opening any shareable address. */
export function ShareAccess({
  url,
  code,
  codeLabel = "Pickup code",
  purpose = "link",
  copyLabel = "Copy link",
  compact = false,
  detail,
  actions,
}: {
  url: string;
  code: string;
  codeLabel?: string;
  purpose?: string;
  copyLabel?: string;
  compact?: boolean;
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  // The registry retains retired codes as identifiers. Only the owner can refresh their handoff.
  const current = useLive(
    code ? api.pickup.current : null,
    code ? { body: { code } } : null,
    ["account", "links", "requests", "devices"],
    null,
  );
  const shownCode = current.error ? null : current.data ? current.data.code : code;
  if (!current.error && current.data?.code === null)
    return (
      <p className="muted" role="status">
        This handoff is no longer available. Close this dialog and refresh its source before sharing again.
      </p>
    );
  return (
    <div className={`share-access${compact ? " share-access-compact" : ""}`}>
      <div className="share-access-qr">
        <QrCode value={url} size={192} label={`QR code for this ${purpose}`} />
      </div>
      <CopyButton
        value={url}
        label={copyLabel}
        variant="ghost"
        className="share-access-copy"
        failureMessage="Couldn’t copy this link. Scan the QR code with another device."
        autofocus
      />
      <div className="share-access-code">
        <span className="share-access-code-label">{codeLabel}</span>
        <div className="share-access-code-value">
          {shownCode ? (
            <>
              <strong className="code">{shownCode}</strong>
              <CopyButton value={shownCode} label="Copy code" variant="ghost" size="sm" iconOnly />
            </>
          ) : (
            <span className="muted">{current.error ? "Code unavailable." : "This code no longer works."}</span>
          )}
          {current.error && (
            <button className="link" type="button" onClick={current.reload}>
              Retry
            </button>
          )}
        </div>
      </div>
      {detail && <div className="share-access-detail muted">{detail}</div>}
      {actions && <div className="share-access-actions">{actions}</div>}
    </div>
  );
}
