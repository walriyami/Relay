import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { bytes, plural } from "../../lib/format";
import { addShare, discardShare, leaveShare, readShare, type Incoming } from "../../lib/pwa-share";
import { Thumbnail } from "../../components/Thumbnail";
import { Button, toast } from "../../components/ui";
import { UserText } from "../../components/UserText";

// Relay opened from the share sheet (/share). What arrived is shown first, with Add and Discard:
// an outside website can open this address or submit the same form, so nothing reaches the Send
// draft until the person adds it. Either way the address then becomes Send's own, so a reload
// doesn't bring it back.

/** Rows shown before "and N more", so the buttons stay in reach on a phone. */
const ROWS = 5;
/**
 * Add works only after this long on screen, and isn't focused: a website that sends something here
 * can't have a held Enter or the second half of a double-click land on it.
 */
const SETTLE_MS = 500;

export function ShareIntake() {
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!incoming) return;
    heading.current?.focus({ preventScroll: true });
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [incoming]);
  useEffect(() => {
    let live = true;
    const read = () => {
      void readShare(location)
        .catch(() => "failed" as const)
        .then((result) => {
          if (!live) return;
          if (result && typeof result === "object") return setIncoming(result);
          leaveShare();
          if (result === "failed")
            toast("What you shared didn’t reach Relay. Share it again, or add it here.", { tone: "error" });
        });
    };
    read();
    // The Shortcut can open /share#text=… again while this screen is showing.
    window.addEventListener("hashchange", read);
    return () => {
      live = false;
      window.removeEventListener("hashchange", read);
    };
  }, []);

  if (!incoming)
    return (
      <div className="page" aria-busy="true">
        <p className="muted" role="status">
          Opening what was shared…
        </p>
      </div>
    );

  const { files, text } = incoming;
  const add = async () => {
    if (busy || !settled) return;
    setBusy(true);
    const result = await addShare(incoming).catch(() => "failed" as const);
    leaveShare();
    if (result === "failed") toast("This couldn’t be added. Share it again.", { tone: "error" });
    else if (result === "missing") toast("This was already added or discarded.", { key: "share-intake" });
    else {
      if (!result.files && result.text) window.dispatchEvent(new Event("relay-show-text"));
      if (result.files || result.text)
        toast(
          `${result.files ? plural(result.files, "file") : "Text"} added. Choose where ${result.files === 1 || !result.files ? "it goes" : "they go"}.`,
          { key: "share-intake" },
        );
    }
  };
  const discard = async () => {
    if (busy) return;
    setBusy(true);
    await discardShare(incoming);
    leaveShare();
    toast("Discarded. Nothing was added.", { key: "share-intake" });
  };

  return (
    <div className="page share-intake">
      <div className="page-head">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            Something was shared to Relay
          </h1>
          <p className="muted">Add it to Send, then choose where it goes. If you didn’t just share this, discard it.</p>
        </div>
      </div>
      <section className="stack-sm" aria-label="What was shared">
        {files.length > 0 && (
          <ul className="selection-list" aria-label="Shared files">
            {files.slice(0, ROWS).map((file, index) => (
              <li className="selection-row" key={index}>
                <Thumbnail compact file={file} entry={{ path: file.name, mime: file.type, size: file.size }} />
                <div className="selection-text">
                  <span className="selection-name" title={file.name}>
                    <UserText>{file.name || "Unnamed file"}</UserText>
                  </span>
                  <span className="muted">{bytes(file.size)}</span>
                </div>
              </li>
            ))}
            {files.length > ROWS && (
              <li className="selection-more muted">And {plural(files.length - ROWS, "more file")}</li>
            )}
          </ul>
        )}
        {text && (
          <div className="share-intake-text" aria-label="Shared text" role="group">
            <FileText size={16} aria-hidden />
            <p>{text}</p>
          </div>
        )}
      </section>
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!settled} onClick={() => void add()}>
          Add to Send
        </Button>
        <Button disabled={busy} onClick={() => void discard()}>
          Discard
        </Button>
      </div>
    </div>
  );
}
