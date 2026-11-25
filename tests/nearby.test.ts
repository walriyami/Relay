// Nearby: who is present, who may reach whom, signals passed along, and guests with a Nearby code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { api, urls } from "../shared/api.ts";
import { localCandidates } from "../shared/candidates.ts";
import { NEARBY, type NearbyEvent, type NearbySignal } from "../shared/nearby.ts";
import { hubOf, networkOf } from "../server/modules/nearby/hub.ts";
import { ApiError, Client, member, start, type Instance } from "./support/harness.ts";
import { eventually, listen, Stream } from "./support/event-stream.ts";

const offer = (session = "session-1"): NearbySignal => ({ kind: "offer", session, sdp: "v=0 offer" });

/** The Nearby events a stream has carried so far. */
const nearbyEvents = (stream: Stream) =>
  stream.events
    .filter((event) => event.startsWith("event: nearby\n"))
    .map((event) => JSON.parse(event.slice(event.indexOf("data: ") + 6)) as NearbyEvent);

/** Opens `client`'s member stream and makes its device present in Nearby through it. */
async function present(base: string, client: Client) {
  const stream = await Stream.open(base, urls.events(client.tab), client);
  await stream.until((events) => events.some((event) => event.startsWith("event: ready")));
  await client.call(api.nearby.present, { body: { tab: client.tab } });
  return stream;
}

async function signIn(instance: Instance, username: string, device: string) {
  const client = new Client(instance);
  const me = await client.signIn(username, "Member-password-only", device);
  return { client, id: me.device.id };
}

const rejects = async (promise: Promise<unknown>, status: number) =>
  assert.rejects(promise, (error) => error instanceof ApiError && error.status === status);

test("networks are told apart by public address, with Relay's own networks as one", () => {
  assert.equal(networkOf("203.0.113.5"), "203.0.113.5");
  assert.equal(networkOf("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(networkOf("2001:db8:1:2:aaaa::1"), networkOf("2001:db8:1:2:bbbb::2"));
  assert.notEqual(networkOf("2001:db8:1:2::1"), networkOf("2001:db8:1:3::1"));
  for (const own of ["192.168.1.20", "10.0.0.3", "172.20.1.1", "127.0.0.1", "169.254.3.4", "fd00::5", "fe80::1", "::1"])
    assert.equal(networkOf(own), "local", own);
  // Shared address space is not one network: its users can be anywhere.
  assert.equal(networkOf("100.64.1.2"), "100.64.1.2");
});

test("a member's own devices always appear, and are present while one of their tabs holds Nearby", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const laptop = await member(instance, "olga");
    const laptopId = (await laptop.call(api.session.get)).device.id;
    const phone = await signIn(instance, "olga", "Phone");

    const before = await laptop.call(api.nearby.get);
    assert.equal(before.self, laptopId);
    assert.deepEqual(
      before.peers.map((peer) => [peer.name, peer.kind, peer.present]),
      [["Phone", "device", false]],
    );
    assert.equal(before.visible, true);

    // A tab without an open stream can't be present.
    await rejects(phone.client.call(api.nearby.present, { body: { tab: phone.client.tab } }), 409);

    const laptopStream = await present(base, laptop);
    const phoneStream = await present(base, phone.client);
    await laptopStream.until((events) => events.some((e) => e.startsWith("event: change") && e.includes('"nearby"')));
    assert.equal((await laptop.call(api.nearby.get)).peers[0].present, true);

    await laptop.call(api.nearby.signal, { body: { to: phone.id, signal: offer() } });
    await phoneStream.until(() => nearbyEvents(phoneStream).some((event) => event.type === "signal"));
    assert.deepEqual(nearbyEvents(phoneStream), [{ type: "signal", from: laptopId, signal: offer() }]);

    // A second tab of the phone takes over; the first is told.
    const otherTab = new Client(instance);
    for (const [name, value] of phone.client.cookies) otherTab.cookies.set(name, value);
    otherTab.csrf = phone.client.csrf;
    const otherStream = await present(base, otherTab);
    await phoneStream.until(() => nearbyEvents(phoneStream).some((event) => event.type === "replaced"));
    await laptop.call(api.nearby.signal, { body: { to: phone.id, signal: offer("session-2") } });
    await otherStream.until(() => nearbyEvents(otherStream).some((event) => event.type === "signal"));

    // Closing the tab that holds it leaves Nearby.
    await otherStream.close();
    await eventually(async () => !(await laptop.call(api.nearby.get)).peers[0].present);
    await rejects(laptop.call(api.nearby.signal, { body: { to: phone.id, signal: offer() } }), 404);

    // Signing out removes the device from the list.
    await laptop.call(api.devices.signOut, { params: { id: phone.id } });
    assert.deepEqual((await laptop.call(api.nearby.get)).peers, []);
    await Promise.all([laptopStream.close(), phoneStream.close()]);
  } finally {
    await instance.close();
  }
});

