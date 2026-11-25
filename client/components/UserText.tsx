import type { ReactNode } from "react";
import { shownText } from "../../shared/text";

/**
 * Words someone chose (a name, a note) or a file's name, shown next to Relay's own: set apart
 * (<bdi>), so whichever way its letters run, it can't reorder the text before or after it ("From
 * Sara · 3 files · Expires in 7 days"). Direction overrides stored before the server dropped them
 * are left out too.
 */
export function UserText({ children, className }: { children: string | null | undefined; className?: string }) {
  return <bdi className={className}>{shownText(children ?? "")}</bdi>;
}

/**
 * For places that show whatever text they're given (dialog titles, toasts, hints): a plain string
 * loses any direction override. Relay's own words have none, so only what people chose changes.
 */
export const shown = (node: ReactNode) => (typeof node === "string" ? shownText(node) : node);
