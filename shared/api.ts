import type { CodeLength } from "./codes.ts";
// The complete JSON API. Server routes are registered from these definitions and the client calls
// them through the same objects, so request validation, auth and response types live in one place.
// Byte streams (downloads, ZIPs, thumbnails, tus uploads, server-sent events) are addressed by `urls`.
// zod/mini is tree-shakable, so the client bundle carries only the validators it uses.
import * as z from "zod/mini";
import { LOCAL } from "./local.ts";
import { LIMITS, USAGE_RANGES, USERNAME } from "./model.ts";
import type * as M from "./model.ts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";
/**
 * public: no credentials. member: a signed-in session. admin: an administrator session.
 * any: a member session and/or guest grants; the handler decides which principal owns the target.
 */
export type Auth = "public" | "member" | "admin" | "any";
export type Schema = z.ZodMiniType | undefined;
export type Endpoint<
  P extends string = string,
  Q extends Schema = Schema,
  B extends Schema = Schema,
  R = unknown,
  A extends Auth = Auth,
> = {
  readonly method: Method;
  readonly path: P;
  readonly auth: A;
  /** Unsafe methods require the X-Relay-CSRF header unless this is false (sign-in style endpoints). */
  readonly csrf: boolean;
  readonly query: Q;
  readonly body: B;
  readonly __response?: R;
};
const endpoint =
  <R>() =>
  <const P extends string, const A extends Auth, Q extends Schema = undefined, B extends Schema = undefined>(
    method: Method,
    path: P,
    options: { auth: A; csrf?: boolean; query?: Q; body?: B },
  ): Endpoint<P, Q, B, R, A> => ({
    method,
    path,
    auth: options.auth,
    csrf: options.csrf ?? true,
    query: options.query as Q,
    body: options.body as B,
  });

