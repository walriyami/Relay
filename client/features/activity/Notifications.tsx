import { useState } from "react";
import { BellRing } from "lucide-react";
import { ApiError } from "../../api";
import { setLocalPrefs, useLocalPrefs } from "../../lib/local-prefs";
import {
  disablePush,
  enablePush,
  markPushOffered,
  pushOffered,
  pushState,
  sendTestPush,
  usePush,
} from "../../lib/push";
import { install, isIOS, isInstalled, useInstallOffer } from "../../lib/pwa";
import { Button, Toggle, toast } from "../../components/ui";

// Notifications on this device (Web Push, server/modules/push) and installing Relay as an app.

const HOME_SCREEN =
  "On iPhone and iPad, notifications only work in Relay added to the Home Screen: tap Share, then “Add to Home Screen”, and open Relay from there.";

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : "Notifications couldn’t be turned on.";

async function turnOn() {
  try {
    await enablePush();
    toast("Notifications are on for this device.", { tone: "success" });
    return true;
  } catch (error) {
    toast(message(error), { tone: "error" });
    return false;
  } finally {
    markPushOffered();
  }
}

/** Settings → Arrivals: notifications for this device, and Relay as an app. */
export function NotificationSettings() {
  const push = usePush();
  const local = useLocalPrefs();
  const [testing, setTesting] = useState(false);
  const blocked = push.permission === "denied";

  if (push.support !== "ready") {
    // No push here: an iPhone in Safari (install first), or a browser without it, which can still
    // show a notice while a Relay tab is open in the background.
    const tabNotices = push.support === "unsupported" && push.permission !== "unsupported";
    return (
      <>
        <Toggle
          label="Notifications"
          description={
            push.support === "install-first"
              ? HOME_SCREEN
              : tabNotices
                ? blocked
                  ? "Blocked by your browser. Allow notifications for this site, then reload."
                  : "This browser can only notify you while a Relay tab is open in the background."
                : "This browser doesn’t support notifications. Chrome, Edge, Firefox and Safari do."
          }
          disabled={!tabNotices || blocked}
          checked={tabNotices && local.system && push.permission === "granted"}
          onChange={async (v) => {
            if (!v) return setLocalPrefs({ system: false });
            const answer = push.permission === "granted" ? "granted" : await Notification.requestPermission();
            if (answer === "granted") setLocalPrefs({ system: true });
            else toast("Notifications weren’t allowed.", { tone: "error" });
          }}
        />
        <InstallRow />
      </>
    );
  }

  return (
    <>
      <Toggle
        label="Notifications on this device"
        description={
          blocked && !push.on
            ? "Blocked by your browser. Allow notifications for this site in its settings, then turn this on."
            : "When something arrives for this device, someone sends files to your request, or a link is first downloaded — even with Relay closed. The Activity choices above apply."
        }
        disabled={push.busy || !push.checked}
        checked={push.on}
        onChange={(v) =>
          void (v
            ? turnOn()
            : disablePush().catch(() => toast("Notifications couldn’t be turned off. Try again.", { tone: "error" })))
        }
      />
      {push.on && (
        <div className="setting-row">
          <span className="setting-label">
            <strong>Check it works</strong>
            <span className="field-hint">Sends a notification to this device.</span>
          </span>
          <Button
            size="sm"
            busy={testing}
            onClick={async () => {
              setTesting(true);
              try {
                const { sent } = await sendTestPush();
                if (!sent)
                  toast("The notification service didn’t take it. Turn notifications off and on, then try again.", {
                    tone: "error",
                  });
              } catch (error) {
                toast(message(error), { tone: "error" });
              } finally {
                setTesting(false);
              }
            }}
          >
            Send a test
          </Button>
        </div>
      )}
      <InstallRow />
    </>
  );
}

/** "Install Relay": where the browser offers it, or how to on an iPhone. Hidden once installed. */
function InstallRow() {
  const offer = useInstallOffer();
  if (isInstalled() || (!offer && !isIOS)) return null;
  return (
    <div className="setting-row">
      <span className="setting-label">
        <strong>Install Relay</strong>
        <span className="field-hint">
          {offer
            ? "Opens in its own window and appears in your share sheet as “Relay”."
            : "Tap Share, then “Add to Home Screen”. Relay then opens like an app and can notify you."}
        </span>
      </span>
      {offer && (
        <Button size="sm" onClick={() => void install()}>
          Install
        </Button>
      )}
    </div>
  );
}

/** Whether to offer notifications now: they'd work here, aren't on, and weren't offered before. */
export function canOfferPush() {
  const push = pushState();
  return push.support === "ready" && push.checked && !push.on && push.permission === "default" && !pushOffered();
}

/** The bell's one-time offer, above what happened. */
export function PushOffer() {
  const push = usePush();
  // Re-rendered by usePush when the offer is answered.
  if (!canOfferPush() && !push.busy) return null;
  return (
    <div className="push-offer">
      <BellRing size={18} aria-hidden />
      <p>
        <strong>Get notified on this device</strong>
        <span className="muted">When something arrives or someone sends you files, even with Relay closed.</span>
      </p>
      <span className="push-offer-actions">
        <Button size="sm" variant="ghost" disabled={push.busy} onClick={markPushOffered}>
          Not now
        </Button>
        <Button size="sm" variant="primary" busy={push.busy} onClick={() => void turnOn()}>
          Turn on
        </Button>
      </span>
    </div>
  );
}

/** After the first arrival this browser announced: a one-time nudge to hear about the next one. */
export function offerPushAfterArrival() {
  if (!canOfferPush()) return;
  markPushOffered();
  toast("Want a notification next time, even with Relay closed?", {
    key: "push-offer",
    action: { label: "Turn on", onClick: () => void turnOn() },
    timeout: 10_000,
  });
}
