import type { ReactNode } from "react";

export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section card-surface" aria-labelledby={id}>
      <div className="settings-section-head">
        {/* Focusable by script, so a jump from the side navigation continues from here. */}
        <h2 id={id} tabIndex={-1}>
          {title}
        </h2>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