test("other members appear only when both are visible on the same network", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const olga = await member(instance, "olga");
    const pia = await member(instance, "pia");
    const piaId = (await pia.call(api.session.get)).device.id;
    olga.address = "203.0.113.5";
    pia.address = "203.0.113.5";
    const streams = [await present(base, olga), await present(base, pia)];

    const seen = await olga.call(api.nearby.get);
    assert.deepEqual(
      seen.peers.map((peer) => [peer.kind, peer.name, peer.owner, peer.present]),
      [["member", "pia browser", "pia", true]],
    );
    await olga.call(api.nearby.signal, { body: { to: piaId, signal: offer() } });

    // Hiding goes both ways: pia sees nobody, and nobody sees pia.
    await pia.call(api.account.update, { body: { prefs: { nearbyVisible: false } } });
    assert.deepEqual((await olga.call(api.nearby.get)).peers, []);
    assert.equal((await pia.call(api.nearby.get)).visible, false);
    assert.deepEqual((await pia.call(api.nearby.get)).peers, []);
    await rejects(olga.call(api.nearby.signal, { body: { to: piaId, signal: offer() } }), 404);
    await pia.call(api.account.update, { body: { prefs: { nearbyVisible: true } } });

    // On another network, pia is not there for olga.
    pia.address = "198.51.100.7";
    await pia.call(api.nearby.present, { body: { tab: pia.tab } });
    assert.deepEqual((await olga.call(api.nearby.get)).peers, []);
    await rejects(olga.call(api.nearby.signal, { body: { to: piaId, signal: offer() } }), 404);

    // Relay's own network is one network, whatever each device's address on it.
    olga.address = "192.168.1.20";
    pia.address = "10.0.0.3";
    await olga.call(api.nearby.present, { body: { tab: olga.tab } });
    await pia.call(api.nearby.present, { body: { tab: pia.tab } });
    assert.equal((await olga.call(api.nearby.get)).peers.length, 1);
    await Promise.all(streams.map((stream) => stream.close()));
  } finally {
    await instance.close();
  }
});

