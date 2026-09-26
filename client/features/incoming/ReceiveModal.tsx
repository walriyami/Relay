import { useMemo, useState } from "react";
import { Check, Download, FolderOpen, X } from "lucide-react";
import { api, type Delivery } from "../../api";
import { useLive } from "../../lib/live";
import { navigate } from "../../lib/router";
import { ownerSource, shareSource } from "../../lib/source";
import { ContentView, downloadContents, isSingleFile } from "../../components/ContentView";
import { Button, LoadFailed, Modal, Spinner, useCloseModal } from "../../components/ui";
import { downloadLabel, errorToast, hasDownloads, singleFile } from "../library/actions";
import { itemAddress } from "../library/CollectionModal";
import { acceptDelivery, declineDelivery } from "./answer";
import { ShareNote, ShareUnlock, contentSummary, downloadAllLabel, shareSummary, useShare } from "./ReceiveView";

export type Received = { token: string } | { delivery: Delivery };

// What arrives opens here, inside the app, never in a new tab: an item sent from another device,
// or a link opened with a pickup code.
export function ReceiveModal({ received, onClose }: { received: Received; onClose: () => void }) {
  return "token" in received ? (
    <PickedUp token={received.token} onClose={onClose} />
  ) : (
    <Delivered delivery={received.delivery} onClose={onClose} />
  );
}

function PickedUp({ token, onClose }: { token: string; onClose: () => void }) {
  const { data, locked, error, canRetry, retry, unlock } = useShare(token);
  const source = useMemo(() => shareSource(token), [token]);
  const single = !!data && isSingleFile(data.nodes);
  return (
    <Modal
      // A dead link is one sentence: a small dialog, not an empty item window.
      size={error || locked ? "sm" : "xl"}
      className={error || locked ? "" : `item-window${single ? " is-single" : ""}`}
      title={data?.name || (error ? "Link unavailable" : locked ? "Enter the password" : "Opening…")}
      subtitle={data ? shareSummary(data) : undefined}
      onClose={onClose}
      footer={
        error ? (
          <>
            {canRetry && <Button onClick={retry}>Retry</Button>}
            <DoneButton />
          </>
        ) : data && data.nodes.some((n) => n.kind !== "text") ? (
          <Button
            variant="primary"
            icon={<Download size={16} />}
            onClick={() => downloadContents(source, data.nodes, "")}
          >
            {downloadAllLabel(data.nodes)}
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <p className="notice" role={canRetry ? "alert" : "status"}>
          {error}
        </p>
      ) : locked ? (
        <ShareUnlock locked={locked} onUnlock={unlock} />
      ) : data ? (
        <>
          <ShareNote share={data} />
          <ContentView nodes={data.nodes} source={source} itemId="" fill={single} />
        </>
      ) : (
        <Spinner />
      )}
    </Modal>
  );
}

// A delivery is the owner's own item sent from another device, so it opens with owner access. It is
// in Files already; accepting downloads it here, declining just answers it.
function Delivered({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const {
    data: cached,
    loading,
    error,
    errorStatus,
    reload,
  } = useLive(api.items.get, { params: { id: delivery.itemId } }, ["items"], null);
  const gone =
    !delivery.available || !!cached?.trashed || (errorStatus !== null && [401, 403, 404, 410].includes(errorStatus));
  const data = gone ? null : cached;
  const single = !!data && isSingleFile(data.nodes);
  const from = delivery.from ? `From ${delivery.from.name}` : "";
  return (
    <Modal
      size={gone ? "sm" : "xl"}
      className={gone ? "" : `item-window${single ? " is-single" : ""}`}
      title={data?.name || delivery.item?.name || "Received"}
      subtitle={[from, data ? contentSummary(data) : ""].filter(Boolean).join(" · ") || undefined}
      onClose={onClose}
      footer={gone ? <DoneButton /> : data ? <DeliveryFooter delivery={delivery} /> : undefined}
    >
      {error && !gone && data && <LoadFailed error={error} onRetry={reload} banner />}
      {data ? (
        <ContentView key={data.id} nodes={data.nodes} source={ownerSource} itemId={data.id} fill={single} />
      ) : gone ? (
        <p className="notice" role="status">
          This item is no longer available.
        </p>
      ) : loading ? (
        <Spinner />
      ) : (
        <LoadFailed error={error || "This item could not be loaded."} onRetry={reload} />
      )}
    </Modal>
  );
}

const STATUS: Record<Delivery["state"], string> = {
  available: "Also saved in your Files.",
  accepted: "Accepted on this device. Also saved in your Files.",
  declined: "Declined. It stays in your Files.",
};

function DeliveryFooter({ delivery }: { delivery: Delivery }) {
  const close = useCloseModal();
  const [busy, setBusy] = useState<"" | "accept" | "decline">("");
  const item = delivery.item;
  const downloadable = !!item && hasDownloads(item);
  async function run(action: "accept" | "decline") {
    setBusy(action);
    try {
      if (action === "accept") await acceptDelivery(delivery);
      else {
        await declineDelivery(delivery);
        close();
      }
    } catch (error) {
      errorToast(error);
    } finally {
      setBusy("");
    }
  }
  const openInFiles = () => {
    close();
    navigate(itemAddress(delivery.itemId));
  };
  return (
    <>
      <span className="muted">{STATUS[delivery.state]}</span>
      {delivery.state === "available" ? (
        <>
          <Button
            icon={<X size={16} />}
            busy={busy === "decline"}
            disabled={!!busy}
            onClick={() => void run("decline")}
          >
            Decline
          </Button>
          <Button
            variant="primary"
            icon={downloadable ? <Download size={16} /> : <Check size={16} />}
            busy={busy === "accept"}
            disabled={!!busy}
            onClick={() => void run("accept")}
          >
            {downloadable ? "Accept and download" : "Accept"}
          </Button>
        </>
      ) : (
        <>
          <Button icon={<FolderOpen size={16} />} onClick={openInFiles}>
            Open in Files
          </Button>
          {downloadable && item && (
            <Button
              variant="primary"
              icon={<Download size={16} />}
              busy={busy === "accept"}
              onClick={() => void run("accept")}
            >
              {downloadLabel(singleFile(item))}
            </Button>
          )}
        </>
      )}
    </>
  );
}

function DoneButton() {
  const close = useCloseModal();
  return (
    <Button variant="primary" onClick={close}>
      Close
    </Button>
  );
}
