import type { Link } from "../api";
import { useLiveLink } from "../lib/live-link";
import { shareUrl } from "../lib/format";
import { useExpiryClock } from "../lib/refresh";
import { linkDeadline, linkUnavailableReason } from "../lib/link-availability";
import { ShareAccess } from "./ShareAccess";
import { linkSummary } from "./FileShareDialog";
import { LinkReach } from "./LinkOptions";

// A link just made from Send, in its transfer card: the same QR, code and copy hierarchy as
// everywhere else, with how it works and who has opened it so far.
export function LinkPanel({ share: made }: { share: Link }) {
  const { link: share, removed } = useLiveLink(made);
  const now = useExpiryClock([linkDeadline(share)]);
  const stopped = removed ? "This link is no longer available." : linkUnavailableReason(share, now);
  if (stopped)
    return (
      <p className="muted" role="status">
        {stopped}
      </p>
    );
  return (
    <ShareAccess
      url={shareUrl(share.token)}
      code={share.code}
      compact
      detail={
        <>
          <span>{linkSummary(share, now)}</span>
          <LinkReach link={share} />
        </>
      }
    />
  );
}
