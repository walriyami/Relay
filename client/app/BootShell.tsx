import { CardSkeletons } from "../components/CollectionCard";
import { ListSkeleton, SectionSkeleton } from "../components/ui";
import { Brand } from "./Brand";
import { NAV, isCurrent, sectionOf } from "./nav";

const KEY = "relay-signed-in";

/**
 * Remembers whether this browser was signed in when Relay last opened, so the next open can draw
 * the app around the page straight away instead of a blank screen. It is only a hint for the
 * loading screen: what the server says always decides what is shown.
 */
export function rememberSignedIn(signedIn: boolean) {
  try {
    if (signedIn) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the next open shows the plain loading screen.
  }
}
function wasSignedIn() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const TITLES: Record<string, string> = {
  "/files": "Files",
  "/trash": "Trash",
  "/links": "Links",
  "/requests": "Requests",
  "/settings": "Settings",
  "/usage": "Usage",
  "/admin": "Admin",
};

/** Placeholders shaped like the page that is loading. */
export function PageSkeleton({ section }: { section: string }) {
  const title = TITLES[section];
  return (
    <div className="page">
      {title && (
        <div className="page-head">
          <div>
            <h1>{title}</h1>
          </div>
        </div>
      )}
      {section === "/files" || section === "/trash" ? (
        <CardSkeletons count={6} />
      ) : section === "/links" || section === "/requests" ? (
        <ListSkeleton />
      ) : title ? (
        <SectionSkeleton />
      ) : (
        <div className="boot-box skeleton waiting" aria-hidden />
      )}
    </div>
  );
}

/**
 * What shows while Relay checks who is signed in. A browser that was signed in last time sees the
 * header, navigation and the page's placeholders, so the app is recognisable at once on a slow
 * connection; any other browser sees a quiet card where the sign-in or setup screen will appear.
 * Both ease in only once the wait is noticeable.
 */
export function BootShell({ route }: { route: string }) {
  const status = (
    <span className="visually-hidden" role="status">
      Opening Relay
    </span>
  );
  if (!wasSignedIn())
    return (
      <main className="public boot-public" tabIndex={-1} aria-busy="true">
        <header className="public-head narrow waiting">
          <Brand />
        </header>
        <div className="public-main narrow">
          <div className="card-surface public-card boot-card waiting" aria-hidden>
            <span className="skeleton skeleton-line short" />
            <span className="skeleton skeleton-line" />
            <span className="skeleton boot-field" />
            <span className="skeleton boot-field" />
          </div>
        </div>
        {status}
      </main>
    );
  const section = sectionOf(route);
  return (
    <div className="app boot-shell" aria-busy="true">
      <header className="topbar waiting">
        <div className="topbar-inner">
          <Brand />
          <nav className="nav" aria-label="Main">
            {NAV.map((item) => {
              const active = isCurrent(item.to, section);
              return (
                <span
                  key={item.to}
                  className={active ? "nav-link active" : "nav-link"}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </span>
              );
            })}
          </nav>
          <div className="topbar-actions" aria-hidden>
            <span className="skeleton boot-avatar" />
          </div>
        </div>
      </header>
      <main id="main" className="main waiting" tabIndex={-1}>
        <PageSkeleton section={section} />
      </main>
      {status}
    </div>
  );
}
