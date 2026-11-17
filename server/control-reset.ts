/**
 * Offline control adapter, used by the hosting control system (`adapter: relay` in wal.service.yaml)
 * on a stopped Relay:
 *   --content  clears transfers, files, links, requests and statistics; keeps accounts and settings.
 *   --clone    clears sign-ins and address-bound keys, for a copy that will run at another address.
 * See docs/hosting.md → "Resetting content". The tables each one clears are listed in db/reset.ts.
 */
import { resolve } from "node:path";
import { resetClone, resetContent } from "./db/reset.ts";

const root = resolve(process.env.RELAY_DATA || ".data");
const mode = process.argv[2];
if (mode === "--content") {
  resetContent(root);
  process.stdout.write("Transfers and content cleared; accounts and settings preserved.\n");
} else if (mode === "--clone") {
  resetClone(root);
  process.stdout.write("Clone sessions and hostname-bound credentials cleared.\n");
} else throw new Error("Choose --content or --clone. Run it only while Relay is stopped.");
