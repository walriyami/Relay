import type { FastifyInstance } from "fastify";
import { api } from "../../../shared/api.ts";
import type { Context, Library } from "../../context.ts";
import { route } from "../../lib/http.ts";
import {
  bulkItems,
  emptyTrash,
  isLive,
  itemDetail,
  listItems,
  nodes,
  owned,
  purge,
  removeItem,
  restoreItem,
  summaries,
  sweep,
  trashItem,
  updateItem,
} from "./items.ts";

export function createLibrary(ctx: Context): Library {
  return {
    owned: (owner, itemId, options) => owned(ctx, owner, itemId, options),
    isLive,
    summaries: (itemIds) => summaries(ctx, itemIds),
    nodes: (itemId) => nodes(ctx, itemId),
    trash: (owner, itemId) => trashItem(ctx, owner, itemId),
    purge: (itemId) => purge(ctx, itemId),
    sweep: (now) => sweep(ctx, now),
  };
}

const ok = { ok: true as const };

export function registerLibrary(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.items.list, ({ member, query }) => listItems(ctx, member.userId, query));
  route(app, ctx, api.items.get, ({ member, params }) => itemDetail(ctx, member.userId, params.id));
  route(app, ctx, api.items.update, ({ member, params, body }) => updateItem(ctx, member.userId, params.id, body));
  route(app, ctx, api.items.bulk, ({ member, body }) => bulkItems(ctx, member.userId, body));
  route(app, ctx, api.items.trash, ({ member, params }) => (trashItem(ctx, member.userId, params.id), ok));
  route(app, ctx, api.items.restore, ({ member, params }) => (restoreItem(ctx, member.userId, params.id), ok));
  route(app, ctx, api.items.remove, ({ member, params }) => (removeItem(ctx, member.userId, params.id), ok));
  route(app, ctx, api.items.emptyTrash, ({ member }) => emptyTrash(ctx, member.userId));
}
