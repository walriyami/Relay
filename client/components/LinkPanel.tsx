import { api, type Link } from "../api";
import { useLive } from "../lib/live";
import { shareUrl } from "../lib/format";
import { useExpiryClock } from "../lib/refresh";
import { ShareAccess } from "./ShareAccess";
import { linkSummary } from "./FileShareDialog";
import { LinkReach } from "./LinkOptions";

// A link just made from Send, in its transfer card: the same QR, code and copy hierarchy as
// everywhere else, with how it works and who has opened it so far.
export function LinkPanel({ share: made }: { share: Link }) {
  // Follows the link as it is opened or changed elsewhere; until the list has it, shows it as made.
  const { data } = useLive(api.links.list, {}, ["links"], []);
  const share = data.find((l) => l.id === made.id) ?? made;
  const now = useExpiryClock([share.expires ?? Infinity]);
  if (share.expires !== null && share.expires <= now)
    return (
      <p className="muted" role="status">
        This share has expired. Create a new link from Files to share this item again.
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
