// Event streams over a real socket: presence (online devices), pushed changes, tab lease renewal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { api, urls } from "../shared/api.ts";
import { admin, Client, member, start, type Instance } from "./support/harness.ts";

/**
 * An open event stream, collecting the events it has received. Uses node:http without an agent so
 * no pooled or speculative sockets outlive the test.
 */
class Stream {
  readonly events: string[] = [];
  readonly status: number;
  private readonly req: ClientRequest;
  private readonly done: Promise<void>;
  private waiters: (() => void)[] = [];

  private constructor(req: ClientRequest, res: IncomingMessage) {
    this.req = req;
    this.status = res.statusCode ?? 0;
    this.done = this.read(res);
  }

  static open(base: string, path: string, client: Client) {
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return new Promise<Stream>((resolve, reject) => {
      const req = request(base + path, { agent: false, headers: cookie ? { cookie } : {} }, (res) =>
        resolve(new Stream(req, res)),
      );
      req.on("error", reject);
      req.end();
    });
  }

  private async read(res: IncomingMessage) {
    let buffer = "";
    try {
      for await (const chunk of res.setEncoding("utf8") as AsyncIterable<string>) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          this.events.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        for (const wake of this.waiters.splice(0)) wake();
      }
    } catch {
      // Destroyed by the test.
    }
    this.events.push("<closed>");
    for (const wake of this.waiters.splice(0)) wake();
  }

  async until(predicate: (events: string[]) => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) throw new Error(`Timed out; events so far: ${JSON.stringify(this.events)}`);
      await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), sleep(50)]);
    }
  }

  async close() {
    this.req.destroy();
    await this.done;
  }
}

async function listen(instance: Instance) {
  return instance.app.listen({ port: 0, host: "127.0.0.1" });
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached in time.");
    await sleep(25);
  }
}

test("a device is online exactly while it holds an event stream, and changes are pushed", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const laptop = await member(instance, "olga");
    const phone = new Client(instance);
    const phoneMe = await phone.signIn("olga", "Member-password-only", "Phone");
    const online = async () => (await laptop.call(api.devices.list)).find((d) => d.id === phoneMe.device.id)!.online;

    assert.equal(await online(), false);
    const unauthenticated = await Stream.open(base, urls.events(phone.tab), new Client(instance));
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.close();

    const first = await Stream.open(base, urls.events(phone.tab), phone);
    assert.equal(first.status, 200);
    await first.until((events) => events.some(isReady));
    assert.equal(await online(), true);

    const second = await Stream.open(base, urls.events(phone.tab), phone);
    await second.until((events) => events.length > 0);
    await first.close();
    await sleep(100);
    assert.equal(await online(), true, "still online through the second stream");

    // Something that changes the account is pushed as a coalesced change event.
    await phone.call(api.account.update, { body: { prefs: { linkDays: 2 } } });
    await second.until((events) => events.some((e) => e.startsWith("event: change") && e.includes('"account"')));

    await second.close();
    await eventually(async () => !(await online()));
  } finally {
    await instance.close();
  }
});

test("signing a device out ends its streams at once", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const laptop = await member(instance, "pia");
    const phone = new Client(instance);
    const phoneMe = await phone.signIn("pia", "Member-password-only", "Phone");
    const stream = await Stream.open(base, urls.events(phone.tab), phone);
    await stream.until((events) => events.length > 0);
    await laptop.call(api.devices.signOut, { params: { id: phoneMe.device.id } });
    await stream.until((events) => events.includes("<closed>"));
    const device = (await laptop.call(api.devices.list)).find((d) => d.id === phoneMe.device.id)!;
    assert.equal(device.online, false);
    await stream.close();
  } finally {
    await instance.close();
  }
});

const ended = (reason: string) => `event: ended\ndata: {"reason":"${reason}"}`;
const isReady = (event: string) => event.startsWith("event: ready\n");
/** The event a stream gets at least every `beatMs`, so a page can tell a cut stream from a quiet one. */
const BEAT = "event: beat\ndata: {}";

test("a stream is told why its session ended before it closes", async () => {
  const instance = await start();
  const open: Stream[] = [];
  try {
    const base = await listen(instance);
    const boss = await admin(instance);
    const tia = await member(instance, "tia", boss);
    const { user } = await tia.call(api.session.get);
    const connect = async (client: Client) => {
      const stream = await Stream.open(base, urls.events(client.tab), client);
      open.push(stream);
      await stream.until((events) => events.some(isReady));
      return stream;
    };
    const signIn = async (device: string) => {
      const client = new Client(instance);
      const me = await client.signIn("tia", "Member-password-only", device);
      return { client, me };
    };

    // Another device signs this one out.
    const phone = await signIn("Phone");
    const phoneStream = await connect(phone.client);
    await tia.call(api.devices.signOut, { params: { id: phone.me.device.id } });
    await phoneStream.until((events) => events.includes("<closed>"));
    assert.ok(phoneStream.events.includes(ended("signed-out")));

    // The member changes the password on one device: the others learn why.
    const tablet = await signIn("Tablet");
    const tabletStream = await connect(tablet.client);
    await tia.call(api.account.password, {
      body: { current: "Member-password-only", password: "Member-password-two" },
    });
    await tabletStream.until((events) => events.includes("<closed>"));
    assert.ok(tabletStream.events.includes(ended("password-changed")));

    // The administrator sets a new password.
    const tiaStream = await connect(tia);
    await boss.call(api.admin.resetPassword, { params: { id: user.id }, body: { password: "Member-password-three" } });
    await tiaStream.until((events) => events.includes("<closed>"));
    assert.ok(tiaStream.events.includes(ended("password-reset")));

    // The administrator suspends the account.
    const laptop = new Client(instance);
    await laptop.signIn("tia", "Member-password-three", "Laptop");
    const laptopStream = await connect(laptop);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: true } });
    await laptopStream.until((events) => events.includes("<closed>"));
    assert.ok(laptopStream.events.includes(ended("suspended")));

    // Another member's stream is untouched by any of it.
    const uma = await member(instance, "uma", boss);
    const umaStream = await connect(uma);
    await boss.call(api.admin.updateMember, { params: { id: user.id }, body: { disabled: false } });
    await sleep(150);
    assert.equal(umaStream.events.includes("<closed>"), false);
    assert.equal(
      umaStream.events.some((e) => e.startsWith("event: ended")),
      false,
    );
  } finally {
    for (const stream of open) await stream.close();
    await instance.close();
  }
});

