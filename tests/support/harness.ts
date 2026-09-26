// In-process test harness: a disposable Relay instance and typed clients that keep cookies and CSRF.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp, type App } from "../../server/app.ts";
import type { Config } from "../../server/config.ts";
import { api, type Endpoint, type Input, type Response } from "../../shared/api.ts";
import type { Destination, Me, PublicShare } from "../../shared/model.ts";
import { testConfig } from "./config.ts";

export type Instance = App & { root: string; close: () => Promise<void> };

export const ADMIN_PASSWORD = "Test-admin-password-only";

/**
 * A disposable instance, already set up with the administrator "admin" and the built-in member
 * values, as most tests expect. `setup: false` leaves it as a first start finds it.
 */
export async function start(
  overrides: Partial<Config> = {},
  root?: string,
  { setup = true }: { setup?: boolean } = {},
): Promise<Instance> {
  const dir = root ?? (await mkdtemp(join(tmpdir(), "relay-test-")));
  const built = await buildApp(testConfig(dir, overrides));
  const instance: Instance = {
    ...built,
    root: dir,
    close: async () => {
      await built.app.close();
      if (!root) await rm(dir, { recursive: true, force: true });
    },
  };
  if (setup) await setUp(instance, ADMIN_PASSWORD);
  return instance;
}

/**
 * Sets up a first start as a browser would, keeping the built-in member values, then removes the
 * setup browser's device, session and sign-in so tests begin with no devices. Does nothing on an
 * instance that is already set up.
 */
export async function setUp(instance: Pick<App, "app" | "ctx">, password: string) {
  const client = new Client(instance as Instance);
  if ((await client.call(api.setup.status)).state !== "account") return;
  await client.call(api.setup.account, { body: { username: "admin", password, deviceName: "Setup" } });
  const { defaults, limits } = await client.call(api.admin.overview);
  await client.call(api.setup.finish, { body: { ...defaults, capacity: limits.capacity } });
  const { db } = instance.ctx;
  db.tx(() => {
    for (const table of ["sessions", "devices", "activity"]) db.run(`DELETE FROM ${table}`);
  });
}
/** Closes the app but keeps its directory, to start it again as a "restart". */
export async function stop(instance: Instance) {
  await instance.app.close();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
    this.status = status;
  }
}

/** One browser: a cookie jar, the CSRF token it learned, and its tab id. */
export class Client {
  readonly instance: Instance;
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly tab = crypto.randomUUID().replaceAll("-", "");
  constructor(instance: Instance) {
    this.instance = instance;
  }

  async raw(options: InjectOptions): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.csrf && !headers["x-relay-csrf"]) headers["x-relay-csrf"] = this.csrf;
    const res = await this.instance.app.inject({ ...options, headers });
    for (const cookie of res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const expired = cookie.maxAge === 0 || (cookie.expires && cookie.expires.getTime() <= Date.now());
      if (expired || !cookie.value) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return res;
  }

  /** Calls a contract endpoint and returns its typed response, throwing ApiError on failure. */
  async call<E extends Endpoint>(endpoint: E, input: Input<E> = {} as Input<E>): Promise<Response<E>> {
    const { params, query, body } = input as {
      params?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
    };
    let url: string = endpoint.path;
    for (const [key, value] of Object.entries(params ?? {})) url = url.replace(`:${key}`, encodeURIComponent(value));
    const res = await this.raw({
      method: endpoint.method,
      url,
      query: query ? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) : undefined,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const data = res.body ? res.json<{ error?: string }>() : undefined;
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, data?.error ?? res.body);
    if ((data as Partial<Me>)?.csrf && typeof (data as Me).csrf === "string") this.csrf = (data as Me).csrf;
    return data as Response<E>;
  }

  async signIn(username: string, password: string, deviceName = "Test browser") {
    return this.call(api.session.password, { body: { username, password, deviceName } });
  }
}

export async function admin(instance: Instance) {
  const client = new Client(instance);
  await client.signIn("admin", ADMIN_PASSWORD);
  return client;
}

/** Creates a member through an admin invitation and returns a client signed in as them. */
export async function member(instance: Instance, username: string, adminClient?: Client) {
  const inviter = adminClient ?? (await admin(instance));
  const { token } = await inviter.call(api.admin.invite);
  const client = new Client(instance);
  await client.call(api.session.join, {
    body: { token, username, password: "Member-password-only", deviceName: `${username} browser` },
  });
  return client;
}

/** Sends one tus PATCH of `data` at `offset`. */
export async function patchUpload(client: Client, upload: string, offset: number, data: Buffer) {
  return client.raw({
    method: "PATCH",
    url: `/uploads/${upload}`,
    headers: {
      "tus-resumable": "1.0.0",
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
    },
    payload: data,
  });
}

/** Creates a transfer from in-memory files, uploads everything, and completes it. */
export async function send(
  client: Client,
  files: { path: string; data: Buffer | string; mime?: string }[],
  options: {
    text?: string;
    name?: string | null;
    /** Adds the files to this existing item. */
    item?: string;
    destination?: Destination;
  } = {},
) {
  const buffers = files.map((f) => ({ ...f, data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data) }));
  const created = await client.call(api.transfers.create, {
    body: {
      id: crypto.randomUUID(),
      tab: client.tab,
      name: options.name ?? null,
      ...(options.item ? { item: options.item } : {}),
      text: options.text,
      folders: [],
      files: buffers.map((f) => ({ path: f.path, size: f.data.length, mime: f.mime ?? "application/octet-stream" })),
    },
  });
  for (const [i, upload] of created.uploads.entries()) {
    const data = buffers[i].data;
    if (!data.length) continue;
    const res = await patchUpload(client, upload.id, 0, data);
    if (res.statusCode !== 204) throw new ApiError(res.statusCode, res.body);
  }
  const result = await client.call(api.transfers.complete, {
    params: { id: created.id },
    body: { destination: options.destination ?? { kind: "save" } },
  });
  return { created, result };
}

/** Opens a share page's link, which must not be locked. */
export async function openShare(client: Client, token: string): Promise<PublicShare> {
  const share = await client.call(api.links.open, { params: { token } });
  if (share.locked) throw new Error("The link is locked.");
  return share;
}