test("a Nearby code lets a guest reach the member's devices, and nothing else", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const olga = await member(instance, "olga");
    const olgaId = (await olga.call(api.session.get)).device.id;
    const pia = await member(instance, "pia");
    const piaId = (await pia.call(api.session.get)).device.id;
    const olgaStream = await present(base, olga);
    const piaStream = await present(base, pia);

    const invite = await olga.call(api.nearby.invite);
    assert.deepEqual(await olga.call(api.nearby.invite), invite, "one code at a time");
    const guest = new Client(instance);
    const resolved = await guest.call(api.pickup.resolve, { body: { code: invite.code } });
    assert.deepEqual(resolved, { kind: "nearby", path: `/n/${invite.token}` });

    const unjoined = await guest.call(api.nearby.guest, { params: { token: invite.token } });
    assert.equal(unjoined.host, "olga");
    assert.equal(unjoined.self, null);
    assert.deepEqual(unjoined.peers, []);
    const noCookie = await Stream.open(base, urls.nearbyEvents(invite.token), guest);
    assert.equal(noCookie.status, 401);
    await noCookie.close();

    const joined = await guest.call(api.nearby.join, {
      params: { token: invite.token },
      body: { name: "  Dana‮ ", kind: "phone" },
    });
    assert.equal(joined.self?.name, "Dana");
    assert.deepEqual(
      joined.peers.map((peer) => [peer.kind, peer.id, peer.owner]),
      [["host", olgaId, "olga"]],
    );
    const guestStream = await Stream.open(base, urls.nearbyEvents(invite.token), guest);
    await guestStream.until((events) => events.some((event) => event.startsWith("event: ready")));
    await eventually(async () => (await olga.call(api.nearby.get)).peers.some((peer) => peer.kind === "guest"));
    const guestId = joined.self.id;
    assert.deepEqual((await olga.call(api.nearby.get)).invite?.guests, [
      { id: guestId, name: "Dana", kind: "phone", present: true },
    ]);

    // A guest's writes need their own CSRF token.
    const signal = { params: { token: invite.token }, body: { to: olgaId, signal: offer() } };
    await rejects(guest.call(api.nearby.guestSignal, signal), 403);
    guest.csrf = joined.self.csrf;
    await guest.call(api.nearby.guestSignal, signal);
    await olgaStream.until(() => nearbyEvents(olgaStream).some((event) => event.type === "signal"));
    assert.deepEqual(nearbyEvents(olgaStream).at(-1), { type: "signal", from: guestId, signal: offer() });
    await olga.call(api.nearby.signal, { body: { to: guestId, signal: offer("reply-session") } });
    await guestStream.until(() => nearbyEvents(guestStream).some((event) => event.type === "signal"));

    // Only the member whose code it is.
    await rejects(guest.call(api.nearby.guestSignal, { ...signal, body: { ...signal.body, to: piaId } }), 404);
    await rejects(pia.call(api.nearby.signal, { body: { to: guestId, signal: offer() } }), 404);
    assert.ok(!(await pia.call(api.nearby.get)).peers.some((peer) => peer.id === guestId));

    // The guest hears when the member's devices come and go.
    await piaStream.close();
    await olgaStream.close();
    await guestStream.until(() => nearbyEvents(guestStream).some((event) => event.type === "peers"));
    assert.deepEqual((await guest.call(api.nearby.guest, { params: { token: invite.token } })).peers, []);

    // Removing the guest ends their stream; they can join again while the code is open.
    await olga.call(api.nearby.removeGuest, { params: { id: guestId } });
    await guestStream.until((events) => events.some((event) => event.includes('"signed-out"')));
    assert.equal((await guest.call(api.nearby.guest, { params: { token: invite.token } })).self, null);
    await guestStream.close();
  } finally {
    await instance.close();
  }
});

test("ending or outliving a Nearby code ends it for its guests and retires its number", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const olga = await member(instance, "olga");
    const invite = await olga.call(api.nearby.invite);
    const guest = new Client(instance);
    const joined = await guest.call(api.nearby.join, {
      params: { token: invite.token },
      body: { name: "Dana", kind: "computer" },
    });
    guest.csrf = joined.self!.csrf;
    const stream = await Stream.open(base, urls.nearbyEvents(invite.token), guest);
    await stream.until((events) => events.some((event) => event.startsWith("event: ready")));

    const extended = await olga.call(api.nearby.extendInvite);
    assert.ok(extended.expires >= invite.expires);
    assert.equal(extended.code, invite.code);

    await olga.call(api.nearby.endInvite);
    await stream.until((events) => events.some((event) => event.includes('"expired"')));
    await rejects(guest.call(api.nearby.guest, { params: { token: invite.token } }), 404);
    await rejects(guest.call(api.pickup.resolve, { body: { code: invite.code } }), 404);
    assert.equal((await olga.call(api.nearby.get)).invite, null);
    await rejects(olga.call(api.nearby.extendInvite), 410);
    await stream.close();

    // A new code is a new number, and an expired one stops working before the sweep removes it.
    const next = await olga.call(api.nearby.invite);
    assert.notEqual(next.code, invite.code);
    instance.ctx.db.run("UPDATE nearby_invites SET expires = ? WHERE id = ?", Date.now() - 1, next.id);
    await rejects(guest.call(api.nearby.guest, { params: { token: next.token } }), 410);
    assert.equal((await olga.call(api.nearby.get)).invite, null);
    const renewed = await olga.call(api.nearby.invite);
    assert.notEqual(renewed.id, next.id);
    await instance.sweep();
    assert.equal(instance.ctx.db.value("SELECT COUNT(*) FROM nearby_invites"), 1);
  } finally {
    await instance.close();
  }
});

