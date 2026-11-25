import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../shared/api.ts";
import { admin, Client, member, openShare, send, start } from "./support/harness.ts";

// A name can't pose as a notice from Relay over several lines, or reorder how its letters show.
const FAKE_NOTICE = "Sara\r\nSecurity notice:\tsign in again\u2028at evil.example\u0000";
const ONE_LINE = "Sara Security notice: sign in again at evil.example";

test("names and notes others see keep to one line, without control or direction characters", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const sara = await member(instance, "sara", boss);

    // Her own name, as visitors see it on her links and requests.
    const { user } = await sara.call(api.account.update, { body: { name: FAKE_NOTICE } });
    assert.equal(user.name, ONE_LINE);
    const { result } = await send(sara, [{ path: "a.txt", data: "alpha" }]);
    const link = await sara.call(api.links.create, {
      body: {
        id: crypto.randomUUID(),
        item: result.itemId,
        days: 7,
        // A note keeps its line breaks, and nothing else hidden.
        note: " Hi\r\nthe photos\u202e\u0007 are here \n",
      },
    });
    const share = await openShare(new Client(instance), link.token);
    assert.equal(share.from, ONE_LINE);
    assert.equal(share.note, "Hi\nthe photos are here");

    const request = await sara.call(api.requests.create, {
      body: {
        id: crypto.randomUUID(),
        name: "Tax\nforms\u202e",
        description: "Line one\r\nLine\u2066 two\u0000",
        days: 7,
        maxBytes: 1000,
      },
    });
    const opened = await new Client(instance).call(api.requests.open, { params: { token: request.token } });
    assert.deepEqual([opened.owner, opened.name, opened.description], [ONE_LINE, "Tax forms", "Line one\nLine two"]);

    // A device's name, as Nearby and the administrator see it.
    const [device] = await sara.call(api.devices.list);
    await sara.call(api.devices.update, { params: { id: device.id }, body: { name: "Admin Mac\u202e\u0000" } });
    assert.equal((await sara.call(api.devices.list))[0].name, "Admin Mac");
    const phone = new Client(instance);
    await phone.signIn("sara", "Member-password-only", "Sara's\nphone\u202e");
    const names = (await sara.call(api.devices.list)).map((d) => d.name).sort();
    assert.deepEqual(names, ["Admin Mac", "Sara's phone"]);

    // What an administrator sets is cleaned the same way.
    const { id: saraId } = instance.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'sara'")!;
    await boss.call(api.admin.updateMember, { params: { id: saraId }, body: { name: "Sara\u202eQ\n" } });
    assert.equal(instance.ctx.db.value("SELECT display_name FROM users WHERE id = ?", saraId), "SaraQ");
    await boss.call(api.admin.invite, { body: { note: "Dad\nRelay admin\u202e" } });
    assert.equal(instance.ctx.db.value("SELECT note FROM invites WHERE note IS NOT NULL"), "Dad Relay admin");

    // Nothing but hidden characters is no name at all.
    await sara.call(api.account.update, { body: { name: "\u202e\n\u0000 " } });
    assert.equal(instance.ctx.db.value("SELECT display_name FROM users WHERE id = ?", saraId), null);
  } finally {
    await instance.close();
  }
});
