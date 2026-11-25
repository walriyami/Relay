import type { ReactNode } from "react";
import { Brand } from "../app/Brand";
import { Icon } from "./icons";
import { shown } from "./UserText";

export type PublicWidth = "narrow" | "medium" | "wide";

/**
 * The one layout for everything someone sees outside the app: signing in, entering a code, opening
 * a shared link, uploading to a request, joining Nearby. The brand sits at the top left, lined up
 * with the card under it, and the card starts at the same height on every page.
 */
export function PublicFrame({
  children,
  width = "medium",
  busy,
}: {
  children: ReactNode;
  width?: PublicWidth;
  busy?: boolean;
}) {
  return (
    <div className="public" aria-busy={busy || undefined}>
      <header className={`public-head ${width}`}>
        <Brand />
      </header>
      <main className={`public-main ${width}`} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

/** A public page's card: its title and one line under it, then its content. */
export function PublicCard({
  title,
  subtitle,
  icon,
  children,
  className = "",
  titleId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <section className={`card-surface public-card ${className}`} aria-labelledby={titleId}>
      <div className="public-title">
        {icon && (
          <span className="public-icon" aria-hidden>
            {icon}
          </span>
        )}
        <h1 id={titleId}>{shown(title)}</h1>
        {subtitle && <p className="muted">{shown(subtitle)}</p>}
      </div>
      {children}
    </section>
  );
}

/** A link, request or code that no longer leads anywhere: what happened, and the way on. */
export function Unavailable({
  title,
  children,
  action,
  icon = <Icon.linkOff size={22} />,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <PublicCard title={title} subtitle={children} icon={icon}>
      {action}
    </PublicCard>
  );
}

/** Placeholders shaped like a public card, shown only once the wait is noticeable. */
export function PublicLoading() {
  return (
    <>
      <div className="card-surface public-card public-loading waiting" aria-hidden>
        <span className="skeleton skeleton-line short" />
        <span className="skeleton skeleton-line" />
        <span className="skeleton boot-field" />
      </div>
      <span className="visually-hidden" role="status">
        Loading
      </span>
    </>
  );
}
