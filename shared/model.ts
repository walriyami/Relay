// Domain shapes exchanged between the server and the client. Every API response is built from these.

export type Id = string;
/** Milliseconds since the Unix epoch. */
export type Time = number;

/**
 * Why a link limited to some people won't open for anyone new (410). Other 410s mean the link or
 * its content is gone; this one is shown as written, since the link still works for others.
 */
export const LINK_USED_UP = "This link has already been opened by the people it was for.";

export const LIMITS = {
  nameLength: 180,
  textBytes: 200_000,
  filesPerTransfer: 50_000,
  foldersPerTransfer: 50_000,
  chunkBytes: 32 * 1024 ** 2,
  /** JSON body limit of a transfer manifest: 50,000 long paths fit comfortably. */
  manifestBytes: 32 * 1024 ** 2,
  linkDaysMax: 365,
  retentionDaysMax: 3650,
  trashDaysMax: 365,
  passwordMin: 10,
  /** The optional name a guest gives with a submission. */
  senderLength: 80,
  inviteNoteLength: 80,
  /** An upload request's message to the people uploading. */
  requestMessageLength: 2000,
  /**
   * Abuse guard, not a setting: entries (files, texts and folders) one request can hold, so a public
   * link cannot fill the database with empty files. Requests are otherwise bounded by size alone.
   */
  requestEntries: 20_000,
  /**
   * Abuse guard: entries one request-link visitor's send can hold (members keep `filesPerTransfer`).
   * Creating a send is one synchronous step for the whole server, so a stranger's must stay small.
   */
  visitorEntriesPerTransfer: 5_000,
  /** The name a member shows other people (share pages, requests, invitations). */
  displayNameLength: 60,
  /** A note shown to whoever opens a link. */
  linkNoteLength: 500,
  linkPasswordMin: 8,
  linkPasswordMax: 128,
  /** The most people one link can be limited to. */
  linkVisitorsMax: 100,
  /** The most History entries one answer holds; Admin shows 50 more at a time. */
  historyMax: 500,
} as const;

/** Usernames: 3–32 characters of lowercase letters, numbers, "-" and "_", starting with a letter or number. */
export const USERNAME = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Built-in values, used until someone chooses otherwise. */
export const DEFAULTS = {
  linkDays: 7,
  trashDays: 30,
  inviteDays: 7,
  sessionDays: 30,
  loginCodeMinutes: 5,
  capacityBytes: 500 * 1024 ** 3,
} as const;

/**
 * What the administrator allows one member, set on their invitation and changeable in Admin. Null is
 * no limit. Members choose their own settings within these.
 */
export type MemberLimits = {
  /** Bytes they can keep. Null shares the total storage with everyone. */
  storage: number | null;
  /** Maximum total age from first saved content, including Trash. Null imposes no new age limit. */
  keepDays: number | null;
  /** The longest a link can work, in days. Null allows links that never expire. */
  linkDays: number | null;
};
export const NO_LIMITS: MemberLimits = { storage: null, keepDays: null, linkDays: null };

/** Days within a limit: a longer choice, or none (forever), becomes the limit itself. */
export const withinLimit = (days: number | null, limit: number | null) =>
  limit === null ? days : days === null ? limit : Math.min(days, limit);

export type User = {
  id: Id;
  username: string;
  /** The name other people see; null shows the username. */
  name: string | null;
  admin: boolean;
  limits: MemberLimits;
  /** New uploads move to Trash after this many days; null keeps them until deleted. */
  retentionDays: number | null;
  /** Trash deletes an item for good this many days after it was trashed. */
  trashDays: number;
};
/**
 * How far setup has come. "account": nobody has an account yet, so the first person to finish
 * that step becomes the administrator. "choices": the administrator exists but hasn't made their
 * own choices and chosen the total storage. "done": Relay is set up.
 */
