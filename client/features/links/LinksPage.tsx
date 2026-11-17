import { useEffect, useState } from "react";
import { api, call, urls, type Link } from "../../api";
import { ago, bytes, copyText, date, plural } from "../../lib/format";
import { notifyChange, useLive } from "../../lib/live";
import { useExpiryClock } from "../../lib/refresh";
import { navigate, takeModalAddress, useRoute } from "../../lib/router";
import {
  Button,
  Chip,
  EmptyState,
  InlineEmpty,
  ListSkeleton,
  LoadFailed,
  Menu,
  confirmDialog,
  toast,
} from "../../components/ui";
import { Icon } from "../../components/icons";
import { ItemThumb, StatusRow } from "../../components/StatusRow";
import { CollectionModal } from "../library/CollectionModal";
import { allFiles, composition, errorToast } from "../library/actions";
import { LinkSettingsDialog } from "../library/dialogs";
import { FileShareDialog } from "../../components/FileShareDialog";
import { linkLife, linkTraits } from "../../components/LinkOptions";

const OLD_PAGE = 50;
const linkUrl = (s: Link) => urls.shareLink(location.origin, s.token);

/** "Text", "3 files and text · 25 KB", "1 folder · 12 files · 3 MB". Text is never counted as a file. */
function describe({ item }: Link) {
  if (!item) return "";
  const inside = composition(item.topFiles, item.topFolders, item.texts);
  const parts = inside === "Empty" ? [] : [inside];
  if (item.topFolders) parts.push(allFiles(item.files, item.topFiles));
  if (item.files) parts.push(bytes(item.bytes));
  return parts.join(" · ");
}

const DAY = 86400000;

/** When it stops working, how it is limited, and whether it reached anyone: at a glance. */
function LiveChips({ link: s, now }: { link: Link; now: number }) {
  const soon = s.expires !== null && s.expires - now < DAY;
  return (
    <>
      <Chip tone={soon ? "warn" : "neutral"} icon={<Icon.time size={13} aria-hidden />}>
        {linkLife(s.expires, now)}
      </Chip>
      {linkTraits({ ...s, locked: false }).map((trait) => (
        <Chip key={trait}>{trait}</Chip>
      ))}
      {s.visitors ? (
        <Chip tone="good">
          Opened by {plural(s.visitors, "browser")}
          {s.lastVisit ? ` · ${ago(s.lastVisit, now)}` : ""}
        </Chip>
      ) : (
        <Chip>Not opened yet</Chip>
      )}
    </>
  );
}

/** Why a link stopped working (turned off, expired, or its item left Files), and whether it was used. */
function EndedChips({ link: s }: { link: Link }) {
  const reason = s.revoked
    ? "Turned off"
    : s.expires !== null && s.expires <= Date.now()
      ? `Expired ${date(s.expires)}`
      : s.item?.trashed
        ? "Item in Trash"
        : "Item no longer in Files";
  return (
    <>
      <Chip tone="off">{reason}</Chip>
      {s.visitors > 0 && <Chip>Opened by {plural(s.visitors, "browser")}</Chip>}
    </>
  );
}