/** A guest who joined `host`'s Nearby code from another network, with their stream open. */
async function guestOf(instance: Instance, base: string, host: Client) {
  const invite = await host.call(api.nearby.invite);
  const guest = new Client(instance);
  guest.address = "198.51.100.77";
  const joined = await guest.call(api.nearby.join, {
    params: { token: invite.token },
    body: { name: "Dana", kind: "computer" },
  });
  guest.csrf = joined.self!.csrf;
  const stream = await Stream.open(base, urls.nearbyEvents(invite.token), guest);
  await stream.until((events) => events.some((event) => event.startsWith("event: ready")));
  const signal = (to: string, signal: NearbySignal) =>
    guest.call(api.nearby.guestSignal, { params: { token: invite.token }, body: { to, signal } });
  return { stream, signal };
}

test("only local candidates reach a browser, so nobody can make it contact the internet", async () => {
  const lines = (sdp: string) => sdp.split("\r\n").filter((line) => /a=candidate/i.test(line));
  const sdp = [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=candidate:1 1 udp 2122260223 4b1c2f3e-8a9d-4e5f-a6b7-c8d9e0f1a2b3.local 50000 typ host",
    "a=candidate:2 1 udp 2122260223 192.168.1.30 50001 typ host",
    "a=candidate:3 1 tcp 1518280447 192.168.1.30 9 typ host tcptype active",
    "a=candidate:4 1 udp 2122260223 fd12:3456::30 50002 typ host",
    "a=candidate:5 1 udp 2122260223 fe80::1c2b:3a4d 50003 typ host",
    "a=candidate:6 1 udp 2122260223 198.51.100.77 40000 typ host",
    "a=candidate:7 1 tcp 1518280447 198.51.100.77 443 typ host tcptype passive",
    "a=candidate:8 1 udp 1686052607 198.51.100.77 40001 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:9 1 udp 2122260223 2001:db8::30 50004 typ host",
    // Written to slip past a careless reading: behind a lone carriage return, in capitals, indented,
    // with leading zeros, as a short IPv6 that isn't unique local, as a mapped IPv4, or a long name.
    "a=mid:0\ra=candidate:10 1 udp 2122260223 198.51.100.77 40002 typ host",
    "A=CANDIDATE:11 1 UDP 2122260223 198.51.100.77 40003 typ host",
    " a=candidate:12 1 udp 2122260223 198.51.100.77 40004 typ host",
    "a=candidate:13 1 udp 2122260223 010.0.0.1 40005 typ host",
    "a=candidate:14 1 udp 2122260223 fd::1 40006 typ host",
    "a=candidate:15 1 udp 2122260223 ::ffff:198.51.100.77 40007 typ host",
    "a=candidate:16 1 udp 2122260223 relay.local.example.com 40008 typ host",
    "a=end-of-candidates",
    "",
  ].join("\r\n");
  assert.deepEqual(lines(localCandidates(sdp)), [
    "a=candidate:1 1 udp 2122260223 4b1c2f3e-8a9d-4e5f-a6b7-c8d9e0f1a2b3.local 50000 typ host",
    "a=candidate:2 1 udp 2122260223 192.168.1.30 50001 typ host",
    "a=candidate:3 1 tcp 1518280447 192.168.1.30 9 typ host tcptype active",
    "a=candidate:4 1 udp 2122260223 fd12:3456::30 50002 typ host",
    "a=candidate:5 1 udp 2122260223 fe80::1c2b:3a4d 50003 typ host",
  ]);
  assert.ok(localCandidates(sdp).includes("a=mid:0\r\n"), "the line it hid behind stays");
  // Direct's helper takes UDP only, at the same addresses.
  assert.equal(lines(localCandidates(sdp, { udpOnly: true })).length, 4);

  // Relay passes on only the local ones too, for browsers that don't filter them.
  const instance = await start();
  try {
    const base = await listen(instance);
    const olga = await member(instance, "olga");
    const olgaId = (await olga.call(api.session.get)).device.id;
    const olgaStream = await present(base, olga);
    const { stream, signal } = await guestOf(instance, base, olga);
    await signal(olgaId, { kind: "offer", session: "session-one", sdp });
    await olgaStream.until(() => nearbyEvents(olgaStream).some((event) => event.type === "signal"));
    const got = nearbyEvents(olgaStream).find((event) => event.type === "signal");
    assert.ok(got?.type === "signal" && got.signal.kind === "offer");
    assert.equal(got.signal.sdp, localCandidates(sdp));
    await Promise.all([olgaStream.close(), stream.close()]);
  } finally {
    await instance.close();
  }
});