type ParamNames<P extends string> = P extends `${string}:${infer N}/${infer Rest}`
  ? N | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer N}`
    ? N
    : never;
export type Params<E> = E extends Endpoint<infer P> ? { [K in ParamNames<P>]: string } : never;
export type Query<E> = E extends Endpoint<string, infer Q> ? (Q extends z.ZodMiniType ? z.infer<Q> : undefined) : never;
export type Body<E> =
  E extends Endpoint<string, Schema, infer B> ? (B extends z.ZodMiniType ? z.infer<B> : undefined) : never;
export type Response<E> = E extends Endpoint<string, Schema, Schema, infer R> ? R : never;
/** An object with no required fields; a type extends it only when every field is optional. */
export type NoFields = Record<never, never>;
/** What a caller passes: path params, query and body, each only when the endpoint has them. */
export type Input<E> =
  E extends Endpoint<infer P, infer Q, infer B>
    ? ([ParamNames<P>] extends [never] ? unknown : { params: { [K in ParamNames<P>]: string } }) &
        (Q extends z.ZodMiniType ? { query?: z.input<Q> } : unknown) &
        (B extends z.ZodMiniType
          ? NoFields extends z.input<B>
            ? { body?: z.input<B> }
            : { body: z.input<B> }
          : unknown)
    : never;

const id = z.uuid();
const text = (min: number, max: number) => z.string().check(z.minLength(min), z.maxLength(max));
const int = (min: number, max: number) => z.number().check(z.int(), z.gte(min), z.lte(max));
const name = z.string().check(z.trim(), z.minLength(1), z.maxLength(LIMITS.nameLength));
const deviceName = z.optional(name);
const deviceKind = z.enum(["phone", "tablet", "computer"]);
/** What a signing-in browser says it is; the server falls back to its user agent. */
const deviceHint = { deviceName, deviceKind: z.optional(deviceKind) };
const password = text(LIMITS.passwordMin, 256);
const days = int(1, LIMITS.linkDaysMax);
const retentionDays = z.nullable(int(1, LIMITS.retentionDaysMax));
const trashDays = int(1, LIMITS.trashDaysMax);
const quota = int(1, Number.MAX_SAFE_INTEGER);
const displayName = z.nullable(z.string().check(z.trim(), z.maxLength(LIMITS.displayNameLength)));
const username = z.string().check(z.trim(), z.toLowerCase(), z.regex(USERNAME));
const requestMessage = z._default(text(0, LIMITS.requestMessageLength), "");
const requestBytes = int(1, 1024 ** 4);
const path = text(1, 2048);
const passkeyResponse = z.record(z.string(), z.unknown());
const challenge = text(1, 200);
const ok = endpoint<{ ok: true }>();

/** How long a link works: null keeps it until turned off. */
const linkDays = z.nullable(days);
const linkPassword = z.nullable(text(LIMITS.linkPasswordMin, LIMITS.linkPasswordMax));
const visitorLimit = z.nullable(int(1, LIMITS.linkVisitorsMax));
/** What the administrator allows one member; null is no limit. See MemberLimits. */
const memberLimits = z.object({
  storage: z.nullable(quota),
  keepDays: z.nullable(int(1, LIMITS.retentionDaysMax)),
  linkDays: z.nullable(days),
});
const inviteNote = z.string().check(z.trim(), z.maxLength(LIMITS.inviteNoteLength));
const usageQuery = z.object({
  range: z._default(z.enum(USAGE_RANGES), "30d"),
  /** The viewer's time zone, in minutes east of UTC, so days and months start at their midnight. */
  tz: z._default(z.coerce.number().check(z.int(), z.gte(-840), z.lte(840)), 0),
});
const linkNote = z.string().check(z.trim(), z.maxLength(LIMITS.linkNoteLength));
/** A new link's settings; anything left out is open to anyone, with no note. */
const linkSettings = {
  days: linkDays,
  password: z.optional(linkPassword),
  visitorLimit: z.optional(visitorLimit),
  note: z.optional(linkNote),
};

export const destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("save") }),
  z.object({ kind: z.literal("link"), ...linkSettings }),
  z.object({ kind: z.literal("device"), device: id }),
]);
export const transferInput = z.object({
  /** Client-chosen; retrying the same create is idempotent. */
  id,
  /**
   * Adds to this existing item instead of making a new one: what is already there stays as it was,
   * and its links show the additions once they finish. `name` and `retentionDays` are then ignored.
   */
  item: z.optional(id),
  /** The page load that owns the transfer. Closing that tab abandons it. */
  tab: z.string().check(z.regex(/^[A-Za-z0-9_-]{16,64}$/)),
  /** Null derives the name from the contents. */
  name: z.nullable(name),
  retentionDays: z.optional(retentionDays),
  text: z.optional(text(0, LIMITS.textBytes)),
  /** Folder paths to create even when empty. Parents of file paths are created implicitly. */
  folders: z._default(z.array(path).check(z.maxLength(LIMITS.foldersPerTransfer)), []),
  files: z
    .array(z.object({ path, size: int(0, Number.MAX_SAFE_INTEGER), mime: z._default(text(0, 120), "") }))
    .check(z.maxLength(LIMITS.filesPerTransfer)),
});

export const api = {
  health: endpoint<{ ok: true; status: "healthy" | "degraded" }>()("GET", "/api/health", { auth: "public" }),

  session: {
    get: endpoint<M.Me>()("GET", "/api/session", { auth: "member" }),
    password: endpoint<M.Me>()("POST", "/api/session/password", {
      auth: "public",
      csrf: false,
      body: z.object({ username: text(1, 64), password: text(0, 256), ...deviceHint }),
    }),
    passkeyOptions: endpoint<{ challenge: string; options: unknown }>()("POST", "/api/session/passkey/options", {
      auth: "public",
      csrf: false,
    }),
    passkey: endpoint<M.Me>()("POST", "/api/session/passkey", {
      auth: "public",
      csrf: false,
      body: z.object({ challenge, response: passkeyResponse, ...deviceHint }),
    }),
    code: endpoint<M.Me>()("POST", "/api/session/code", {
      auth: "public",
      csrf: false,
      body: z.object({ code: text(1, 32), ...deviceHint, deviceName: name }),
    }),
    deviceLinkCheck: endpoint<{ expires: number }>()("GET", "/api/session/device-link/:token", {
      auth: "public",
      csrf: false,
    }),
    deviceLink: endpoint<M.Me>()("POST", "/api/session/device-link", {
      auth: "public",
      csrf: false,
      body: z.object({ token: text(1, 128), ...deviceHint, deviceName: name }),
    }),
    /** Whether an invitation link can still be used, before the form is shown. */
    invitation: endpoint<M.InvitationCheck>()("GET", "/api/invitations/:token", { auth: "public" }),
    join: endpoint<M.Me>()("POST", "/api/session/join", {
      auth: "public",
      csrf: false,
      body: z.object({
        token: text(1, 200),
        username: z.string().check(z.regex(USERNAME)),
        password,
        ...deviceHint,
      }),
    }),
    signOut: ok("DELETE", "/api/session", { auth: "member" }),
  },

  /** First start: the administrator's account, then their choices and the total storage. See SetupState. */
  setup: {
    /** `keyRequired`: creating the administrator needs the setup key from the server's data folder. */
    status: endpoint<{ state: M.SetupState; keyRequired: boolean }>()("GET", "/api/setup", { auth: "public" }),
    /** Creates the administrator and signs them in; refused once anyone has an account. */
    account: endpoint<M.Me>()("POST", "/api/setup/account", {
      auth: "public",
      csrf: false,
      body: z.object({ username, password, ...deviceHint, setupKey: z.optional(text(1, 128)) }),
    }),
    /** Sets the total storage everyone shares and finishes setup. */
    finish: ok("POST", "/api/setup/finish", { auth: "admin", body: z.object({ capacity: quota }) }),
  },

  pickup: {
    /** Refresh an owned handoff after a deployment-wide code rotation. */
    current: endpoint<{ code: string | null }>()("POST", "/api/pickup/current", {
      auth: "member",
      body: z.object({ code: text(1, 32) }),
    }),
    config: endpoint<{ codeLength: CodeLength; protection: M.PickupProtection }>()("GET", "/api/pickup/config", {
      auth: "public",
    }),
    /** Resolves a share, request, invitation or device sign-in code to its recipient route. */
    resolve: endpoint<M.PickupResolution>()("POST", "/api/pickup", {
      auth: "public",
      csrf: false,
      body: z.object({ code: text(1, 32) }),
    }),
  },

  account: {
    /** Settings beyond the member's limits are brought within them, as `withinLimit` does. */
    update: endpoint<{ prefs: M.Prefs; user: M.User }>()("PATCH", "/api/account", {
      auth: "member",
      body: z.object({
        /** The name other people see; null or blank shows the username. */
        name: z.optional(displayName),
        /** Signing in uses the new username from then on; sessions and passkeys keep working. */
        username: z.optional(username),
        retentionDays: z.optional(retentionDays),
        trashDays: z.optional(trashDays),
        prefs: z.optional(
          z.object({
            linkDays: z.optional(linkDays),
            autoCopyLink: z.optional(z.boolean()),
            /** Only the groups given change. */
            activity: z.optional(
              z.object({
                received: z.optional(z.boolean()),
                requests: z.optional(z.boolean()),
                links: z.optional(z.boolean()),
                security: z.optional(z.boolean()),
                members: z.optional(z.boolean()),
              }),
            ),
          }),
        ),
      }),
    }),
    password: ok("POST", "/api/account/password", {
      auth: "member",
      body: z.object({ current: text(0, 256), password }),
    }),
    passkeys: endpoint<M.Passkey[]>()("GET", "/api/account/passkeys", { auth: "member" }),
    /** Re-entering the password stops a borrowed session from adding a lasting sign-in method. */
    passkeyOptions: endpoint<{ challenge: string; options: unknown }>()("POST", "/api/account/passkeys/options", {
      auth: "member",
      body: z.object({ password: text(0, 256) }),
    }),
    addPasskey: endpoint<M.Passkey>()("POST", "/api/account/passkeys", {
      auth: "member",
      body: z.object({ challenge, name, response: passkeyResponse }),
    }),
    removePasskey: ok("DELETE", "/api/account/passkeys/:id", { auth: "member" }),
  },

  loginCodes: {
    list: endpoint<M.LoginCode[]>()("GET", "/api/login-codes", { auth: "member" }),
    create: endpoint<M.NewLoginCode>()("POST", "/api/login-codes", { auth: "member" }),
    status: endpoint<M.LoginCodeStatus>()("GET", "/api/login-codes/:id/status", { auth: "member" }),
    revoke: ok("DELETE", "/api/login-codes/:id", { auth: "member" }),
  },

  devices: {
    list: endpoint<M.Device[]>()("GET", "/api/devices", { auth: "member" }),
    /** Updates the name and, when supplied, the kind its icon shows. */
    update: ok("PATCH", "/api/devices/:id", {
      auth: "member",
      body: z.object({ name, kind: z.optional(deviceKind) }),
    }),
    signOut: ok("DELETE", "/api/devices/:id", { auth: "member" }),
    signOutOthers: endpoint<{ removed: number }>()("POST", "/api/devices/sign-out-others", { auth: "member" }),
  },

  items: {
    /** A stable, bounded page of matching items; offset lets large libraries stay reachable. */
    list: endpoint<M.ItemPage>()("GET", "/api/items", {
      auth: "member",
      query: z.object({
        view: z._default(z.enum(["library", "trash"]), "library"),
        q: z._default(text(0, 200), ""),
        sort: z._default(z.enum(["new", "old", "name", "size"]), "new"),
        limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(200)), 200),
        offset: z._default(z.coerce.number().check(z.int(), z.gte(0), z.lte(2_147_483_647)), 0),
      }),
    }),
    get: endpoint<M.ItemDetail>()("GET", "/api/items/:id", { auth: "member" }),
    /**
     * What was sent never changes: files can be added to an item (see `transferInput.item`), but
     * not edited or removed. Only the item's own name and how long it is kept change here.
     */
    update: endpoint<M.ItemSummary>()("PATCH", "/api/items/:id", {
      auth: "member",
      body: z.object({
        /** Null goes back to the name derived from the contents. */
        name: z.optional(z.nullable(name)),
        retentionDays: z.optional(retentionDays),
      }),
    }),
    /** Applies one all-or-nothing operation to at most one visible page of selected items. */
    bulk: endpoint<{ updated: number }>()("POST", "/api/items/bulk", {
      auth: "member",
      body: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("retention"),
          ids: z
            .array(id)
            .check(z.minLength(1), z.maxLength(200))
            .check(z.refine((ids) => new Set(ids).size === ids.length)),
          retentionDays,
        }),
        z.object({
          operation: z.literal("trash"),
          ids: z
            .array(id)
            .check(z.minLength(1), z.maxLength(200))
            .check(z.refine((ids) => new Set(ids).size === ids.length)),
        }),
        z.object({
          operation: z.literal("restore"),
          ids: z
            .array(id)
            .check(z.minLength(1), z.maxLength(200))
            .check(z.refine((ids) => new Set(ids).size === ids.length)),
        }),
      ]),
    }),
    trash: ok("POST", "/api/items/:id/trash", { auth: "member" }),
    restore: ok("POST", "/api/items/:id/restore", { auth: "member" }),
    /** Permanent deletion; the item must already be in Trash. */
    remove: ok("DELETE", "/api/items/:id", { auth: "member" }),
    /** Deletes everything in Trash forever. */
    emptyTrash: endpoint<{ removed: number }>()("POST", "/api/trash/empty", { auth: "member" }),
  },

  transfers: {
    create: endpoint<M.TransferCreated>()("POST", "/api/transfers", { auth: "member", body: transferInput }),
    /** Idempotent. Every upload must be complete or removed. */
    complete: endpoint<M.TransferResult>()("POST", "/api/transfers/:id/complete", {
      auth: "any",
      body: z.object({ destination }),
    }),
    cancel: endpoint<M.TransferCancelled>()("POST", "/api/transfers/:id/cancel", { auth: "any" }),
    /** Skips one unfinished file of a transfer. */
    removeUpload: ok("DELETE", "/api/uploads/:id", { auth: "any" }),
    /** A page is going away: abandon its unfinished transfers now and refuse its late requests. */
    closeTab: ok("POST", "/api/tabs/:id/close", { auth: "any" }),
  },

  links: {
    list: endpoint<M.Link[]>()("GET", "/api/links", { auth: "member" }),
    create: endpoint<M.Link>()("POST", "/api/links", {
      auth: "member",
      body: z.object({ id, item: id, ...linkSettings }),
    }),
    /**
     * Changes only what is given. `days` re-dates the link from now (null: until turned off). A new
     * password locks out everyone until they enter it; null removes it. A limit below the people
     * already let in keeps them and admits nobody new.
     */
    update: endpoint<M.Link>()("PATCH", "/api/links/:id", {
      auth: "member",
      body: z.object({
        days: z.optional(linkDays),
        password: z.optional(linkPassword),
        visitorLimit: z.optional(visitorLimit),
        note: z.optional(linkNote),
      }),
    }),
    /** The people a link let in, most recent first. */
    visits: endpoint<M.LinkVisit[]>()("GET", "/api/links/:id/visits", { auth: "member" }),
    revoke: ok("DELETE", "/api/links/:id", { auth: "member" }),
    /** Lets this browser in: sets its visitor cookie, and counts it toward a limit. */
    open: endpoint<M.ShareOpen>()("GET", "/api/s/:token", { auth: "public" }),
    /** Unlocks a password-protected link for this browser. */
    unlock: endpoint<M.PublicShare>()("POST", "/api/s/:token/unlock", {
      auth: "public",
      csrf: false,
      body: z.object({ password: text(1, LIMITS.linkPasswordMax) }),
    }),
  },

  deliveries: {
    list: endpoint<M.Delivery[]>()("GET", "/api/deliveries", {
      auth: "member",
      query: z.object({ direction: z._default(z.enum(["incoming", "sent"]), "incoming") }),
    }),
    create: endpoint<M.Delivery>()("POST", "/api/deliveries", {
      auth: "member",
      body: z.object({ id, item: id, device: id }),
    }),
    /**
     * The receiving device answers. A declined delivery can still be accepted; an accepted one stays
     * accepted. `changed` says whether this call was the one that answered, so when several tabs of
     * one browser see the same arrival only one of them downloads it.
     */
    update: endpoint<{ state: M.DeliveryState; changed: boolean }>()("PATCH", "/api/deliveries/:id", {
      auth: "member",
      body: z.object({ state: z.enum(["accepted", "declined"]) }),
    }),
  },

  /** The member's own storage and activity over a range. */
  usage: endpoint<M.UsageReport>()("GET", "/api/usage", { auth: "member", query: usageQuery }),

  activity: {
    list: endpoint<M.ActivityFeed>()("GET", "/api/activity", { auth: "member" }),
    seen: ok("POST", "/api/activity/seen", {
      auth: "member",
      body: z.object({ until: int(0, Number.MAX_SAFE_INTEGER) }),
    }),
  },

  requests: {
    list: endpoint<M.UploadRequest[]>()("GET", "/api/requests", { auth: "member" }),
    create: endpoint<M.UploadRequest>()("POST", "/api/requests", {
      auth: "member",
      body: z.object({ id, name, description: requestMessage, days, maxBytes: requestBytes }),
    }),
    /**
     * Replaces an open, unexpired request's settings; its link, code and received files stay. `days`
     * re-dates it from now; null keeps its closing time. The size limit can't go below what it
     * already holds. Expired and closed requests are final.
     */
    update: endpoint<M.UploadRequest>()("PATCH", "/api/requests/:id", {
      auth: "member",
      body: z.object({
        name,
        description: text(0, LIMITS.requestMessageLength),
        days: z.nullable(days),
        maxBytes: requestBytes,
      }),
    }),
    submissions: endpoint<M.Submission[]>()("GET", "/api/requests/:id/submissions", { auth: "member" }),
    close: ok("DELETE", "/api/requests/:id", { auth: "member" }),
    open: endpoint<M.PublicRequest>()("GET", "/api/r/:token", { auth: "public" }),
    /** Issues (or re-issues) this browser's guest grant cookie for the request. */
    start: endpoint<M.GuestGrant>()("POST", "/api/r/:token/start", { auth: "public", csrf: false }),
    transfer: endpoint<M.TransferCreated>()("POST", "/api/r/:token/transfers", {
      auth: "any",
      body: z.extend(z.omit(transferInput, { text: true, retentionDays: true, name: true, item: true }), {
        /** The guest's name, optional and trimmed; blank means none. The submission keeps the first one given. */
        sender: z.optional(z.string().check(z.trim(), z.maxLength(LIMITS.senderLength))),
      }),
    }),
  },

  local: {
    /** Sets up a direct connection on the local network: the browser's offer, the helper's answer. */
    connect: endpoint<{ answer: string }>()("POST", "/api/local/connect", {
      auth: "member",
      body: z.object({ offer: text(1, LOCAL.offerBytes) }),
    }),
    /** Answers only through a direct connection, proving the whole route before it carries anything. */
    check: ok("GET", "/api/local/check", { auth: "member" }),
  },

  admin: {
    overview: endpoint<M.AdminOverview>()("GET", "/api/admin", { auth: "admin" }),
    integrity: endpoint<M.BlobStatus>()("POST", "/api/admin/integrity", {
      auth: "admin",
      body: z.object({ after: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))) }),
    }),
    /** Everyone's storage and activity over a range, and the requests the server answered. */
    usage: endpoint<M.AdminUsageReport>()("GET", "/api/admin/usage", { auth: "admin", query: usageQuery }),
    invite: endpoint<{ token: string; code: string; expires: M.Time }>()("POST", "/api/admin/invites", {
      auth: "admin",
      body: z.object({
        /** Who it is for, shown only to administrators. */
        note: z.optional(inviteNote),
        /** What the new member will be allowed; no limits when left out. */
        limits: z.optional(memberLimits),
      }),
    }),
    invites: endpoint<M.PendingInvite[]>()("GET", "/api/admin/invites", { auth: "admin" }),
    /** Changes an invitation nobody has used yet. */
    updateInvite: ok("PATCH", "/api/admin/invites/:id", {
      auth: "admin",
      body: z.strictObject({
        note: z.optional(z.nullable(inviteNote)),
        limits: z.optional(memberLimits),
        expectedLimits: z.optional(memberLimits),
      }),
    }),
    revokeInvite: ok("DELETE", "/api/admin/invites/:id", { auth: "admin" }),
    updateMember: endpoint<M.LimitsApplied>()("PATCH", "/api/admin/members/:id", {
      auth: "admin",
      body: z.strictObject({
        name: z.optional(displayName),
        username: z.optional(username),
        /**
         * New limits apply at once: the member's settings are brought within them, and links and
         * uploads that would last longer now end when the limit allows.
         */
        limits: z.optional(memberLimits),
        /** Required when changing limits: the policy shown when the editor opened. */
        expectedLimits: z.optional(memberLimits),
        disabled: z.optional(z.boolean()),
      }),
    }),
    resetPassword: ok("POST", "/api/admin/members/:id/password", { auth: "admin", body: z.object({ password }) }),
    settings: ok("PATCH", "/api/admin/settings", {
      auth: "admin",
      body: z.strictObject({
        capacity: z.optional(quota),
        /** Required when changing capacity: the value shown when the editor opened. */
        expectedCapacity: z.optional(quota),
        codeLength: z.optional(z.union([z.literal(4), z.literal(6)])),
      }),
    }),
  },
} as const;

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
  ).toString();
  return s ? `?${s}` : "";
};
/** Byte-stream endpoints. All support HEAD; content and ZIP endpoints support Range. */
export const urls = {
  nodeContent: (node: M.Id, o: { inline?: boolean } = {}) =>
    `/api/nodes/${node}/content${q({ inline: o.inline ? "1" : undefined })}`,
  nodeThumbnail: (node: M.Id, size: "s" | "l" = "s") => `/api/nodes/${node}/thumbnail${q({ size })}`,
  itemZip: (item: M.Id, folder?: M.Id) => `/api/items/${item}/zip${q({ folder })}`,
  shareContent: (token: string, node: M.Id, o: { inline?: boolean } = {}) =>
    `/api/s/${token}/nodes/${node}/content${q({ inline: o.inline ? "1" : undefined })}`,
  shareThumbnail: (token: string, node: M.Id, size: "s" | "l" = "s") =>
    `/api/s/${token}/nodes/${node}/thumbnail${q({ size })}`,
  shareZip: (token: string, folder?: M.Id) => `/api/s/${token}/zip${q({ folder })}`,
  /** tus 1.0 core protocol: HEAD and PATCH. Created by transfers.create / requests.transfer. */
  upload: (upload: M.Id) => `/uploads/${upload}`,
  /** Member event stream. Holding it open keeps `tab`'s transfers alive and the device online. */
  events: (tab: string) => `/api/events${q({ tab })}`,
  /** Guest keep-alive stream for a request page's transfers. */
  guestEvents: (token: string, tab: string) => `/api/r/${token}/events${q({ tab })}`,
  shareLink: (origin: string, token: string) => `${origin}/s/${token}`,
  requestLink: (origin: string, token: string) => `${origin}/r/${token}`,
} as const;

export const headers = {
  csrf: "X-Relay-CSRF",
  tab: "X-Relay-Tab",
  /** On every API response: where changes stood before the server began reading for it. */
  changes: "X-Relay-Changes",
} as const;
export type ApiError = { error: string };