export type SetupState = "account" | "choices" | "done";
/** What Activity shows. Deliveries still waiting for an answer are always shown. */
export type ActivityGroup = "received" | "requests" | "links" | "security" | "members";
export type ActivityPrefs = Record<ActivityGroup, boolean>;
/**
 * `linkDays`: how long new links work; null keeps them until turned off. `nearbyVisible`: other
 * members on the same network see this member's devices in Nearby (see shared/nearby.ts).
 */
export type Prefs = { linkDays: number | null; autoCopyLink: boolean; nearbyVisible: boolean; activity: ActivityPrefs };
/** The name a member shows other people. */
export const displayName = (user: Pick<User, "name" | "username">) => user.name || user.username;
/**
 * Logical bytes: saved content (Trash included), bytes reserved by unfinished uploads, and what can
 * still be uploaded: the lesser of what the member's storage limit and the total storage leave.
 */
export type Usage = { used: number; reserved: number; available: number };
export type Me = {
  user: User;
  csrf: string;
  device: { id: Id; name: string; kind: DeviceKind };
  prefs: Prefs;
  usage: Usage;
  /** The server offers direct transfers on the local network (see shared/local.ts). */
  local: boolean;
  /** Files of this member, in Files or Trash, whose stored copy is missing or damaged. */
  damagedFiles: number;
};

/** What a device is, from its browser when it signed in; it picks the icon, whatever the name. */
export type DeviceKind = "phone" | "tablet" | "computer";
export type Device = {
  id: Id;
  name: string;
  kind: DeviceKind;
  created: Time;
  seen: Time;
  /** Has at least one live event connection right now. */
  online: boolean;
  current: boolean;
  /** Still holds a session; signed-out devices remain listed for history. */
  signedIn: boolean;
};
export type Passkey = { id: Id; name: string; created: Time; lastUsed: Time | null };
export type LoginCode = { id: Id; created: Time; expires: Time; deviceName: string };
export type LoginCodeStatus = { state: "pending" | "used" | "gone"; deviceName?: string };
export type NewLoginCode = {
  id: Id;
  /** Stable one-time sign-in link secret, independent of the deployment code length. */
  token: string;
  code: string;
  expires: Time;
  /** Milliseconds from issue to `expires`: a countdown that doesn't depend on the device's clock. */
  expiresIn: number;
};
/** A pickup code resolves only to a recipient route; the route performs its usual authorization. */
export type PickupResolution =
  | { kind: "share"; path: string }
  | { kind: "request"; path: string }
  | { kind: "invitation"; path: string }
  | { kind: "device"; path: string }
  | { kind: "nearby"; path: string };

export type NodeKind = "file" | "folder" | "text";
/** Enough to render a preview tile. `path` is relative to the item root, "/"-separated. */
export type NodeRef = {
  id: Id;
  name: string;
  path: string;
  kind: NodeKind;
  size: number;
  mime: string;
};
export type Node = NodeRef & {
  parent: Id | null;
  created: Time;
  /** Present only for kind "text". */
  text?: string;
  /** The stored copy of this file is missing or damaged; uploading the same file again repairs it. */
  damaged?: true;
};

/** One library card: everything saved by one transfer (or one guest submission). */
export type ItemSummary = {
  id: Id;
  /** Display name: the owner's name, or one derived from the contents (e.g. "a.png + 2 more + text"). */
  name: string;
  /** True while the name is derived from the contents rather than typed by the owner. */
  autoName: boolean;
  created: Time;
  /** Null until the first meaningful content has been saved. */
  firstSavedAt: Time | null;
  /** Historical, non-increasing total-age cap in days, including Trash; null is unbounded. */
  maxAgeDays: number | null;
  /** Maximum total lifetime, including Trash; renewal and restore cannot extend it. */
  hardExpires: Time | null;
  expires: Time | null;
  trashed: Time | null;
  purgeAt: Time | null;
  requestId: Id | null;
  files: number;
  texts: number;
  folders: number;
  bytes: number;
  /** Direct children of the item root, by kind. */
  topFiles: number;
  topFolders: number;
  preview: NodeRef | null;
  /** Up to four images when the item holds several. */
  mosaic: NodeRef[];
  textExcerpt: string | null;
  /** Has an active public link. */
  linked: boolean;
  /** Has unfinished uploads. */
  uploading: boolean;
  /** Files whose stored copy is missing or damaged (found by the file check or at startup). */
  damaged: number;
};
export type ItemDetail = ItemSummary & { nodes: Node[]; links: Link[] };
/**
 * Why a search found an item when its own name doesn't match: a file or folder inside it (`name`),
 * or the words of its text (`text`, a short excerpt around the first match).
 */
