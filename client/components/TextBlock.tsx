import { useState } from "react";
import { CopyButton, Button } from "./ui";

// Text is always shown inline and selectable, never as a file to download.
export function TextBlock({ text, label = "Text" }: { text: string; label?: string }) {
  const long = text.length > 1200 || text.split("\n").length > 16;
  const [open, setOpen] = useState(!long);
  return (
    <section className="text-block" aria-label={label}>
      <div className="text-block-head">
        <span className="eyebrow">{label}</span>
        <CopyButton value={text} size="sm" />
      </div>
      <pre className={`text-block-body ${open ? "" : "clamped"}`} tabIndex={0}>
        {text}
      </pre>
      {long && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </Button>
      )}
    </section>
  );
}
