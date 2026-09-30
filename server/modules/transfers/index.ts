import { LIMITS } from "../../../shared/model.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { api } from "../../../shared/api.ts";
import type { Context, Transfers } from "../../context.ts";
import { authOf, currentPrincipalFor, principalFor } from "../../lib/auth.ts";
import { fail, notFound } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { createTransfer } from "./create.ts";
import {
  cancel,
  cancelForItem,
  cancelForRequest,
  closeTab,
  complete,
  ownTransfer,
  recover,
  removeUpload,
  renewTab,
  sweep,
} from "./lifecycle.ts";
import { Receivers, uploadRow } from "./receivers.ts";
import { registerTus } from "./tus.ts";

const receiversByContext = new WeakMap<Context, Receivers>();

export function createTransfers(ctx: Context): Transfers {
  const receivers = new Receivers(ctx);
  receiversByContext.set(ctx, receivers);
  const count = (sql: string) =>
    ctx.db.value<number>(
      `SELECT ${sql} FROM uploads u JOIN transfers t ON t.id = u.transfer
       WHERE u.completed IS NULL AND u.node IS NOT NULL AND t.state = 'open'`,
    )!;
  return {
    create: (input, options) => createTransfer(ctx, input, options),
    renewTab: (tab, principal) => renewTab(ctx, tab, principal),
    cancelForItem: (itemId, principal) => cancelForItem(ctx, receivers, itemId, principal),
    cancelForRequest: (requestId) => cancelForRequest(ctx, receivers, requestId),
    outstandingBytes: () => count("coalesce(sum(u.size - u.offset), 0)"),
    activeUploads: () => count("count(*)"),
    receivedBytesSince: (time) => receivers.receivedSince(time),
    sweep: (now) => sweep(ctx, receivers, now),
    recover: () => recover(ctx, receivers),
  };
}

export function registerTransfers(app: FastifyInstance, ctx: Context) {
  const receivers = receiversByContext.get(ctx)!;
  const principalOf = (req: FastifyRequest) => (key: string) => principalFor(ctx, req, key);

  route(
    app,
    ctx,
    api.transfers.create,
    // Adding to an existing item keeps it as it is; creating checks it is the member's and in Files.
    ({ member, body }) =>
      ctx.transfers.create(body, {
        owner: member.userId,
        principal: member,
        ...(body.item ? { itemId: body.item } : {}),
      }),
    { bodyLimit: LIMITS.manifestBytes },
  );
  route(app, ctx, api.transfers.complete, ({ req, params, body }) => {
    const { transfer, principal } = ownTransfer(ctx, principalOf(req), params.id);
    return complete(ctx, receivers, transfer, principal, body.destination, () => {
      if (!currentPrincipalFor(ctx, req, transfer.principal)) fail(401, "Sign in to continue.");
    });
  });
  route(app, ctx, api.transfers.cancel, ({ req, params }) =>
    cancel(ctx, receivers, ownTransfer(ctx, principalOf(req), params.id).transfer),
  );
  route(app, ctx, api.transfers.removeUpload, ({ req, params }) => {
    const upload = uploadRow(ctx, params.id);
    if (!upload || !principalFor(ctx, req, upload.principal)) return notFound("That upload");
    removeUpload(ctx, receivers, upload);
    return { ok: true as const };
  });
  route(app, ctx, api.transfers.closeTab, ({ req, params }) => {
    const auth = authOf(ctx, req);
    const caller = auth.member ?? auth.grants[0] ?? fail(401, "Sign in to continue.");
    closeTab(ctx, receivers, principalOf(req), params.id, caller);
    return { ok: true as const };
  });

  registerTus(app, ctx, receivers);
  app.addHook("preClose", () => receivers.close());
}