export type SearchMatch = { in: "name" | "text"; text: string };
/** One bounded page of the library or Trash in the chosen stable order and how many match in all. */
export type ItemPage = { items: (ItemSummary & { match?: SearchMatch })[]; total: number };

export type Link = {
  id: Id;
  itemId: Id;
  token: string;
  code: string;
  created: Time;
  /** Null: works until turned off (or until its item leaves Files). */
  expires: Time | null;
  revoked: boolean;
  /** Not revoked, not expired, and its item is neither trashed nor expired. */
  available: boolean;
  /** As many people as it allows have opened it: they keep access, nobody new gets in. */
  full: boolean;
  /** Needs a password to open. */
  locked: boolean;
  /** How many people may open it; null for anyone with the link. */
  visitorLimit: number | null;
  /** Shown to whoever opens it. */
  note: string;
  /** People (browsers) it let in, not counting the owner. */
  visitors: number;
  /** Downloads by those people: single files and ZIPs. */
  downloads: number;
  /** When someone last opened or downloaded from it. */
  lastVisit: Time | null;
  item: ItemSummary | null;
};
/** One person a link let in. `device` is coarse, such as "Safari on iPhone". */
export type LinkVisit = { id: Id; device: string; first: Time; last: Time; downloads: number };
/** How a link is shared. `days` null keeps it until turned off; a null password leaves it open. */
export type LinkSettings = {
  days: number | null;
  password: string | null;
  visitorLimit: number | null;
  note: string;
};

/** Accepted means downloaded on the receiving device; declined, that it was turned down there. */
export type DeliveryState = "available" | "accepted" | "declined";
export type Delivery = {
  id: Id;
  itemId: Id;
  state: DeliveryState;
  created: Time;
  /** When the receiving device first showed it; null while it waits for that device to open Relay. */
  delivered: Time | null;
  /** When the receiving device accepted or declined it; null while available. */
  answered: Time | null;
  from: { id: Id; name: string } | null;
  to: { id: Id; name: string } | null;
  /** The item still exists and is neither trashed nor expired. */
  available: boolean;
  item: ItemSummary | null;
};

export type UploadRequest = {
  id: Id;
  token: string;
  code: string;
  name: string;
  description: string;
  created: Time;
  expires: Time;
  closed: boolean;
  maxBytes: number;
  receivedFiles: number;
  receivedBytes: number;
  /** Everything the request holds, unfinished uploads included: the lowest size limit it can be given. */
  usedBytes: number;
  /** Saved live content, saved unavailable content, and unfinished reservations partition usedBytes. */
  activeBytes: number;
  trashBytes: number;
  pendingBytes: number;
  /** No room for another file: the size limit is used up (unfinished uploads count). */
  full: boolean;
  /** When a guest last finished a submission. */
  lastReceived: Time | null;
};
/** A guest submission as its owner sees it, with the name the guest gave, if any. */
export type Submission = ItemSummary & { sender: string | null };
export type PublicRequest = {
  name: string;
  description: string;
  expires: Time;
  owner: string;
  maxBytes: number;
  /** The smaller of the request's own room and what the server and the owner's storage can still take. */
  remainingBytes: number;
  /** The request can take nothing more: its size limit is used up, or there is no room for it. */
  full: boolean;
  /** The room is limited by the server or the owner's storage rather than by the request's size limit. */
  storageLimited: boolean;
};
export type GuestGrant = { csrf: string };

