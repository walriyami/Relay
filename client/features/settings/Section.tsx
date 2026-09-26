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
        <h2 id={id}>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
