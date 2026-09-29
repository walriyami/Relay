// Event streams over a real socket: presence (online devices), pushed changes, tab lease renewal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { api, headers, urls } from "../shared/api.ts";
import { missed, type ChangeStamp, type StreamReady } from "../shared/model.ts";
import { streamsOf } from "../server/modules/auth/streams.ts";
import { admin, ApiError, Client, member, send, start } from "./support/harness.ts";
import { eventually, listen, Stream } from "./support/event-stream.ts";

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
const readyOf = (event: string) => JSON.parse(event.split("data: ")[1]) as StreamReady;
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
    assert.equal(readyOf(ready).beatMs, 200, "ready says how often beats come");
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

test("a view read before its stream opened loads again only when something changed in between", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const client = await member(instance, "sage");
    const read = async () => {
      const res = await client.raw({ method: "GET", url: api.items.list.path });
      assert.equal(res.statusCode, 200);
      return res.headers[headers.changes.toLowerCase()] as ChangeStamp;
    };
    const opened = async () => {
      const stream = await Stream.open(base, urls.events(client.tab), client);
      await stream.until((events) => events.some(isReady));
      await stream.close();
      return readyOf(stream.events.find(isReady)!).changes;
    };

    const quiet = await read();
    assert.match(quiet, /^[\w-]+\.\d+$/);
    assert.equal(missed(quiet, await opened()), false, "nothing changed: the view is current");

    await send(client, [{ path: "note.txt", data: "hello" }]);
    const stream = await opened();
    assert.equal(missed(quiet, stream), true, "a change came before the stream: load again");
    assert.equal(missed(await read(), stream), false, "read after the stream opened");

    // Another boot counts from zero, so its stamps say nothing about this one's.
    assert.equal(missed(`other.${Number.MAX_SAFE_INTEGER}`, stream), true);
    assert.equal(missed(null, stream), true, "an answer that can't say when it was read");
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

test("stream caps reject overflow without evicting working member or guest tabs", async () => {
  const instance = await start();
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "sara");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Guest upload", description: "", days: 3, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    for (const [client, path, cap] of [
      [owner, (tab: string) => urls.events(tab), 4],
      [guest, (tab: string) => urls.guestEvents(request.token, tab), 2],
    ] as const) {
      const admitted: Stream[] = [];
      for (let i = 0; i < cap; i++) {
        const stream = await Stream.open(base, path(crypto.randomUUID()), client);
        streams.push(stream);
        admitted.push(stream);
        await stream.until((events) => events.some(isReady));
      }
      const overflowTab = crypto.randomUUID();
      const lease = () => instance.ctx.db.value<number>("SELECT lease_expires FROM tabs WHERE id = ?", overflowTab)!;
      let firstLease = 0;
      for (let i = 0; i < 3; i++) {
        const overflow = await Stream.open(base, path(overflowTab), client);
        streams.push(overflow);
        await overflow.until((events) => events.includes("<closed>"));
        assert.ok(overflow.events.some((event) => event.startsWith("event: limited")));
        assert.equal(overflow.events.some(isReady), false);
        if (!i) firstLease = lease();
        else assert.equal(lease(), firstLease, "frequent capacity probes do not write the lease again");
        assert.equal(
          admitted.some((stream) => stream.events.includes("<closed>")),
          false,
        );
      }
      await admitted[0].close();
      const replacement = await Stream.open(base, path(overflowTab), client);
      streams.push(replacement);
      await replacement.until((events) => events.some(isReady));
    }
  } finally {
    for (const stream of streams) await stream.close();
    await instance.close();
  }
});

