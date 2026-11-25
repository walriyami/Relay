// Preparing an archive of everything a member keeps checks every file on disk first. Only a few run
// at a time, for each member and on the server; browsing doesn't wait for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import { JOBS_PER_MEMBER, JOBS_TOTAL, MEMBER_BUSY, SERVER_BUSY, SHARED_BUSY } from "../server/lib/jobs.ts";
import { Client, admin, member, openShare, send, start } from "./support/harness.ts";

test("only a few archives are prepared at once, and a busy one says to try again", async () => {
  const instance = await start();
  try {
    const boss = await admin(instance);
    const people: Client[] = [];
    for (const name of ["ana", "ben", "cyd"]) {
      const client = await member(instance, name, boss);
      await send(client, [{ path: `${name}.txt`, data: name }]);
      people.push(client);
    }
    const [ana, ben, cy] = people;
    // Checking files on disk waits here until the test lets it go on.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const verify = instance.ctx.blobs.verify.bind(instance.ctx.blobs);
    instance.ctx.blobs.verify = async (...args) => {
      await held;
      return verify(...args);
    };
    const exportZip = (client: Client) => client.raw({ method: "GET", url: urls.exportZip() });
    const waiting = [
      ...Array<Client>(JOBS_PER_MEMBER).fill(ana),
      ...Array<Client>(JOBS_TOTAL - JOBS_PER_MEMBER).fill(ben),
    ].map(exportZip);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const mine = await exportZip(ana);
    assert.equal(mine.statusCode, 503);
    assert.equal(mine.headers["retry-after"], "5");
    assert.equal(mine.json<{ error: string }>().error, MEMBER_BUSY);
    const server = await exportZip(cy);
    assert.equal(server.statusCode, 503);
    assert.equal(server.json<{ error: string }>().error, SERVER_BUSY);
    // Browsing goes on meanwhile.
    assert.equal((await cy.call(api.items.list)).items.length, 1);

    release();
    for (const res of await Promise.all(waiting)) assert.equal(res.statusCode, 200);
    // The places are given back, refused or not.
    assert.equal((await exportZip(cy)).statusCode, 200);
    // Something new to list, so the export just made isn't used again.
    await send(ana, [{ path: "more.txt", data: "more" }]);
    instance.ctx.blobs.verify = () => Promise.reject(new Error("disk failed"));
    for (let i = 0; i <= JOBS_TOTAL; i++) assert.equal((await exportZip(ana)).statusCode, 500);
    instance.ctx.blobs.verify = verify;
    assert.equal((await exportZip(ana)).statusCode, 200);
  } finally {
    await instance.close();
  }
});

test("a HEAD before the export doesn't make the files be checked twice", async () => {
  const instance = await start();
  try {
    const ana = await member(instance, "ana");
    await send(ana, [{ path: "a.txt", data: "a" }]);
    const verify = instance.ctx.blobs.verify.bind(instance.ctx.blobs);
    let checks = 0;
    instance.ctx.blobs.verify = (...args) => {
      checks++;
      return verify(...args);
    };
    const head = await ana.raw({ method: "HEAD", url: urls.exportZip() });
    const get = await ana.raw({ method: "GET", url: urls.exportZip() });
    assert.equal(head.statusCode, 200);
    assert.equal(get.statusCode, 200);
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
    assert.equal(head.headers.etag, get.headers.etag);
    assert.equal(checks, 1);
    // Anything new is listed, and checked.
    await send(ana, [{ path: "b.txt", data: "b" }]);
    const after = await ana.raw({ method: "GET", url: urls.exportZip() });
    assert.notEqual(after.headers.etag, get.headers.etag);
    assert.equal(checks, 3);
  } finally {
    await instance.close();
  }
});

test("archives of items and of share links take the same few places, a link's visitors their own", async () => {
  const instance = await start();
  try {
    const ana = await member(instance, "ana");
    const ben = await member(instance, "ben");
    const items: string[] = [];
    // Two files each, so every archive is one to prepare.
    for (let i = 0; i < 5; i++)
      items.push(
        (
          await send(ana, [
            { path: `a${i}.txt`, data: `a${i}` },
            { path: `b${i}.txt`, data: `b${i}` },
          ])
        ).result.itemId,
      );
    const benItem = (
      await send(ben, [
        { path: "c.txt", data: "c" },
        { path: "d.txt", data: "d" },
      ])
    ).result.itemId;
    const visitor = new Client(instance);
    const links = [];
    for (const item of items.slice(2)) {
      const link = await ana.call(api.links.create, { body: { id: crypto.randomUUID(), item, days: 7 } });
      await openShare(visitor, link.token);
      links.push(link);
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const verify = instance.ctx.blobs.verify.bind(instance.ctx.blobs);
    instance.ctx.blobs.verify = async (...args) => {
      await held;
      return verify(...args);
    };
    const zip = (client: Client, url: string) => client.raw({ method: "GET", url });
    // Two for everyone opening Ana's links, then her own two, which those visitors don't take.
    const waiting = [
      zip(visitor, urls.shareZip(links[0].token)),
      zip(visitor, urls.shareZip(links[1].token)),
      zip(ana, urls.itemZip(items[0])),
      zip(ana, urls.itemZip(items[1])),
    ];
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The same archive asked for again waits for the one being prepared rather than taking a place.
    waiting.push(zip(visitor, urls.shareZip(links[0].token)));
    const shared = await zip(visitor, urls.shareZip(links[2].token));
    assert.equal(shared.statusCode, 503);
    assert.equal(shared.headers["retry-after"], "5");
    assert.equal(shared.json<{ error: string }>().error, SHARED_BUSY);
    const own = await zip(ana, urls.itemZip(items[4]));
    assert.equal(own.statusCode, 503);
    assert.equal(own.json<{ error: string }>().error, MEMBER_BUSY);
    const server = await zip(ben, urls.itemZip(benItem));
    assert.equal(server.statusCode, 503);
    assert.equal(server.json<{ error: string }>().error, SERVER_BUSY);
    release();
    for (const res of await Promise.all(waiting)) assert.equal(res.statusCode, 200);
    // The places are given back.
    assert.equal((await zip(ben, urls.itemZip(benItem))).statusCode, 200);
    assert.equal((await zip(visitor, urls.shareZip(links[2].token))).statusCode, 200);
  } finally {
    await instance.close();
  }
});