/** Who shared it and what they wrote, shown on the share page. */
type ShareFrom = { from: string };
/** A password-protected share before it is unlocked shows only who shared it. */
export type LockedShare = ShareFrom & { locked: true };
export type PublicShare = ShareFrom & {
  locked?: false;
  name: string;
  note: string;
  /** Null when the link works until turned off. */
  expires: Time | null;
  files: number;
  texts: number;
  bytes: number;
  nodes: Node[];
};
export type ShareOpen = LockedShare | PublicShare;

export type Destination =
  | { kind: "save" }
  | ({ kind: "link" } & Partial<LinkSettings> & { days: number | null })
  | { kind: "device"; device: Id };
export type TransferCreated = {
  id: Id;
  itemId: Id;
  /** One per requested file, in request order. Upload bytes to `/uploads/{id}` with tus. */
  uploads: { id: Id; path: string }[];
};
export type TransferResult = { itemId: Id; link: Link | null; delivery: Delivery | null };
export type TransferCancelled = { saved: number; removed: boolean };
/**
 * A member's transfer no open page is sending (its page slept, reloaded or closed). Choosing the
 * same files again continues it; Relay removes it at `keptUntil`.
 */
export type PausedTransfer = {
  id: Id;
  itemId: Id;
  /** The item's name, typed or automatic. */
  name: string;
  /** Files were being added to an item that existed before. */
  adding: boolean;
  /** The transfer carried text, already saved. */
  text: boolean;
  keptUntil: Time;
  files: {
    upload: Id;
    /** Where the file goes in the item. */
    path: string;
    size: number;
    /** Bytes Relay holds. */
    offset: number;
    done: boolean;
    /**
     * Up to 4 KiB from the start of what Relay holds and up to 4 KiB ending at `offset` (base64),
     * so a page can check a chosen file really is the one that was being sent.
     */
    sample?: { head: string; tail: string };
  }[];
};

/** What an invitation link shows before the account is made. Anything unusable is a 410. */
export type InvitationCheck = { expires: Time; invitedBy: string };
/** An invitation nobody has used yet, as the administrator sees it. The token itself is never kept. */
export type PendingInvite = {
  id: Id;
  created: Time;
  expires: Time;
  createdBy: string;
  note: string | null;
  code: string;
  /** What the new member will be allowed. */
  limits: MemberLimits;
};

export type AdminMember = User & {
  disabled: boolean;
  /**
   * When removing them stopped part way because some files couldn't be deleted. They stay
   * suspended, and no longer an administrator, until removed again or their suspension is lifted.
   */
  removalStopped: Time | null;
  created: Time;
  usage: Usage;
  /** Devices holding a session now: the ones a suspension or password reset signs out. */
  signedInDevices: number;
  /** When one of their devices was last seen, if any ever was. */
  lastActive: Time | null;
  /** Their account is linked to a Walriyami identity, so they can sign in with Walriyami. */
  walriyami: boolean;
};
/** What changing a member's limits did to what they already had. */
export type LimitsApplied = { links: number; items: number; requests: number };
export type ServiceOperations = {
  maintenanceIntervalMs: number;
  started: Time;
  sampled: Time;
  memoryBytes: number;
  recent: { requests: number; failures: number; limited: number };
  reconciliation: { checked: Time; missing: number; removedOrphans: number };
  maintenance: { name: string; attempted: Time; succeeded: Time | null; failed: boolean; failures: number }[];
};

/** What the public health route reports. Problems are named, never detailed: the route is public. */
export type HealthProblem = "database" | "disk-space" | "stored-files" | "usage-records" | "maintenance";
export type Health = {
  ok: boolean;
  status: "healthy" | "degraded" | "unavailable";
  problems: HealthProblem[];
  /** Which build is live, so a deploy can be checked from outside (server/build-info.ts). */
  version: string;
  /** The commit's first 7 characters, as Admin shows it; null for a development copy. */
  commit: string | null;
};

