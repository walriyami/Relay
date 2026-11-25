// Preparing an archive of everything a member keeps checks every file on disk first. Only a few run
// at a time, for each member and on the server; browsing doesn't wait for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, urls } from "../shared/api.ts";
import { JOBS_PER_MEMBER, JOBS_TOTAL, MEMBER_BUSY, SERVER_BUSY } from "../server/lib/jobs.ts";
import { admin, member, send, start, type Client } from "./support/harness.ts";

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
    instance.ctx.blobs.verify = () => Promise.reject(new Error("disk failed"));
    for (let i = 0; i <= JOBS_TOTAL; i++) assert.equal((await exportZip(ana)).statusCode, 500);
    instance.ctx.blobs.verify = verify;
    assert.equal((await exportZip(ana)).statusCode, 200);
  } finally {
    await instance.close();
  }
});
