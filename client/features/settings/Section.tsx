import type { ReactNode } from "react";
import { Icon } from "../../components/icons";

/**
 * One group of settings. Choices save as they're made; `saved` shows a quiet tick beside the
 * heading for a moment instead of a toast, and screen readers hear "Saved" once.
 */
export function Section({
  id,
  title,
  description,
  saved = false,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  saved?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-section card-surface" aria-labelledby={id}>
      <div className="settings-section-head">
        <div className="settings-section-title">
          {/* Focusable by script, so a jump from the side navigation continues from here. */}
          <h2 id={id} tabIndex={-1}>
            {title}
          </h2>
          <span className="saved-tick" role="status">
            {saved && (
              <>
                <Icon.done size={14} aria-hidden /> Saved
              </>
            )}
          </span>
        </div>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