test("a flood of signals can't push a slowly reading device out of Nearby", async () => {
  const instance = await start();
  try {
    const base = await listen(instance);
    const olga = await member(instance, "olga");
    const olgaId = (await olga.call(api.session.get)).device.id;
    // A tab whose reader has stalled for a moment, as a phone's on a weak link does.
    const cookie = [...olga.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${base}${urls.events(olga.tab)}&browser=${olga.tab}`, {
        agent: false,
        headers: { host: "relay.test", cookie },
      });
      req.on("response", resolve).on("error", reject).end();
    });
    res.once("data", () => res.pause());
    await eventually(() => res.isPaused());
    await olga.call(api.nearby.present, { body: { tab: olga.tab } });
    const hub = hubOf(instance.ctx);

    // A guest sending as fast as it can gets a few signals through; the device stays.
    const { stream, signal } = await guestOf(instance, base, olga);
    const sdp = "v=0\r\n" + "a=x:".padEnd(NEARBY.sdpBytes - 8, "A");
    const refused: number[] = [];
    for (let i = 0; i < 80; i++)
      await signal(olgaId, { kind: "offer", session: `flood-session-${i}`, sdp }).catch((error: ApiError) =>
        refused.push(error.status),
      );
    assert.ok(refused.length >= 55 && refused.every((status) => status === 429 || status === 503), refused.join(", "));
    assert.ok(hub.get(olgaId), "the device is still in Nearby");

    // Its stream may fall a little behind before it's cut...
    const channel = hub.get(olgaId)!.channel;
    const filler = "x".repeat(16 * 1024);
    for (let i = 0; i < 1000 && channel.backlog() <= 160 * 1024; i++) channel.send("beat", filler);
    assert.ok(channel.backlog() > 64 * 1024 && hub.get(olgaId), "behind, and still open");
    // ...but one that has stopped reading altogether is let go, rather than held in memory.
    for (let i = 0; i < 100 && hub.get(olgaId); i++) channel.send("beat", filler);
    assert.equal(hub.get(olgaId), undefined);
    res.destroy();

    // Signals to a device whose stream is behind wait: the sender tries again, and the device stays.
    const phone = await signIn(instance, "olga", "Phone");
    const phoneStream = await present(base, phone.client);
    const behind = {
      send: () => assert.fail("nothing more goes to a stream that's behind"),
      backlog: () => 100 * 1024,
      onEnd: () => () => {},
    };
    const userId = (await olga.call(api.session.get)).user.id;
    const tablet = randomUUID();
    hub.attach({ id: tablet, kind: "device", userId, network: "local", channel: behind });
    await rejects(phone.client.call(api.nearby.signal, { body: { to: tablet, signal: offer() } }), 503);
    await Promise.all([stream.close(), phoneStream.close()]);
  } finally {
    await instance.close();
  }
});
