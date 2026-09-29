import type { CodeLength, PickupProtection } from "./codes.ts";
export type { PickupProtection } from "./codes.ts";

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
  passwordMin: 6,
  /** The optional name a guest gives with a submission. */
  senderLength: 80,
  inviteNoteLength: 80,
  /** An upload request's message to the people uploading. */
  requestMessageLength: 2000,
  /**
   * Abuse guard, not a setting: entries (files, texts and folders) one request can hold, so a public
   * link cannot fill the database with empty files. Requests are otherwise bounded by size alone.
   */
  requestEntries: 100_000,
  /** The name a member shows other people (share pages, requests, invitations). */
  displayNameLength: 60,
  /** A note shown to whoever opens a link. */
  linkNoteLength: 500,
  linkPasswordMin: 4,
  linkPasswordMax: 128,
  /** The most people one link can be limited to. */
  linkVisitorsMax: 100,
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
/** `linkDays`: how long new links work; null keeps them until turned off. */
export type Prefs = { linkDays: number | null; autoCopyLink: boolean; activity: ActivityPrefs };
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
  | { kind: "device"; path: string };

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
  /** When the receiving device accepted or declined it; null while available, and for deliveries opened before this was recorded. */
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
  remainingBytes: number;
  /** The request can take nothing more: its size limit is used up. */
  full: boolean;
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
  created: Time;
  usage: Usage;
  /** Devices holding a session now: the ones a suspension or password reset signs out. */
  signedInDevices: number;
  /** When one of their devices was last seen, if any ever was. */
  lastActive: Time | null;
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

export type AdminOverview = {
  operations: ServiceOperations;
  integrity: BlobStatus;
  usageBuffer: { pending: number; failed: boolean; discarded: number };
  /** The administrator's preference, even when security temporarily lengthens public codes. */
  codeLength: CodeLength;
  codeProtection: Omit<PickupProtection, "addressPausedUntil"> & { effectiveCodeLength: CodeLength };
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
};
/**
 * Direct transfers on the local network. off: RELAY_LOCAL is not set. down: the relay-local helper
 * isn't answering. ready: browsers on these addresses' networks can connect.
 */
export type LocalStatus =
  { state: "off" } | { state: "down" } | { state: "ready"; addresses: string[]; port: number; links: number };

/** The periods Usage and Admin can show: days, or calendar months. */
export const USAGE_RANGES = ["7d", "30d", "90d", "12m"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
/** What happened over a period. Bytes, except the counts of files, visitors and downloads. */
export type UsageCounts = {
  /** Uploaded by the member. */
  uploaded: number;
  /** Uploaded by guests through the member's requests. */
  received: number;
  /** Downloaded by the member: files, previews and ZIPs. */
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

/** Server-sent event topics. A client refetches whatever a topic covers. */
/** `codes`: the deployment's pickup-code length or protection changed. */
export type Topic = "items" | "links" | "deliveries" | "devices" | "requests" | "account" | "activity" | "codes";
export type ChangeEvent = { topics: Topic[] };
/**
 * The first event on every stream. After it the server sends a `beat` event at least every
 * `beatMs`, so a stream that goes quiet for longer has been cut somewhere on the way. `changes` is
 * where changes stood when the stream opened: a view whose last answer carried the same stamp, or
 * a later one, has missed nothing (see `headers.changes`).
 */
export type StreamReady = { beatMs: number; changes: ChangeStamp };
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

export type SignInMethod = "password" | "passkey" | "code" | "invitation" | "setup";
/** Something that happened on the account. Device and request names are as they were then. */
export type ActivityEvent =
  | { kind: "signin"; deviceId: Id; device: string; method: SignInMethod }
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
  | { kind: "joined"; userId: Id; username: string; note: string | null }
  /** Someone opened a link, or downloaded from it, for the first time. `item` is its name then. */
  | { kind: "link"; linkId: Id; itemId: Id; item: string; action: "opened" | "downloaded"; device: string };
export type ActivityKind = ActivityEvent["kind"];
/** `self`: the device reading the feed caused it, so it is never news there. */
export type ActivityEntry = ActivityEvent & { id: Id; created: Time; self: boolean };
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
  total: number;
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
