// The services the modules share. app.ts builds one Context and hands it to every module's
// register function; modules talk to each other only through these interfaces.
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { Stats } from "node:fs";
import type { Operations } from "./lib/operations.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./lib/events.ts";
import type { Secrets } from "./lib/secrets.ts";
import type * as M from "../shared/model.ts";
import type * as z from "zod/mini";
import type { transferInput } from "../shared/api.ts";

/** A signed-in browser session. */
export type Member = {
  kind: "member";
  userId: string;
  username: string;
  admin: boolean;
  sessionHash: string;
  deviceId: string;
  csrf: string;
};
/** A guest's permission to upload to one open upload request, held in a per-request cookie. */
export type Grant = {
  kind: "grant";
  tokenHash: string;
  requestId: string;
  owner: string;
  /** The submission item, once the guest's first transfer created it. */
  itemId: string | null;
  csrf: string;
  expires: number;
};
export type Principal = Member | Grant;
/** Everything a request is authenticated as. */
export type Auth = { member: Member | null; grants: Grant[] };
/** The stable key stored on tabs and transfers: 'user:<id>' or 'grant:<token hash>'. */
export const principalKey = (p: Principal) => (p.kind === "member" ? `user:${p.userId}` : `grant:${p.tokenHash}`);
/** How stale a tab lease (or device sighting) may get before activity writes it again; well inside the lease. */
export const leaseRenewalMs = (ctx: Context) => Math.min(60_000, ctx.config.tabLeaseMs / 3);

export type ScrubOptions = {
  after?: string;
  limit?: number;
  /** Stop between objects after this many bytes; one larger object is allowed. */
  maxBytes?: number;
  /** Stop between objects after this duration; one larger object is allowed to finish. */
  maxDurationMs?: number;
  signal?: AbortSignal;
};
export type ScrubResult = M.ScrubResult;
export type BlobStatus = M.BlobStatus;

/** Content-addressed payload storage under <root>/blobs. */
export interface BlobStore {
  /** Absolute path of a stored blob. */
  path(sha256: string): string;
  /** Cheap status/size verification. Rejects known damage without hashing each download. */
  verify(sha256: string, size?: number): Promise<void>;
  /** Explicit, single-flight sequential integrity scan, resumable after nextAfter. */
  scrub(options?: ScrubOptions): Promise<ScrubResult>;
  status(): BlobStatus;
  /** Indexed check suitable for public readiness requests. */
  degraded(): boolean;
  /** Cancels a running scrub and waits before the database can close. */
  close(): Promise<void>;
  /**
   * Hard-links a fully written, fsynced upload file into its blob path and makes the link durable,
   * off the event loop. Begins outside a transaction and journals cleanup without claiming adoption.
   * Follow with `adopt` (or `unstage` if the upload is dropped).
   */
  stage(file: string, sha256: string, expected?: Stats): Promise<void>;
  /** Removes a staged link that was never adopted, unless the blob is recorded. Synchronous. */
  unstage(sha256: string, file?: string): void;
  /**
   * Records a blob inside the caller's synchronous block. Adoption inside a transaction requires a
   * completed stage. An unstaged file can be adopted outside a transaction; its cleanup is journaled
   * before filesystem writes. A staged file replaced since staging is relinked and synced here.
   * The caller removes its own upload file after its transaction commits.
   */
  adopt(file: string, sha256: string, size: number, crc32: number): void;
  /** Creates and adopts the empty blob, with no caller-owned temporary. Call outside a transaction. */
  adoptEmpty(): void;
  /** Journals a rendition/decoder-marker temporary and leases its source until publication settles. */
  stageThumbnail(sha256: string): { file: string; finish(): void; discard(): void };
  /** Deletes the given blobs if no node references them any more. Synchronous. */
  collect(candidates: Iterable<string>): void;
  /** Retries a bounded batch of durable unreferenced blob cleanup. */
  sweep(): void;
  /** Startup reconciliation: removes files with no row and reports rows with no file. */
  reconcile(): Promise<{ removedFiles: number; missing: string[] }>;
}

export type ItemRow = {
  id: string;
  owner: string;
  name: string | null;
  created: number;
  expires: number | null;
  first_saved_at: number | null;
  retention_days: number | null;
  max_age_days: number | null;
  trashed: number | null;
  purge_at: number | null;
  request_id: string | null;
};

/** The library: items and their node trees. Owns every write to items and nodes. */
export interface Library {
  /** The owner's item, or 404. With `live`, also 410 when trashed or expired. */
  owned(owner: string, itemId: string, options?: { live?: boolean }): ItemRow;
  /** Not trashed and not expired. */
  isLive(item: ItemRow, now?: number): boolean;
  /** Summaries for the given ids that exist, recomputing any dirty ones. */
  summaries(itemIds: string[]): Map<string, M.ItemSummary>;
  /** All nodes of an item with their paths, texts included, ordered by path. */
  nodes(itemId: string): M.Node[];
  /** Moves an item to Trash and revokes its links. Idempotent. */
  trash(owner: string, itemId: string): void;
  /** Removes an item permanently and collects its blobs. Synchronous. */
  purge(itemId: string): void;
  sweep(now: number): Promise<void>;
}

