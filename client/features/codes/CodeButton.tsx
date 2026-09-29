import { useRef, useState } from "react";
import { RectangleEllipsis } from "lucide-react";
import type { PickupResolution } from "../../api";
import { navigate } from "../../lib/router";
import { Popover, toast } from "../../components/ui";
import { useActivity } from "../activity/ActivityProvider";
import { CodeEntryForm } from "./CodeEntry";

/**
 * "Enter code" in the top bar: any Relay code someone gave you. A link opens in the receive popup;
 * a request or invitation goes to its page.
 */
export function CodeButton() {
  const { open: openReceived } = useActivity();
  const [open, setOpenState] = useState(false);
  // Each opening of the popover is its own session; closing ends it.
  const session = useRef(0);
  const [opened, setOpened] = useState(0);
  const setOpen = (next: boolean) => {
    session.current++;
    if (next) setOpened(session.current);
    setOpenState(next);
  };
  const button = useRef<HTMLButtonElement>(null);
  // When a full code opens something on its own, an Enter pressed just after lands on this button;
  // it must not open the popover again.
  const handedBack = useRef(-Infinity);
  const goFrom = (from: number) => (destination: PickupResolution) => {
    // Dismissed (or closed and opened again) while the code was being looked up: that answer no
    // longer opens anything.
    if (from !== session.current) return;
    // Focus leaves the popover for its button before the popover goes, so it is never dropped: the
    // receive popup returns it there when closed, and a toast leaves it there. A new page focuses
    // its own main area.
    button.current?.focus({ preventScroll: true });
    handedBack.current = performance.now();
    setOpen(false);
    if (destination.kind === "share") openReceived({ token: destination.path.slice("/s/".length) });
    else if (destination.kind === "device")
      toast("This browser is already signed in. Sign out before using a sign-in code here.");
    else navigate(destination.path);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn btn-ghost btn-md code-button ${open ? "active" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Enter code"
        title="Enter a code"
        onClick={(event) => {
          if (!open && event.detail === 0 && performance.now() - handedBack.current < 600) return;
          setOpen(!open);
        }}
      >
        <RectangleEllipsis size={20} aria-hidden />
        <span className="code-button-label">Enter code</span>
      </button>
      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} label="Enter a code" className="code-popover">
          <div className="popover-head">
            <strong>Enter a code</strong>
          </div>
          <CodeEntryForm
            autoFocus
            onOpen={goFrom(opened)}
            fieldLabel="Code"
            description="Open a share, upload to a request, join someone’s Nearby, or accept an invitation."
          />
        </Popover>
      )}
    </>
  );
}
