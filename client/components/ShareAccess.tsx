import type { ReactNode } from "react";
import { CopyButton, QrCode } from "./ui";
import { api } from "../api";
import { useLive } from "../lib/live";
import { useCodeConfig } from "../features/codes/config";
import { CodeProtectionNotice } from "../features/codes/CodeProtectionNotice";

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
  const { protection, codeLength } = useCodeConfig();
  // The registry retains retired codes as identifiers. Only the owner can refresh their handoff.
  const current = useLive(
    code ? api.pickup.current : null,
    code ? { body: { code } } : null,
    ["account", "links", "requests", "devices"],
    null,
  );
  const shownCode = current.error ? null : current.data ? current.data.code : code;
  return (
    <div className={`share-access${compact ? " share-access-compact" : ""}`}>
      <div className="share-access-qr">
        <QrCode value={url} size={192} label={`QR code for this ${purpose}`} />
      </div>
      <CopyButton
        value={url}
        label={copyLabel}
        // Beside the QR code it is the main thing to do, so it looks like a button, not a link.
        variant={compact ? "secondary" : "ghost"}
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
            <span className="muted">Code unavailable. Use the link or QR code.</span>
          )}
          {current.error && (
            <button className="link" type="button" onClick={current.reload}>
              Retry
            </button>
          )}
        </div>
      </div>
      <div className="share-access-detail">
        <CodeProtectionNotice protection={protection} effectiveCodeLength={codeLength} />
      </div>
      {detail && <div className="share-access-detail muted">{detail}</div>}
      {actions && <div className="share-access-actions">{actions}</div>}
    </div>
  );
}