export type TransferInput = z.infer<typeof transferInput>;
export type CreateTransferOptions = {
  owner: string;
  principal: Principal;
  /** Append to this existing item (a guest's submission) instead of creating one. */
  itemId?: string;
  /** Create the new item as a submission to this request. */
  requestId?: string;
  /** Name for a newly created item; otherwise input.name (null derives it from the contents). */
  itemName?: string;
  /** Sanitized guest label stored atomically when creating a submission item. */
  sender?: string | null;
  /** What a guest request can still accept: bytes, and entries (every created file, folder and text). */
  limit?: { bytes: number; entries: number };
};

/** Transfers, their tus uploads, and the tabs that own them. */
export interface Transfers {
  /** Synchronous and idempotent by input.id. Owns its transaction; call outside any existing one. */
  create(input: TransferInput, options: CreateTransferOptions): M.TransferCreated;
  /**
   * Extends a tab's lease, creating the tab for this principal if new. Returns false for a closed
   * tab or one owned by another principal.
   */
  renewTab(tab: string, principal: Principal): boolean;
  /** Cancels an item's open transfers, optionally only one principal's. Synchronous. */
  cancelForItem(itemId: string, principal?: string): void;
  /** Cancels an upload request's open guest transfers (it was closed). */
  cancelForRequest(requestId: string): void;
  /** Bytes still to be received by unfinished uploads (for disk admission). */
  outstandingBytes(): number;
  activeUploads(): number;
  receivedBytesSince(time: number): number;
  sweep(now: number): Promise<void>;
  /** Recover after restart: rebuild hash state and finish uploads whose bytes all arrived. */
  recover(): Promise<void>;
}

/** A new link. `days` null keeps it until turned off; the password arrives already hashed. */
export type LinkInput = {
  id: string;
  item: string;
  days: number | null;
  passwordHash?: string | null;
  visitorLimit?: number | null;
  note?: string;
};
/**
 * A browser's way into a link. `visit` is the person it was counted as; null for the owner, or for
 * a browser that can't be told apart. `locked`: the link wants its password first.
 */
export type ShareAccess = {
  linkId: string;
  itemId: string;
  owner: string;
  note: string;
  expires: number | null;
  visit: string | null;
  /** The link's owner, signed in: never counted as a visitor, and not sharing with anyone. */
  byOwner: boolean;
  locked: boolean;
};

/** Public links: who may open them, and what they did. */
export interface Links {
  /**
   * Opens a link in this browser: sets its visitor cookie and lets it in unless a password is needed.
   * Unknown, revoked and expired links are 404; content that left Files is 410.
   */
  open(token: string, req: FastifyRequest, reply: FastifyReply): ShareAccess;
  /** Checks a content or archive request: 401 while locked, 410 when a limited link is used up. */
  content(token: string, req: FastifyRequest): ShareAccess;
  /** Checks the password and lets this browser in. Wrong guesses per link are limited. */
  unlock(token: string, password: string, req: FastifyRequest, reply: FastifyReply): Promise<ShareAccess>;
  /** Counts a download by the person `access` was let in as. */
  downloaded(access: ShareAccess): void;
  /** Idempotent by input.id. Synchronous. */
  create(owner: string, input: LinkInput): M.Link;
  /** The item's links that are still available, newest first. */
  forItem(owner: string, itemId: string): M.Link[];
}

export interface Deliveries {
  /** Idempotent by input.id. Synchronous. */
  create(owner: string, fromDevice: string | null, input: { id: string; item: string; device: string }): M.Delivery;
}

/** The account activity feed. */
export interface Activity {
  /**
   * Records an event for the owner. `by` is the owner's device that caused it, if one did. Synchronous,
   * so it can join the caller's transaction.
   */
  record(owner: string, event: M.ActivityEvent, by?: string | null): void;
  sweep(now: number): Promise<void>;
}

/** Counts usage per member and requests per hour, written in batches. See `usage` in the schema. */
export interface UsageMeter {
  add(userId: string, counts: Partial<M.UsageCounts>): void;
  request(failed: boolean): void;
  /** Writes what was counted so far; reports call it first. Synchronous. */
  flush(): void;
  /** Stops background retries and writes the final batch, propagating any storage failure. */
  close(): void;
  status(): { pending: number; failed: boolean; discarded: number };
  /** Samples stored bytes and forgets history older than it keeps. */
  sweep(now: number): void;
}

export type Context = {
  operations: Operations;
  config: Config;
  db: Database;
  secrets: Secrets;
  events: EventBus;
  blobs: BlobStore;
  library: Library;
  transfers: Transfers;
  links: Links;
  deliveries: Deliveries;
  activity: Activity;
  usage: UsageMeter;
  log: FastifyBaseLogger;
};