test("one browser shares four stream slots across its member session and distinct guest grants", async () => {
  const instance = await start();
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "browsercap");
    const requests = [];
    for (let i = 0; i < 3; i++)
      requests.push(
        await owner.call(api.requests.create, {
          body: { id: crypto.randomUUID(), name: `Guest ${i}`, description: "", days: 3, maxBytes: 1000 },
        }),
      );
    for (const request of requests) await owner.call(api.requests.start, { params: { token: request.token } });
    const connect = async (path: string, admitted: boolean, browser: string | null = owner.tab) => {
      const stream = await Stream.open(base, path, owner, browser);
      streams.push(stream);
      await stream.until((events) => (admitted ? events.some(isReady) : events.includes("<closed>")));
      assert.equal(stream.events.some(isReady), admitted);
      if (!admitted) assert.ok(stream.events.some((event) => event.startsWith("event: limited")));
      return stream;
    };
    const first = await connect(urls.events(crypto.randomUUID()), true);
    await connect(urls.events(crypto.randomUUID()), true);
    await connect(urls.guestEvents(requests[0].token, crypto.randomUUID()), true);
    await connect(urls.guestEvents(requests[1].token, crypto.randomUUID()), true);
    const overflowTab = crypto.randomUUID();
    await connect(urls.guestEvents(requests[2].token, overflowTab), false);
    await connect(urls.events(crypto.randomUUID()), false);
    assert.ok(instance.ctx.db.value("SELECT lease_expires FROM tabs WHERE id = ?", overflowTab));
    assert.equal(
      streams.slice(0, 4).some((stream) => stream.events.includes("<closed>")),
      false,
    );
    await first.close();
    await connect(urls.guestEvents(requests[2].token, overflowTab), true);
    // A missing or malformed admission hint never takes a persistent socket, but keeps its lease.
    for (const browser of [null, "invalid"]) {
      const tab = crypto.randomUUID();
      await connect(urls.events(tab), false, browser);
      assert.ok(instance.ctx.db.value("SELECT lease_expires FROM tabs WHERE id = ?", tab));
    }
    assert.equal((await owner.call(api.session.get)).user.username, "browsercap");
  } finally {
    for (const stream of streams) await stream.close();
    await instance.close();
  }
});

test("one device listing validates each relevant stream once, regardless of device count", async (t) => {
  const instance = await start();
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "presence");
    const me = await owner.call(api.session.get);
    for (let i = 0; i < 30; i++) {
      instance.ctx.db.run(
        "INSERT INTO devices(id, user_id, name, kind, created, seen) VALUES(?, ?, ?, 'computer', ?, ?)",
        crypto.randomUUID(),
        me.user.id,
        `Device ${i}`,
        Date.now(),
        Date.now(),
      );
    }
    for (let i = 0; i < 3; i++) {
      const stream = await Stream.open(base, urls.events(crypto.randomUUID()), owner);
      streams.push(stream);
      await stream.until((events) => events.some(isReady));
    }
    const original = instance.ctx.db.get.bind(instance.ctx.db);
    let validations = 0;
    t.mock.method(instance.ctx.db, "get", (sql: string, ...params: Parameters<typeof original>[1][]) => {
      if (sql.includes("FROM sessions s JOIN users")) validations++;
      return original(sql, ...params);
    });
    const devices = await owner.call(api.devices.list);
    assert.equal(devices.length, 31);
    assert.equal(validations, 5, "rate-limit and route auth plus one check per stream, not per device");
    assert.equal(devices.find((device) => device.current)!.online, true);
    instance.ctx.db.run("UPDATE sessions SET expires = ?", Date.now() - 1);
    // A separate valid browser lists after expiry, proving presence does not cache credentials.
    t.mock.restoreAll();
    const other = new Client(instance);
    await other.signIn("presence", "Member-password-only", "Other");
    assert.equal((await other.call(api.devices.list)).find((device) => device.id === me.device.id)!.online, false);
    await Promise.all(streams.map((stream) => stream.until((events) => events.includes("<closed>"))));
  } finally {
    t.mock.restoreAll();
    for (const stream of streams) await stream.close();
    await instance.close();
  }
});

