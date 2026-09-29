import { useRef, useState } from "react";
import { Zap, ZapOff } from "lucide-react";
import { useLink } from "../../lib/local/link";
import { Popover, Toggle } from "../../components/ui";

/**
 * "Direct" in the top bar, shown while this browser is on Relay's own network: uploads and
 * downloads go straight to Relay rather than over the internet. It switches that off and on.
 */
export function DirectButton() {
  const { state, enabled, setEnabled } = useLink();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (state !== "ready") return null;
  const label = enabled ? "Direct transfers on" : "Direct transfers off";
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn btn-ghost btn-md direct-button ${enabled ? "on" : ""} ${open ? "active" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        {enabled ? <Zap size={18} aria-hidden /> : <ZapOff size={18} aria-hidden />}
        <span className="direct-button-label">Direct</span>
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Direct transfers" className="direct-popover">
          <div className="popover-head">
            <strong>Direct transfers</strong>
          </div>
          <div className="direct-body">
            <p className="muted">
              {enabled
                ? "This browser is on the same network as Relay, so uploads and downloads go straight to it instead of over the internet."
                : "This browser is on the same network as Relay, but uploads and downloads go over the internet while this is off."}
            </p>
            <Toggle checked={enabled} onChange={setEnabled} label="Transfer directly" />
          </div>
        </Popover>
      )}
    </>
  );
}
