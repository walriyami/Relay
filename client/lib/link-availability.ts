import type { Link } from "../api";

/** Content leaving Files ends access even when the link itself has no closing date. */
export const linkDeadline = (link: Link) =>
  Math.min(link.expires ?? Infinity, link.item?.expires ?? Infinity, link.item?.hardExpires ?? Infinity);

/** A shared availability rule for both the Send result and an item's share dialog. */
export function linkUnavailableReason(link: Link, now: number): string | null {
  if (link.revoked) return "This link was turned off.";
  if (linkDeadline(link) <= now) return "This link has expired.";
  if (!link.available || !link.item || link.item.trashed !== null)
    return "This link stopped working because its item left Files.";
  return null;
}