for (const code of ["SQLITE_FULL", "SQLITE_IOERR", "SQLITE_BUSY"]) {
  test(`${code} during a heartbeat rolls back the batch, closes streams, and recovers`, async (t) => {
    const instance = await start({ tabLeaseMs: 180_000 });
    const streams: Stream[] = [];
    try {
      const base = await listen(instance);
      const owner = await member(instance, "fault");
      const request = await owner.call(api.requests.create, {
        body: { id: crypto.randomUUID(), name: "Fault", description: "", days: 3, maxBytes: 1000 },
      });
      const guest = new Client(instance);
      await guest.call(api.requests.start, { params: { token: request.token } });
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
      const connect = async (client: Client, path: string) => {
        const stream = await Stream.open(base, path, client);
        streams.push(stream);
        await stream.until((events) => events.some(isReady));
        return stream;
      };
      const memberStream = await connect(owner, urls.events(owner.tab));
      const guestStream = await connect(guest, urls.guestEvents(request.token, guest.tab));
      const leases = () => instance.ctx.db.all("SELECT id, lease_expires FROM tabs ORDER BY id");
      const before = leases();
      const run = instance.ctx.db.run.bind(instance.ctx.db);
      let renewals = 0;
      const fault = t.mock.method(instance.ctx.db, "run", (sql: string, ...params: Parameters<typeof run>[1][]) => {
        if (sql.startsWith("UPDATE tabs SET lease_expires") && ++renewals === 2)
          throw Object.assign(new Error("injected heartbeat write failure"), { code });
        return run(sql, ...params);
      });
      t.mock.timers.tick(20_000);
      await memberStream.until((events) => events.includes(BEAT));
      assert.equal(renewals, 0, "wire beats do not write durable state");
      t.mock.timers.tick(20_000);
      await memberStream.until((events) => events.filter((event) => event === BEAT).length === 2);
      t.mock.timers.tick(20_000);
      await Promise.all(
        [memberStream, guestStream].map((stream) => stream.until((events) => events.includes("<closed>"))),
      );
      assert.deepEqual(leases(), before, "a failed batch must not acknowledge partial lease writes");
      assert.equal(
        instance.ctx.operations.snapshot().maintenance.find((stage) => stage.name === "Live connections")!.failed,
        true,
      );
      fault.mock.restore();
      t.mock.timers.tick(20_000);
      await Promise.resolve();
      const idle = instance.ctx.operations.snapshot().maintenance.find((stage) => stage.name === "Live connections")!;
      assert.equal(idle.failed, false, "an idle live-connections service recovers without another subscriber");
      assert.equal(idle.attempted, Date.now());
      assert.equal((await owner.call(api.session.get)).user.username, "fault", "the service continues answering");
      const recovered = await connect(owner, urls.events(owner.tab));
      const recoveredGuest = await connect(guest, urls.guestEvents(request.token, guest.tab));
      t.mock.timers.tick(20_000);
      await Promise.all([recovered, recoveredGuest].map((stream) => stream.until((events) => events.includes(BEAT))));
      assert.ok(leases().every((lease) => (lease as { lease_expires: number }).lease_expires > Date.now()));
      assert.equal(
        instance.ctx.operations.snapshot().maintenance.find((stage) => stage.name === "Live connections")!.failed,
        false,
      );
    } finally {
      t.mock.restoreAll();
      for (const stream of streams) await stream.close();
      t.mock.timers.reset();
      await instance.close();
    }
  });
}

test("idle heartbeat diagnostics stay fresh after all streams close without touching the database", async (t) => {
  const instance = await start();
  let stream: Stream | undefined;
  try {
    const base = await listen(instance);
    const owner = await member(instance, "idle");
    assert.equal(
      instance.ctx.operations.snapshot().maintenance.some((stage) => stage.name === "Live connections"),
      false,
    );
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    stream = await Stream.open(base, urls.events(owner.tab), owner);
    await stream.until((events) => events.some(isReady));
    t.mock.timers.tick(20_000);
    await stream.until((events) => events.includes(BEAT));
    await stream.close();
    // Let the server process the peer's close before proving the idle interval is database-free.
    await eventually(async () => (await owner.call(api.devices.list)).every((device) => !device.online));
    let queries = 0;
    for (const method of ["get", "all", "value", "run"] as const) {
      t.mock.method(instance.ctx.db, method, () => {
        queries++;
        throw new Error("Unexpected idle database work");
      });
    }
    t.mock.timers.tick(10 * 60_000);
    await Promise.resolve();
    const stage = instance.ctx.operations.snapshot().maintenance.find((entry) => entry.name === "Live connections")!;
    assert.equal(stage.attempted, Date.now());
    assert.equal(stage.failed, false);
    assert.equal(queries, 0);
  } finally {
    t.mock.restoreAll();
    await stream?.close();
    t.mock.timers.reset();
    await instance.close();
  }
});

