import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { start, Client } from "./support/harness.ts";
import { api } from "../shared/api.ts";

test("shared sign-in requires explicit linking, creates a real session, and revokes only shared sessions", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  let issuer = "",
    nonce = "",
    allowed = true;
  const provider = createServer((req, reply) => {
    void (async () => {
      reply.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/openid-configuration")
        return reply.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + "/authorize",
            token_endpoint: issuer + "/token",
            jwks_uri: issuer + "/jwks",
            userinfo_endpoint: issuer + "/userinfo",
          }),
        );
      if (req.url === "/jwks") return reply.end(JSON.stringify({ keys: [jwk] }));
      if (req.url === "/userinfo")
        return reply.end(JSON.stringify({ sub: "central-owner", preferred_username: "admin", name: "Owner" }));
      if (req.url === "/token") {
        assert.equal(req.headers.authorization, "Basic " + Buffer.from("relay-test:client-secret").toString("base64"));
        const token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience("relay-test")
          .setSubject("central-owner")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return reply.end(JSON.stringify({ id_token: token, access_token: "test-profile-token" }));
      }
      if (req.url?.includes("/grants/")) return reply.end(JSON.stringify({ allowed, administrator: true }));
      reply.writeHead(404);
      reply.end("{}");
    })().catch((error: unknown) => {
      reply.statusCode = 500;
      reply.end(JSON.stringify({ error: error instanceof Error ? error.message : "provider failure" }));
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const instance = await start({
    origin: "http://localhost",
    sso: {
      issuer,
      clientId: "relay-test",
      clientSecret: "client-secret",
      controlOrigin: issuer,
      appToken: "test-app-token",
      projectId: "relay",
    },
  });
  const jar = new Map<string, string>();
  let csrf = "";
  async function request(url: string, method: "GET" | "POST" = "GET", payload?: object) {
    const r = await instance.app.inject({
      method,
      url,
      headers: { "x-relay-csrf": csrf, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      payload,
    });
    for (const c of r.cookies) {
      if (!c.value || c.maxAge === 0) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    return r;
  }
  async function finish(location: string) {
    const url = new URL(location);
    nonce = url.searchParams.get("nonce")!;
    return request(`/api/sso/callback?state=${url.searchParams.get("state")}&code=test-code`);
  }
  try {
    const rejected = await finish((await request("/api/sso/login")).headers.location!);
    assert.equal(rejected.headers.location, "/?sso=link-required");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM users"), 1);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM external_identities"), 0);
    const local = new Client(instance);
    await local.signIn("admin", "Test-admin-password-only");
    csrf = local.csrf;
    for (const [k, v] of local.cookies) jar.set(k, v);
    assert.equal((await request("/api/sso/link", "POST", { password: "incorrect-password" })).statusCode, 403);
    const link = await request("/api/sso/link", "POST", { password: "Test-admin-password-only" });
    assert.equal(link.statusCode, 200);
    assert.equal((await finish(link.json<{ url: string }>().url)).headers.location, "/");
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM external_identities"), 1);
    assert.equal(instance.ctx.db.value("SELECT count(*) FROM external_sessions"), 1);

    assert.equal((await finish((await request("/api/sso/login")).headers.location!)).headers.location, "/");
    allowed = false;
    assert.equal((await request("/api/session")).statusCode, 401);
    assert.equal((await local.call(api.session.get)).user.username, "admin");
  } finally {
    await instance.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});
