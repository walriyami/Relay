import { useEffect, type ReactNode } from "react";
import { Share } from "lucide-react";
import { Button, CopyButton, QrCode, toast } from "./ui";
import { canShareLink, shareLink } from "../lib/pwa-share";
import { api } from "../api";
import { useLive } from "../lib/live";

/** The handoff people see after creating or opening any shareable address. */
export function ShareAccess({
  url,
  code,
  codeLabel = "Code",
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
  // A code works for a day after it's issued, so the owner's screen asks for the working one, and
  // asks again when it expires. Only the owner can see the replacement.
  const current = useLive(
    code ? api.pickup.current : null,
    code ? { body: { code } } : null,
    ["account", "links", "requests", "devices"],
    null,
  );
  const shownCode = current.error ? null : current.data ? current.data.code : code;
  const expires = current.data?.expires ?? null;
  const { reload } = current;
  useEffect(() => {
    if (expires === null) return;
    // At least a minute apart, so a device whose clock runs ahead doesn't ask over and over.
    const timer = setTimeout(reload, Math.max(60_000, expires - Date.now() + 1000));
    return () => clearTimeout(timer);
  }, [expires, reload]);
  return (
    <div className={`share-access${compact ? " share-access-compact" : ""}`}>
      <div className="share-access-qr">
        <QrCode value={url} size={192} label={`QR code for this ${purpose}`} />
      </div>
      {canShareLink() ? (
        // On a phone the share sheet reaches Messages, Mail and nearby devices; copying stays beside it.
        <div className="share-access-copy share-access-share">
          <Button
            variant="primary"
            icon={<Share size={16} />}
            data-autofocus
            onClick={() =>
              void shareLink(url).then(
                (shown) => shown || toast("Sharing isn’t available here. Copy the link instead."),
              )
            }
          >
            Share…
          </Button>
          <CopyButton
            value={url}
            label={copyLabel}
            variant="ghost"
            failureMessage="Couldn’t copy this link. Scan the QR code with another device."
          />
        </div>
      ) : (
        <CopyButton
          value={url}
          label={copyLabel}
          // Beside the QR code it is the main thing to do, so it looks like a button, not a link.
          variant={compact ? "secondary" : "ghost"}
          className="share-access-copy"
          failureMessage="Couldn’t copy this link. Scan the QR code with another device."
          autofocus
        />
      )}
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
      {detail && <div className="share-access-detail muted">{detail}</div>}
      {actions && <div className="share-access-actions">{actions}</div>}
    </div>
  );
}
