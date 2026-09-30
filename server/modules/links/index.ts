import type { FastifyInstance } from "fastify";
import type { Context, ShareAccess } from "../../context.ts";
import type { PublicShare, ShareOpen } from "../../../shared/model.ts";
import { api } from "../../../shared/api.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { getPickupCode, issueUrlPickupCode } from "../../lib/pickup-codes.ts";
import { hashPassword } from "../../lib/secrets.ts";
import { memberFromToken, sessionCookie } from "../../lib/auth.ts";
import { perAddress } from "../auth/limits.ts";
import { allowedLinkDays } from "../auth/member-limits.ts";
import { publicName } from "../auth/sessions.ts";
import {
  effectiveLinkExpiry,
  LINK_SELECT,
  linkExpiry,
  linkVisits,
  ownedLink,
  toLinks,
  type LinkRow,
} from "./service.ts";

export { createLinks } from "./service.ts";

/** Hashes a new link password; null removes it, undefined leaves it as it is. */
export const linkPasswordHash = async (password: string | null | undefined) =>
  password === undefined ? undefined : password === null ? null : await hashPassword(password);

export function registerLinks(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.links.list, ({ member }) => {
    const now = Date.now();
    const rows = ctx.db.all<LinkRow>(`${LINK_SELECT} WHERE l.owner = ? ORDER BY l.created DESC`, now, member.userId);
    return toLinks(ctx, rows, now);
  });

  route(app, ctx, api.links.create, async ({ member, body, req }) => {
    const { password, ...settings } = body;
    const passwordHash = await linkPasswordHash(password);
    if (memberFromToken(ctx, req.cookies[sessionCookie(ctx, req)])?.sessionHash !== member.sessionHash)
      fail(401, "Sign in to continue.");
    return ctx.links.create(member.userId, { ...settings, passwordHash });
  });

  route(app, ctx, api.links.update, async ({ member, params, body, req }) => {
    const passwordHash = await linkPasswordHash(body.password);
    const updated = ctx.db.tx(() => {
      if (memberFromToken(ctx, req.cookies[sessionCookie(ctx, req)])?.sessionHash !== member.sessionHash)
        fail(401, "Sign in to continue.");
      const now = Date.now();
      const link = ownedLink(ctx, member.userId, params.id, now);
      if (link.revoked !== null) fail(410, "This link was turned off. Create a new link instead.");
      if (link.expires !== null && link.expires <= now) fail(410, "This link has expired. Create a new link instead.");
      const item = ctx.library.owned(member.userId, link.item, { live: true });
      if (body.days !== undefined)
        ctx.db.run(
          "UPDATE links SET expires = ? WHERE id = ?",
          effectiveLinkExpiry(linkExpiry(allowedLinkDays(ctx, member.userId, body.days), now), item.expires),
          link.id,
        );
      if (passwordHash !== undefined)
        ctx.db.run("UPDATE links SET password_hash = ? WHERE id = ?", passwordHash, link.id);
      if (body.visitorLimit !== undefined)
        ctx.db.run("UPDATE links SET visitor_limit = ? WHERE id = ?", body.visitorLimit, link.id);
      if (body.note !== undefined) ctx.db.run("UPDATE links SET note = ? WHERE id = ?", body.note, link.id);
      if (!getPickupCode(ctx.db, ctx.secrets, "share", link.id)) {
        const issued = issueUrlPickupCode(ctx.db, ctx.secrets, "share", link.id);
        ctx.db.run("UPDATE links SET code_hash = ? WHERE id = ?", issued.codeHash, link.id);
      }
      return toLinks(ctx, [ownedLink(ctx, member.userId, link.id, now)], now)[0];
    });
    ctx.events.publish(member.userId, "links", "items");
    return updated;
  });

  route(app, ctx, api.links.visits, ({ member, params }) => linkVisits(ctx, member.userId, params.id));

  route(app, ctx, api.links.revoke, ({ member, params }) => {
    const link = ownedLink(ctx, member.userId, params.id);
    ctx.db.run("UPDATE links SET revoked = ? WHERE id = ? AND revoked IS NULL", Date.now(), link.id);
    ctx.events.publish(member.userId, "links", "items");
    return { ok: true as const };
  });

  /** What the share page shows once the browser is let in. */
  const share = (access: ShareAccess): PublicShare => {
    const summary =
      ctx.library.summaries([access.itemId]).get(access.itemId) ??
      fail(410, "The content of this link is no longer available.");
    const ends = [access.expires, summary.expires].filter((t): t is number => t !== null);
    return {
      from: publicName(ctx, access.owner),
      name: summary.name,
      note: access.note,
      expires: ends.length ? Math.min(...ends) : null,
      files: summary.files,
      texts: summary.texts,
      bytes: summary.bytes,
      nodes: ctx.library.nodes(access.itemId),
    };
  };

  route(app, ctx, api.links.open, ({ req, reply, params }): ShareOpen => {
    const access = ctx.links.open(params.token, req, reply);
    return access.locked ? { locked: true, from: publicName(ctx, access.owner) } : share(access);
  });

  route(
    app,
    ctx,
    api.links.unlock,
    async ({ req, reply, params, body }) => share(await ctx.links.unlock(params.token, body.password, req, reply)),
    { rateLimit: perAddress(20, "1 minute") },
  );
}