test("durable heartbeats batch distinct leases and write each device once per minute", async (t) => {
  const instance = await start({ tabLeaseMs: 180_000 });
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "batch");
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    // Two connections to the same tab must also deduplicate that lease.
    const tabs = [owner.tab, owner.tab, crypto.randomUUID(), crypto.randomUUID()];
    for (const tab of tabs) {
      const stream = await Stream.open(base, urls.events(tab), owner);
      streams.push(stream);
      await stream.until((events) => events.some(isReady));
    }
    const run = instance.ctx.db.run.bind(instance.ctx.db);
    const tx = instance.ctx.db.tx.bind(instance.ctx.db);
    const counts = { leases: 0, devices: 0, transactions: 0 };
    t.mock.method(instance.ctx.db, "run", (sql: string, ...params: Parameters<typeof run>[1][]) => {
      if (sql.startsWith("UPDATE tabs SET lease_expires")) counts.leases++;
      if (sql.startsWith("UPDATE devices SET seen")) counts.devices++;
      return run(sql, ...params);
    });
    t.mock.method(instance.ctx.db, "tx", (work: () => unknown) => {
      counts.transactions++;
      return tx(work);
    });
    for (let beat = 1; beat <= 3; beat++) {
      t.mock.timers.tick(20_000);
      await streams[0].until((events) => events.filter((event) => event === BEAT).length === beat);
      assert.deepEqual(
        counts,
        beat < 3 ? { leases: 0, devices: 0, transactions: 0 } : { leases: 3, devices: 1, transactions: 1 },
      );
    }
    // Every stream for a closed tab is removed at renewal, including duplicate connections.
    instance.ctx.db.run("UPDATE tabs SET closed = ? WHERE id = ?", Date.now(), owner.tab);
    t.mock.timers.tick(60_000);
    await Promise.all(streams.slice(0, 2).map((stream) => stream.until((events) => events.includes("<closed>"))));
    assert.equal(
      streams.slice(2).some((stream) => stream.events.includes("<closed>")),
      false,
    );
  } finally {
    t.mock.restoreAll();
    for (const stream of streams) await stream.close();
    t.mock.timers.reset();
    await instance.close();
  }
});

test("a heartbeat validation read failure closes subscriptions and records degraded operation", async (t) => {
  const instance = await start({ tabLeaseMs: 600 });
  let stream: Stream | undefined;
  try {
    const base = await listen(instance);
    const owner = await member(instance, "readfault");
    stream = await Stream.open(base, urls.events(owner.tab), owner);
    await stream.until((events) => events.some(isReady));
    const get = instance.ctx.db.get.bind(instance.ctx.db);
    t.mock.method(instance.ctx.db, "get", (sql: string, ...params: Parameters<typeof get>[1][]) => {
      if (sql.includes("FROM sessions s JOIN users"))
        throw Object.assign(new Error("injected read failure"), { code: "SQLITE_IOERR" });
      return get(sql, ...params);
    });
    await stream.until((events) => events.includes("<closed>"));
    assert.equal(
      instance.ctx.operations.snapshot().maintenance.find((stage) => stage.name === "Live connections")!.failed,
      true,
    );
    t.mock.restoreAll();
    assert.equal((await owner.call(api.session.get)).user.username, "readfault");
  } finally {
    t.mock.restoreAll();
    await stream?.close();
    await instance.close();
  }
});

test("overflow probes renew leases only when due and cannot renew after member or guest revocation", async (t) => {
  const instance = await start({ tabLeaseMs: 180_000 });
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const owner = await member(instance, "overflow");
    const request = await owner.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Overflow", description: "", days: 3, maxBytes: 1000 },
    });
    const guest = new Client(instance);
    await guest.call(api.requests.start, { params: { token: request.token } });
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    for (const [client, path, cap, revoke] of [
      [owner, (tab: string) => urls.events(tab), 4, () => instance.ctx.db.run("DELETE FROM sessions")],
      [
        guest,
        (tab: string) => urls.guestEvents(request.token, tab),
        2,
        () => instance.ctx.db.run("DELETE FROM guest_grants"),
      ],
    ] as const) {
      for (let i = 0; i < cap; i++) {
        const stream = await Stream.open(base, path(crypto.randomUUID()), client);
        streams.push(stream);
        await stream.until((events) => events.some(isReady));
      }
      const tab = crypto.randomUUID();
      const lease = () => instance.ctx.db.value<number>("SELECT lease_expires FROM tabs WHERE id = ?", tab)!;
      const probe = async (status = 200) => {
        const stream = await Stream.open(base, path(tab), client);
        streams.push(stream);
        await stream.until((events) => events.includes("<closed>"));
        assert.equal(stream.status, status);
        if (status === 200) assert.ok(stream.events.some((event) => event.startsWith("event: limited")));
      };
      await probe();
      const first = lease();
      t.mock.timers.tick(20_000);
      await probe();
      assert.equal(lease(), first);
      t.mock.timers.tick(40_000);
      await probe();
      assert.equal(lease(), first + 60_000);
      revoke();
      t.mock.timers.tick(60_000);
      await probe(401);
      assert.equal(lease(), first + 60_000, "a revoked credential cannot extend its overflow tab lease");
    }
  } finally {
    for (const stream of streams) await stream.close();
    t.mock.timers.reset();
    await instance.close();
  }
});

