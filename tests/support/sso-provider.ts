// A stand-in for Walriyami: its OpenID provider and Control's grant service, on one local port,
// plus a cookie-keeping browser that walks Relay's /api/sso redirects.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Instance } from "./harness.ts";

export type Grants = {
  allowed: boolean;
  administrator: boolean;
  /** Control answers grant checks with this HTTP status instead (an outage), or never answers. */
  outage?: number | "hang";
  /** Count of grant checks Control has answered or refused. */
  checks: number;
};

export async function startProvider(user = { sub: "central-owner", username: "admin" }) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const grants: Grants = { allowed: true, administrator: true, checks: 0 };
  let issuer = "";
  let nonce = "";
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
        return reply.end(JSON.stringify({ sub: user.sub, preferred_username: user.username, name: "Owner" }));
      if (req.url === "/token") {
        assert.equal(req.headers.authorization, "Basic " + Buffer.from("relay-test:client-secret").toString("base64"));
        const token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience("relay-test")
          .setSubject(user.sub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return reply.end(JSON.stringify({ id_token: token, access_token: "test-profile-token" }));
      }
      if (req.url?.includes("/grants/")) {
        grants.checks++;
        if (grants.outage === "hang") return;
        if (grants.outage) {
          reply.writeHead(grants.outage);
          return reply.end("{}");
        }
        return reply.end(JSON.stringify({ allowed: grants.allowed, administrator: grants.administrator }));
      }
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
  return {
    grants,
    config: {
      issuer,
      clientId: "relay-test",
      clientSecret: "client-secret",
      controlOrigin: issuer,
      appToken: "test-app-token",
      projectId: "relay",
    },
    /** A browser for `instance` that keeps its cookies across the sign-in redirects. */
    browser(instance: Instance) {
      const jar = new Map<string, string>();
      const browser = {
        jar,
        csrf: "",
        async request(url: string, method: "GET" | "POST" = "GET", payload?: object) {
          const r = await instance.app.inject({
            method,
            url,
            headers: { "x-relay-csrf": browser.csrf, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
            payload,
          });
          for (const c of r.cookies) {
            if (!c.value || c.maxAge === 0) jar.delete(c.name);
            else jar.set(c.name, c.value);
          }
          return r;
        },
        /** Completes the provider's side of a sign-in that Relay sent to `location`. */
        async finish(location: string) {
          const url = new URL(location);
          nonce = url.searchParams.get("nonce")!;
          return browser.request(`/api/sso/callback?state=${url.searchParams.get("state")}&code=test-code`);
        },
        async signIn() {
          return browser.finish((await browser.request("/api/sso/login")).headers.location!);
        },
      };
      return browser;
    },
    async close() {
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
    },
  };
}
