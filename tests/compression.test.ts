import assert from "node:assert/strict";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { api } from "../shared/api.ts";
import { encodingFor } from "../server/lib/compress.ts";
import { admin, send, start } from "./support/harness.ts";

test("the best accepted encoding wins, and a refusal is honoured", () => {
  assert.equal(encodingFor("gzip, deflate, br, zstd"), "br");
  assert.equal(encodingFor("gzip"), "gzip");
  assert.equal(encodingFor("br;q=0, gzip;q=0.5"), "gzip");
  assert.equal(encodingFor("*"), "br");
  assert.equal(encodingFor("*;q=0, gzip"), "gzip");
  assert.equal(encodingFor("identity"), null);
  assert.equal(encodingFor(undefined), null);
});

test("large collection metadata is compressed only for the app's own requests", async () => {
  const instance = await start();
  try {
    const client = await admin(instance);
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `photos/2026/trip/image-${i}.jpg`, data: `${i}` }));
    const { result } = await send(client, files);
    const url = api.items.get.path.replace(":id", result.itemId);
    const plain = await client.raw({ method: "GET", url });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.match(String(plain.headers.vary), /Accept-Encoding/);
    const expected = plain.json<unknown>();

    const fetchWith = (encoding: string, site?: string) =>
      client.raw({
        method: "GET",
        url,
        headers: { "accept-encoding": encoding, ...(site ? { "sec-fetch-site": site } : {}) },
      });

    const br = await fetchWith("gzip, br", "same-origin");
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(Number(br.headers["content-length"]), br.rawPayload.length);
    assert.ok(br.rawPayload.length * 5 < plain.rawPayload.length, "names that repeat compress well");
    assert.deepEqual(JSON.parse(brotliDecompressSync(br.rawPayload).toString()), expected);

    const gz = await fetchWith("gzip", "same-origin");
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(gz.rawPayload).toString()), expected);

    // Another site, an address typed by hand, or a client that doesn't say: the length reveals nothing.
    for (const site of ["cross-site", "same-site", "none", undefined]) {
      const res = await fetchWith("gzip, br", site);
      assert.equal(res.headers["content-encoding"], undefined, `sec-fetch-site: ${site}`);
      assert.deepEqual(res.json(), expected);
    }

    // Responses carrying the session's CSRF token are never compressed.
    const session = await client.raw({
      method: "GET",
      url: api.session.get.path,
      headers: { "accept-encoding": "br", "sec-fetch-site": "same-origin" },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.headers["content-encoding"], undefined);
  } finally {
    await instance.close();
  }
});