test("authenticated polling presence renews without a socket and expires after probes stop", async (t) => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const laptop = await member(instance, "polling");
    const phone = new Client(instance);
    const phoneMe = await phone.signIn("polling", "Member-password-only", "Polling phone");
    const { result } = await send(laptop, [{ path: "poll.txt", data: "delivered by polling" }]);
    const online = async () => (await laptop.call(api.devices.list)).find((d) => d.id === phoneMe.device.id)!.online;
    const deliver = () =>
      laptop.call(api.deliveries.create, {
        body: { id: crypto.randomUUID(), item: result.itemId, device: phoneMe.device.id },
      });
    const probe = async (status = 200) => {
      const stream = await Stream.open(base, urls.events(phone.tab), phone, null);
      await stream.until((events) => events.includes("<closed>"));
      assert.equal(stream.status, status);
      assert.equal(stream.events.some(isReady), false);
      if (status === 200) assert.ok(stream.events.some((event) => event.startsWith("event: limited")));
      await stream.close();
    };
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    assert.equal(await online(), false);
    await probe();
    assert.equal(await online(), true);
    const delivered = await deliver();
    assert.ok((await phone.call(api.deliveries.list)).some((delivery) => delivery.id === delivered.id));

    // Twenty-second polls add up to 20% jitter. Successful probes extend presence independently
    // of the slower durable-write cadence; the timer itself never extends polling presence.
    t.mock.timers.tick(24_000);
    await probe();
    t.mock.timers.tick(49_999);
    assert.equal(await online(), true);
    t.mock.timers.tick(1);
    assert.equal(await online(), false);
    await assert.rejects(deliver(), (error: unknown) => error instanceof ApiError && error.status === 409);

    await probe();
    assert.equal(await online(), true);
    // A closed tab's rejected request cannot extend reachability.
    t.mock.timers.tick(24_000);
    instance.ctx.db.run("UPDATE tabs SET closed = ? WHERE id = ?", Date.now(), phone.tab);
    await probe(409);
    t.mock.timers.tick(26_000);
    assert.equal(await online(), false);
  } finally {
    t.mock.timers.reset();
    await instance.close();
  }
});

for (const revoke of ["sign-out", "expiry", "suspension"] as const) {
  test(`polling presence loses delivery eligibility immediately on ${revoke}`, async () => {
    const instance = await start();
    try {
      const base = await listen(instance);
      const laptop = await member(instance, "pollrevoke");
      const phone = new Client(instance);
      const me = await phone.signIn("pollrevoke", "Member-password-only", "Polling phone");
      const { result } = await send(laptop, [{ path: "poll.txt", data: "polling revocation" }]);
      const probe = await Stream.open(base, urls.events(phone.tab), phone, null);
      await probe.until((events) => events.includes("<closed>"));
      assert.equal(probe.status, 200);
      await probe.close();
      if (revoke === "sign-out") await laptop.call(api.devices.signOut, { params: { id: me.device.id } });
      else if (revoke === "expiry")
        instance.ctx.db.run("UPDATE sessions SET expires = ? WHERE device_id = ?", Date.now(), me.device.id);
      else instance.ctx.db.run("UPDATE users SET disabled = 1 WHERE id = ?", me.user.id);
      // Direct delivery creation also revalidates presence; it cannot use a cached online answer.
      assert.throws(
        () =>
          instance.ctx.deliveries.create(me.user.id, null, {
            id: crypto.randomUUID(),
            item: result.itemId,
            device: me.device.id,
          }),
        /That device is not online/,
      );
      const refused = await Stream.open(base, urls.events(phone.tab), phone, null);
      await refused.until((events) => events.includes("<closed>"));
      assert.equal(refused.status, 401);
      await refused.close();
      if (revoke !== "suspension")
        assert.equal((await laptop.call(api.devices.list)).find((d) => d.id === me.device.id)!.online, false);
    } finally {
      await instance.close();
    }
  });
}

