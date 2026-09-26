import { navigate } from "../lib/router";

const mark = (
  <>
    <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M8 11h14m-5-5 5 5-5 5M24 21H10m5 5-5-5 5-5"
        stroke="var(--brand-symbol)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    <span>Relay</span>
  </>
);

/** The brand always returns to Relay's home route, from public and private pages alike. */
export function Brand() {
  return (
    <a
      className="brand"
      href="/"
      aria-label="Relay home"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate("/");
      }}
    >
      {mark}
    </a>
  );
}
