// Adding a member's other devices: shared by first-start setup and a new member's welcome.
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Plus, Smartphone } from "lucide-react";
import { scrollMotion } from "../../lib/router";
import { Button } from "../../components/ui";
import { DeviceCode } from "../settings/AddDevice";
import { DevicesScene } from "./scenes";
import { StepTitle } from "./Walkthrough";

export function DevicesStep({ added, onAdded, onNext }: { added: number; onAdded: () => void; onNext: () => void }) {
  // Each new code is its own card; 0 means none was asked for yet.
  const [code, setCode] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  // A new code opens below the fold on most screens.
  useEffect(() => {
    if (code) card.current?.scrollIntoView({ behavior: scrollMotion(), block: "nearest" });
  }, [code]);
  // Once a device is in, the way on is the main thing to do.
  useEffect(() => {
    if (added) actions.current?.querySelector<HTMLElement>(".setup-cta")?.focus({ preventScroll: true });
  }, [added]);
  return (
    <>
      <DevicesScene />
      <StepTitle>Add your other devices</StepTitle>
      <p className="setup-lead">
        Relay is at its best on every device you use. Sign in on your phone or tablet, and what you send is waiting
        there.
      </p>
      {code > 0 && (
        <div className="setup-card card-surface setup-invite setup-device" key={code} ref={card}>
          <DeviceCode
            intro={
              <p className="setup-device-how">
                On your other device, scan the QR code, open the sign-in link, or enter the code under “Use a code” on
                Relay’s sign-in page.
              </p>
            }
            onAdded={onAdded}
            added={() => (
              <Button icon={<Plus size={16} />} onClick={() => setCode((n) => n + 1)}>
                Add another device
              </Button>
            )}
          />
        </div>
      )}
      <div className="setup-actions" ref={actions}>
        {added ? (
          <Button variant="primary" className="setup-cta" onClick={onNext}>
            Continue
            <ArrowRight size={16} aria-hidden />
          </Button>
        ) : code ? (
          <Button variant="ghost" onClick={onNext}>
            I’ll do this later
          </Button>
        ) : (
          <>
            <Button variant="primary" className="setup-cta" icon={<Smartphone size={16} />} onClick={() => setCode(1)}>
              Add a device
            </Button>
            <Button variant="ghost" onClick={onNext}>
              I’ll do this later
            </Button>
          </>
        )}
        <p className="setup-aside">You can add devices any time from Send or Settings.</p>
      </div>
    </>
  );
}