test("guests filling all browser slots do not prevent a polling member from receiving deliveries", async () => {
  const instance = await start();
  const streams: Stream[] = [];
  try {
    const base = await listen(instance);
    const laptop = await member(instance, "guestfirst");
    const phone = new Client(instance);
    const me = await phone.signIn("guestfirst", "Member-password-only", "Polling phone");
    for (let i = 0; i < 2; i++) {
      const request = await laptop.call(api.requests.create, {
        body: { id: crypto.randomUUID(), name: `First guest ${i}`, description: "", days: 3, maxBytes: 1000 },
      });
      await phone.call(api.requests.start, { params: { token: request.token } });
      for (let j = 0; j < 2; j++) {
        const stream = await Stream.open(base, urls.guestEvents(request.token, crypto.randomUUID()), phone);
        streams.push(stream);
        await stream.until((events) => events.some(isReady));
      }
    }
    const online = async () => (await laptop.call(api.devices.list)).find((d) => d.id === me.device.id)!.online;
    assert.equal(await online(), false, "guest streams cannot create member presence");
    const probe = await Stream.open(base, urls.events(phone.tab), phone);
    await probe.until((events) => events.includes("<closed>"));
    assert.ok(probe.events.some((event) => event.startsWith("event: limited")));
    await probe.close();
    assert.equal(await online(), true);
    assert.equal(
      streams.some((stream) => stream.events.includes("<closed>")),
      false,
    );
    const { result } = await send(laptop, [{ path: "poll.txt", data: "guest-first delivery" }]);
    const delivery = await laptop.call(api.deliveries.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, device: me.device.id },
    });
    assert.ok((await phone.call(api.deliveries.list)).some((incoming) => incoming.id === delivery.id));
  } finally {
    for (const stream of streams) await stream.close();
    await instance.close();
  }
});

test("polling presence keeps per-device counts and expires a batch in linear work", async (t) => {
  const instance = await start();
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    const streams = streamsOf(instance.ctx);
    const probe = (session: string, device: string) =>
      streams.probe({
        userId: "presence-owner",
        deviceId: device,
        capKey: session,
        ended: () => null,
      });
    probe("first", "shared");
    t.mock.timers.tick(24_000);
    probe("second", "shared");
    probe("second", "shared");
    t.mock.timers.tick(26_000);
    assert.equal(streams.online("shared"), true, "the later session survives the first expiry");
    probe("second", "replacement");
    assert.equal(streams.online("shared"), false, "replacement removes only the old device's presence");
    assert.equal(streams.online("replacement"), true);
    streams.closeAll();
    assert.equal(streams.online("replacement"), false, "shutdown/failure cannot leave device counts behind");

    // Repeated probes replace one session's lease; they must not accumulate device references.
    for (let i = 0; i < 1000; i++) {
      probe(`batch-${i}`, `device-${i % 10}`);
      probe(`batch-${i}`, `device-${i % 10}`);
    }
    // Freeze interval processing to measure the lazy validation used by an actual presence lookup.
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 100_000 });
    let traversals = 0;
    // The replacement explicitly preserves the Map receiver below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const values = Map.prototype.values;
    t.mock.method(Map.prototype, "values", function (this: Map<unknown, unknown>) {
      traversals++;
      return values.call(this);
    });
    const online = streams.online("device-0");
    t.mock.restoreAll();
    assert.equal(online, false);
    assert.ok(traversals <= 2, `Expiry rescanned a map ${traversals} times for 1000 sessions`);
    assert.equal(streams.presence("presence-owner").size, 0);
    for (let i = 0; i < 10; i++) assert.equal(streams.online(`device-${i}`), false);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
    await instance.close();
  }
});