/** Free space is low below 1 GiB, or below 5% on a disk smaller than 20 GiB. */
export const isDiskLow = (free: number, total: number) => free < Math.min(1024 ** 3, total * 0.05);

export type AdminOverview = {
  operations: ServiceOperations;
  integrity: BlobStatus;
  usageBuffer: { pending: number; failed: boolean; discarded: number };
  /** The last failed database write, until a write succeeds again (or for good, when it is damaged). */
  database: { failure: { at: Time; message: string; damaged: boolean } | null };
  /** When Relay last saw someone guessing pickup codes, or null. */
  codeAttackAt: Time | null;
  members: AdminMember[];
  storage: {
    used: number;
    reserved: number;
    capacity: number;
    diskFree: number;
    diskTotal: number;
    blobBytes: number;
    trashBytes: number;
    trashItems: number;
  };
  limits: {
    capacity: number;
  };
  activity: { activeUploads: number; receivedBytesLastHour: number };
  local: LocalStatus;
  /** The saved version of the code this server runs (server/build-info.ts). */
  build: { version: string; commit: string | null; committed: string | null };
};
/**
 * Direct transfers on the local network. off: turned off with RELAY_DIRECT. starting: the helper is
 * starting. down: the helper isn't running, for `problem` when it said why; Relay keeps starting it
 * again. ready: browsers on the server's networks can connect, and `links` are.
 */
export type LocalStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "down"; problem: string | null }
  | { state: "ready"; links: number };