test("an expired session's stream says so at the next keep-alive", async () => {
  const instance = await start({ tabLeaseMs: 600 });
  try {
    const base = await listen(instance);
    const client = await member(instance, "vic");
    const stream = await Stream.open(base, urls.events(client.tab), client);
    await stream.until((events) => events.some(isReady));
    instance.ctx.db.run("UPDATE sessions SET expires = ?", Date.now() - 1);
    await stream.until((events) => events.includes("<closed>"));
    assert.ok(stream.events.includes(ended("expired")));
    await stream.close();
  } finally {
    await instance.close();
  }
});

test("the stream keeps its tab's lease alive and re-checks the session", async () => {
  const instance = await start({ tabLeaseMs: 600 });
  try {
    const base = await listen(instance);
    const client = await member(instance, "quin");
    const lease = () =>
      instance.ctx.db.get<{ principal: string; lease_expires: number }>(
        "SELECT principal, lease_expires FROM tabs WHERE id = ?",
        client.tab,
      );
    const stream = await Stream.open(base, urls.events(client.tab), client);
    await stream.until((events) => events.length > 0);
    const first = lease();
    assert.ok(first, "connecting creates the tab lease");
    assert.match(first.principal, /^user:/);
    await stream.until((events) => events.some(isReady));
    const ready = stream.events.find(isReady)!;
    assert.deepEqual(JSON.parse(ready.split("data: ")[1]), { beatMs: 200 }, "ready says how often beats come");
    await stream.until((events) => events.filter((e) => e === BEAT).length >= 2);
    const renewed = lease()!;
    assert.ok(renewed.lease_expires > first.lease_expires, "beats renew the lease");
    assert.ok(renewed.lease_expires > Date.now());

    // Once the session is gone, the next keep-alive ends the stream.
    instance.ctx.db.run("DELETE FROM sessions");
    await stream.until((events) => events.includes("<closed>"));
    await stream.close();
  } finally {
    await instance.close();
  }
});

test("a guest's request page stream renews the guest's tab", async () => {
  const instance = await start({ tabLeaseMs: 600 });
  try {
    const base = await listen(instance);
    const owner = await member(instance, "rhea");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Photos", description: "", days: 3, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    const refused = await Stream.open(base, urls.guestEvents(request.token, guest.tab), guest);
    assert.equal(refused.status, 401);
    await refused.close();

    await guest.call(api.requests.start, { params: { token: request.token } });
    const stream = await Stream.open(base, urls.guestEvents(request.token, guest.tab), guest);
    await stream.until((events) => events.some(isReady));
    const tab = instance.ctx.db.get<{ principal: string; lease_expires: number }>(
      "SELECT principal, lease_expires FROM tabs WHERE id = ?",
      guest.tab,
    );
    assert.match(tab!.principal, /^grant:/);
    await stream.until((events) => events.includes(BEAT));

    await owner.call(api.requests.close, { params: { id: request.id } });
    await stream.until((events) => events.includes("<closed>"));
    await stream.close();
  } finally {
    await instance.close();
  }
});

test("event streams are capped per member session and guest grant, closing the oldest first", async () => {
  const instance = await start();
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "sara");
    const memberStreams: Stream[] = [];
    for (let i = 0; i < 9; i++) {
      const stream = await Stream.open(base, urls.events(owner.tab), owner);
      memberStreams.push(stream);
      streams.push(stream);
      await stream.until((events) => events.some(isReady));
    }
    await memberStreams[0].until((events) => events.includes("<closed>"));
    assert.equal(
      memberStreams.slice(1).some((stream) => stream.events.includes("<closed>")),
      false,
    );

    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Guest upload", description: "", days: 3, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    const guestStreams: Stream[] = [];
    for (let i = 0; i < 5; i++) {
      const stream = await Stream.open(base, urls.guestEvents(request.token, guest.tab), guest);
      guestStreams.push(stream);
      streams.push(stream);
      await stream.until((events) => events.some(isReady));
    }
    await guestStreams[0].until((events) => events.includes("<closed>"));
    assert.equal(
      guestStreams.slice(1).some((stream) => stream.events.includes("<closed>")),
      false,
    );
  } finally {
    for (const stream of streams) await stream.close();
    await instance.close();
  }
});