export function LinksPage() {
  const { data, loading, error, reload } = useLive(api.links.list, {}, ["links", "items"], []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [oldShown, setOldShown] = useState(0);
  const now = useExpiryClock(data.flatMap((s) => [s.expires ?? Infinity, s.item?.expires ?? Infinity]));
  const available = (s: Link) =>
    s.available && (s.expires === null || s.expires > now) && (!s.item?.expires || s.item.expires > now);
  const active = data.filter(available);
  const inactive = data.filter((s) => !available(s));
  // /links/<id> (a reload, or an Activity entry) opens that link.
  const route = useRoute();
  useEffect(() => {
    const id = takeModalAddress("/links");
    if (id) setSharingId(id);
  }, [route]);
  const sharing = sharingId ? active.find((s) => s.id === sharingId) : undefined;
  // Follows the list, so settings open on what the link is now, and close if it stops working.
  const editing = editingId ? active.find((s) => s.id === editingId) : undefined;
  async function revoke(s: Link) {
    const ok = await confirmDialog({
      title: "Turn off this link?",
      body: "Anyone who has it will lose access right away. Downloads already started may finish. Your files stay in Files.",
      confirm: "Turn off link",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(api.links.revoke, { params: { id: s.id } });
      if (sharingId === s.id) setSharingId(null);
      notifyChange("links");
      notifyChange("items");
      toast("Link turned off");
    } catch (e) {
      errorToast(e);
    }
  }
  // A live row opens its link (QR, code, who opened it); a dead one its item, when there is one.
  const row = (s: Link, live: boolean) => (
    <StatusRow
      key={s.id}
      className="link-row-item"
      inactive={!live}
      media={<ItemThumb item={s.item} />}
      marker={
        s.locked ? <Icon.locked size={14} className="status-row-marker" role="img" aria-label="Has a password" /> : null
      }
      title={s.item?.name || "Deleted item"}
      chips={live ? <LiveChips link={s} now={now} /> : <EndedChips link={s} />}
      disabled={!live && !s.item}
      opensDialog
      onOpen={() => (live ? setSharingId(s.id) : s.item && setOpen(s.itemId))}
    >
      {live && (
        <Button size="sm" className="link-copy" onClick={() => setSharingId(s.id)}>
          Share
        </Button>
      )}
      <Menu
        label={`More actions for ${s.item?.name || "link"}`}
        items={[
          ...(live
            ? [
                {
                  label: "Copy link",
                  icon: <Icon.copy size={16} />,
                  onSelect: () =>
                    void copyText(linkUrl(s)).then((ok) =>
                      ok
                        ? toast("Link copied")
                        : toast("Couldn’t copy. Open the item and copy the link there.", { tone: "error" }),
                    ),
                },
                { label: "Link settings", icon: <Icon.options size={16} />, onSelect: () => setEditingId(s.id) },
              ]
            : []),
          ...(s.item ? [{ label: "Open item", icon: <Icon.open size={16} />, onSelect: () => setOpen(s.itemId) }] : []),
          ...(live
            ? [
                {
                  label: "Turn off link",
                  icon: <Icon.linkOff size={16} />,
                  danger: true,
                  separator: true,
                  onSelect: () => void revoke(s),
                },
              ]
            : []),
        ]}
      />
    </StatusRow>
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Links</h1>
          <p className="muted">Anyone with a link or its code can open it until it expires or you turn it off.</p>
        </div>
      </div>
      {error && data.length > 0 && <LoadFailed banner error={error} onRetry={reload} />}
      {error && !data.length ? (
        <LoadFailed title="Links couldn’t be loaded" error={error} onRetry={reload} />
      ) : loading && !data.length ? (
        <ListSkeleton />
      ) : !active.length && !inactive.length ? (
        <EmptyState
          icon={<Icon.link size={28} />}
          title="No links yet"
          action={
            <Button variant="primary" onClick={() => navigate("/")}>
              Go to Send
            </Button>
          }
        >
          Create a link from Send, or share an item you already saved in Files.
        </EmptyState>
      ) : (
        <>
          {active.length ? (
            <ul className="list card-surface" aria-label="Active links">
              {active.map((s) => row(s, true))}
            </ul>
          ) : (
            <InlineEmpty
              icon={<Icon.link size={20} />}
              title="No active links"
              action={
                <Button size="sm" onClick={() => navigate("/")}>
                  Go to Send
                </Button>
              }
            >
              Create a link from Send, or share an item in Files.
            </InlineEmpty>
          )}
          {inactive.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Expired or turned off</h2>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOldShown(oldShown ? 0 : OLD_PAGE)}
                  aria-expanded={oldShown > 0}
                >
                  {oldShown ? "Hide" : `Show ${inactive.length.toLocaleString()}`}
                </Button>
              </div>
              {oldShown > 0 && (
                <>
                  <ul className="list card-surface" aria-label="Expired links">
                    {inactive.slice(0, oldShown).map((s) => row(s, false))}
                  </ul>
                  {inactive.length > oldShown && (
                    <div className="list-more">
                      <span className="muted">
                        Showing {oldShown.toLocaleString()} of {inactive.length.toLocaleString()}
                      </span>
                      <Button onClick={() => setOldShown(oldShown + OLD_PAGE)}>Show more</Button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      {editing && <LinkSettingsDialog share={editing} onClose={() => setEditingId(null)} />}
      {sharing && (
        <FileShareDialog
          share={sharing}
          subtitle={describe(sharing)}
          onClose={() => setSharingId(null)}
          onSettings={() => setEditingId(sharing.id)}
          onRevoke={() => void revoke(sharing)}
        />
      )}
      {open && <CollectionModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
