import { api, call, type Delivery, type ItemDetail } from "../../api";
import { notifyChange } from "../../lib/live";
import { downloadItem, hasDownloads } from "../library/actions";

/** The delivery is waiting for this device to accept or decline it. */
export const isPending = (d: Delivery) => d.state === "available" && d.available;

/**
 * Answers a delivery sent to this device. Returns whether this call was the one that answered it:
 * when several tabs see the same arrival, only one of them wins and downloads it.
 */
export async function answerDelivery(d: Pick<Delivery, "id">, state: "accepted" | "declined") {
  const result = await call(api.deliveries.update, { params: { id: d.id }, body: { state } });
  notifyChange("deliveries");
  return result.changed;
}

/**
 * Accepting means downloading it here. The item is always in Files already; accepting only says
 * it was taken on this device. `item` is the loaded item when there is one, to skip a reload.
 */
export async function acceptDelivery(d: Delivery, item?: ItemDetail) {
  const changed = await answerDelivery(d, "accepted");
  // A pending arrival is claimed once across tabs. An already answered arrival's Download
  // action is an explicit request to download it again.
  if (d.state === "available" && !changed) return;
  const target = item ?? d.item;
  // Text alone has nothing to download; it is read in the popup.
  if (target && hasDownloads(target)) await downloadItem(target);
}

export const declineDelivery = (d: Delivery) => answerDelivery(d, "declined");