/** The periods Usage and Admin can show: days, or calendar months. */
export const USAGE_RANGES = ["7d", "30d", "90d", "12m"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
/** What happened over a period. Bytes, except the counts of files, visitors and downloads. */
export type UsageCounts = {
  /** Uploaded by the member. */
  uploaded: number;
  /** Uploaded by guests through the member's requests. */
  received: number;
  /** Downloaded by the member: files and ZIPs. Previews in the app aren't counted. */
  downloaded: number;
  /** Downloaded by people through the member's links. */
  shared: number;
  /** Files that finished uploading, the member's and guests'. */
  files: number;
  /** People the member's links let in. */
  visitors: number;
  /** Downloads through the member's links. */
  downloads: number;
};
/** One day or month of a report, starting at local midnight. `stored` is what was kept at its end. */
export type UsageBucket = UsageCounts & { start: Time; stored: number };
export type StorageKind = "images" | "videos" | "audio" | "documents" | "archives" | "other";
/** What storage holds now. `kinds` covers Files; Trash and unfinished uploads are counted apart. */
export type StorageSummary = {
  used: number;
  reserved: number;
  trash: number;
  kinds: { kind: StorageKind; bytes: number; files: number }[];
};
type UsageReportBase = {
  range: UsageRange;
  buckets: UsageBucket[];
  totals: UsageCounts;
  /** The same length of time just before, for comparison. */
  previous: UsageCounts;
  storage: StorageSummary;
  /** What there is now: items and files in Files, links that work, and requests that are open. */
  counts: { items: number; files: number; links: number; requests: number };
};
export type UsageReport = UsageReportBase & {
  /** What can still be uploaded now, and the member's storage limit. */
  available: number;
  limit: number | null;
  /** The biggest items in Files, largest first. */
  largest: { id: Id; name: string; bytes: number }[];
};
export type AdminUsageReport = UsageReportBase & {
  capacity: number;
  /** Requests the server answered, and failed, in each bucket. */
  traffic: { requests: number; failures: number }[];
  /** Each member's totals over the range, with what they keep now. */
  members: { id: Id; username: string; name: string | null; totals: UsageCounts; used: number }[];
};

/** A member's own storage, for Settings → Storage. Bytes. */
export type StorageOverview = {
  /** Saved, Trash included, and uploads still arriving. */
  used: number;
  reserved: number;
  /** What can still be uploaded now, and the member's own limit (null: shares the total storage). */
  available: number;
  limit: number | null;
  /** What Trash holds; it counts until it is emptied. */
  trash: { items: number; bytes: number };
  /** Items in Files, and the largest of them, largest first. */
  items: number;
  largest: { id: Id; name: string; bytes: number }[];
};

/**
 * Something that happened on this Relay, for the administrator's history. Names are as they were
 * then. Never a file's name or contents: the history says that a member shared, not what.
 */
export type HistoryEvent =
  /** `via`: an invitation (from `by`), single sign-on, or the first account made at setup. */
  | { kind: "joined"; username: string; via: "invitation" | "sso" | "setup"; by: string | null }
  | { kind: "removed"; username: string; by: string; items: number; bytes: number }
  | { kind: "suspended" | "restored"; username: string; by: string }
  | { kind: "role"; username: string; by: string; admin: boolean }
  /** `by` is the administrator who reset it; null when the owner recovered access from the server. */
  | { kind: "password"; username: string; by: string | null }
  /** A member's finished upload: kept in Files, sent to one of their devices, or shared as a link. */
  | {
      kind: "sent";
      username: string;
      to: "files" | "device" | "link";
      device: string | null;
      files: number;
      bytes: number;
    }
  /** A member made a link from Files, or opened a request for files. */
  | { kind: "shared"; username: string; what: "link" | "request" }
  /** Someone without an account sent files through a member's request. */
  | { kind: "received"; username: string; files: number; bytes: number }
  /** `username` is null when the name typed doesn't belong to anyone. */
  | { kind: "signin"; username: string | null; reason: "password" | "suspended" | "locked" }
  /** `area` says in words what went wrong: "uploading", "a cleanup job", "the file check"… */
  | { kind: "error"; area: string; detail: string };
export type HistoryKind = HistoryEvent["kind"];
/** The filters History offers. */
export const HISTORY_GROUPS = ["people", "sharing", "signin", "problems"] as const;
export type HistoryGroup = (typeof HISTORY_GROUPS)[number];
export const HISTORY_GROUP_OF: Record<HistoryKind, HistoryGroup> = {
  joined: "people",
  removed: "people",
  suspended: "people",
  restored: "people",
  role: "people",
  password: "people",
  sent: "sharing",
  shared: "sharing",
  received: "sharing",
  signin: "signin",
  error: "problems",
};
/** Repeats of a failed sign-in or an error within an hour are one entry: `count` times, last at `last`. */
export type HistoryEntry = HistoryEvent & { id: Id; created: Time; last: Time; count: number; userId: Id | null };
/** The newest entries, newest first. `more`: older ones exist. */
export type HistoryPage = { entries: HistoryEntry[]; more: boolean };

/** What removing a member deletes, so the confirmation can say it in numbers. */
export type MemberRemoval = {
  /** Items in Files and Trash, and the space they free (uploads still arriving included). */
  items: number;
  bytes: number;
  /** Shared links and upload requests that stop working. */
  links: number;
  requests: number;
  /** Devices signed in now. */
  devices: number;
};

/** Server-sent event topics. A client refetches whatever a topic covers. */
/** `codes`: Relay noticed someone guessing pickup codes (Admin shows when). */
export type Topic =
  | "items"
  | "links"
  | "deliveries"
  | "devices"
  | "requests"
  | "account"
  | "activity"
  | "codes"
  | "nearby"
  /** Administrators only: something new in History. */
  | "history";
export type ChangeEvent = { topics: Topic[] };
/**
 * The first event on every stream. After it the server sends a `beat` event at least every
 * `beatMs`, so a stream that goes quiet for longer has been cut somewhere on the way. `changes` is
 * where changes stood when the stream opened: a view whose last answer carried the same stamp, or
 * a later one, has missed nothing (see `headers.changes`). Only a member's stream carries it, since
 * the count moves with everyone's activity.
 */
export type StreamReady = { beatMs: number; changes?: ChangeStamp };
/** `<boot>.<count>`: publishes counted since the server started. Compare only within one boot. */
export type ChangeStamp = `${string}.${number}`;
/**
 * Whether an answer stamped `read` can lack a change that a stream opened at `opened` won't send:
 * it was read before the stream opened, under another boot of the server, or can't say when.
 */
export function missed(read: ChangeStamp | null | undefined, opened: ChangeStamp): boolean {
  if (!read) return true;
  const at = read.lastIndexOf(".");
  const from = opened.lastIndexOf(".");
  return read.slice(0, at) !== opened.slice(0, from) || Number(read.slice(at + 1)) < Number(opened.slice(from + 1));
}
/** Admission is full; close this source and intentionally retry after a bounded delay. */
export type StreamLimited = { retryMs: number };
/**
 * Sent as an `ended` event just before the server closes a member stream whose session stopped
 * working, so the open tab can say why instead of failing on its next request.
 */
export type SessionEnded = {
  reason: "suspended" | "signed-out" | "password-reset" | "password-changed" | "expired";
};

export type SignInMethod = "sso" | "password" | "passkey" | "code" | "invitation" | "setup";
/** Something that happened on the account. Device and request names are as they were then. */
export type ActivityEvent =
  /**
   * `familiar`: the account already had a device like this one (same kind and browser name), so a
   * sign-in there is routine. Missing on entries from before it was recorded, which count as familiar.
   */
  | { kind: "signin"; deviceId: Id; device: string; method: SignInMethod; familiar?: boolean }
  /** `device` is where it was changed; null when the administrator set it. */
  | { kind: "password"; device: string | null }
  | { kind: "passkey"; change: "added" | "removed"; name: string }
  | {
      kind: "upload";
      requestId: Id;
      request: string;
      sender: string | null;
      itemId: Id;
      files: number;
      bytes: number;
      text: boolean;
    }
  /** A new member: with an invitation, or by signing in with Walriyami (`walriyami`). */
  | { kind: "joined"; userId: Id; username: string; note: string | null; walriyami?: boolean }
  /** Someone opened a link, or downloaded from it, for the first time. `item` is its name then. */
  | { kind: "link"; linkId: Id; itemId: Id; item: string; action: "opened" | "downloaded"; device: string };
export type ActivityKind = ActivityEvent["kind"];
/**
 * `self`: the device reading the feed caused it. `news`: worth the bell's badge on this device: not
 * caused here, and not routine (a sign-in from a familiar device, someone only opening a link).
 */
export type ActivityEntry = ActivityEvent & { id: Id; created: Time; self: boolean; news: boolean };
/** The newest entries the member wants to see, and until when any device of theirs has seen them. */
export type ActivityFeed = { entries: ActivityEntry[]; seen: Time };
export const ACTIVITY_GROUPS: Record<ActivityKind, ActivityGroup> = {
  signin: "security",
  password: "security",
  passkey: "security",
  upload: "requests",
  link: "links",
  joined: "members",
};

/** Web Push for this device: the server's public (VAPID) key, and whether this device gets notices. */
export type PushStatus = { key: string; subscribed: boolean };
/** A push subscription as the browser gives it (PushSubscription.toJSON()). */
export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

/** Explicit storage integrity checks, exposed only to administrators. */
export type ScrubResult = {
  checked: number;
  bytes: number;
  missing: number;
  corrupt: number;
  errors: number;
  cancelled: boolean;
  complete: boolean;
  nextAfter: string | null;
  started: number;
  finished: number;
};
export type BlobStatus = {
  /**
   * Members with files whose stored copy is missing, damaged or unreadable, most affected first.
   * Counts only: the administrator sees whose files, not which.
   */
  affected: { userId: Id; username: string; files: number; items: number }[];
  total: number;
  /** Bytes of every stored copy, each counted once however many files share it. */
  storedBytes: number;
  healthy: number;
  missing: number;
  corrupt: number;
  errors: number;
  lastChecked: number | null;
  lastFullCheck: number | null;
  lastResult: ScrubResult | null;
  lastError: boolean;
  running: boolean;
  checked: number;
  bytes: number;
};
