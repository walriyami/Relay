import { useEffect } from "react";
import { plural } from "../../lib/format";
import { leaveShare, receiveShare } from "../../lib/pwa-share";
import { toast } from "../../components/ui";
import { SendPage } from "./SendPage";

// Relay opened from the share sheet (/share): what was shared goes into the Send draft, then the
// address becomes Send's own so a reload doesn't add it twice.
let handled = "";

export function ShareIntake() {
  useEffect(() => {
    const at = location.href;
    if (handled === at) return;
    handled = at;
    void receiveShare(location)
      .catch(() => "failed" as const)
      .then((result) => {
        leaveShare();
        if (result === "failed")
          toast("What you shared didn’t reach Relay. Share it again, or add it here.", { tone: "error" });
        else if (result && typeof result === "object") {
          if (!result.files && result.text) window.dispatchEvent(new Event("relay-show-text"));
          if (result.files || result.text)
            toast(
              `${result.files ? plural(result.files, "file") : "Text"} added. Choose where ${result.files === 1 || !result.files ? "it goes" : "they go"}.`,
              { key: "share-intake" },
            );
        }
      });
  }, []);
  return <SendPage />;
}
