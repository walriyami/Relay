import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, type Endpoint } from "../shared/api.ts";
import { start, admin, member, send, Client } from "./support/harness.ts";

function contracts(value: unknown, key = "api"): { key: string; endpoint: Endpoint }[] {
  if (!value || typeof value !== "object") return [];
  if ("method" in value && "path" in value) return [{ key, endpoint: value as Endpoint }];
  return Object.entries(value).flatMap(([name, item]) => contracts(item, `${key}.${name}`));
}

// Reconcile the contract with Fastify's actual registered routes, including raw streams and HEAD.
function registered(tree: string) {
  const stack: string[] = [];
  const routes: { method: string; path: string }[] = [];
  for (const line of tree.split("\n")) {
    const match = /^([│ ]*)[├└]── (\/\S+) \(([^)]+)\)/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4;
    const path = depth ? `${stack[depth - 1]}${match[2]}` : match[2];
    stack[depth] = path;
    for (const method of match[3].split(", ")) routes.push({ method, path });
  }
  return routes;
}

const missing = "00000000-0000-4000-8000-000000000000";
const concrete = (path: string) => path.replace(/:token/g, "audit-invalid-token").replace(/:[a-z]+/g, missing);

test("security audit reconciles every registered route and denies unauthorized roles and origins", async () => {
  const instance = await start();
  const observations: object[] = [];
  try {
    const administrator = await admin(instance);
    const ordinary = await member(instance, "audit-member", administrator);
    const guest = new Client(instance);
    const request = await ordinary.call(api.requests.create, {
      body: { id: crypto.randomUUID(), name: "Audit request", description: "", days: 1, maxBytes: 1024 },
    });
    guest.csrf = (await guest.call(api.requests.start, { params: { token: request.token } })).csrf;
    const anonymous = new Client(instance);
    const forged = new Client(instance);
    forged.cookies.set("relay", "audit-forged-session-value");
    const shared = await send(ordinary, [], { text: "Scoped share", destination: { kind: "link", days: 1 } });
    const shareHolder = new Client(instance);
    await shareHolder.call(api.links.open, { params: { token: shared.result.link!.token } });
    const invite = await ordinary.call(api.nearby.invite);
    const nearbyGuest = new Client(instance);
    await nearbyGuest.call(api.nearby.join, {
      params: { token: invite.token },
      body: { name: "Audit guest", kind: "phone" },
    });
    const networkStranger = new Client(instance);
    networkStranger.address = "192.168.1.42";
    const definitions = contracts(api);
    const tree = instance.app.printRoutes({ commonPrefix: false });
    const routes = registered(tree);
    assert.ok(routes.length > 100, "runtime inventory includes raw routes and automatic HEAD");
    for (const { key, endpoint } of definitions)
      assert.ok(
        routes.some((r) => r.path === endpoint.path && r.method === endpoint.method),
        key,
      );
    for (const route of routes) {
      const definition = definitions.find(
        (d) =>
          d.endpoint.path === route.path &&
          (d.endpoint.method === route.method || (route.method === "HEAD" && d.endpoint.method === "GET")),
      );
      const rawMember = [
        "/api/events",
        "/api/nodes/:id/content",
        "/api/nodes/:id/thumbnail",
        "/api/items/:id/zip",
      ].includes(route.path);
      const auth = definition?.endpoint.auth ?? (rawMember ? "member" : "raw");
      const evidence: { actor: string; check: string; status: number }[] = [];
      if (auth === "member" || auth === "admin") {
        for (const [actor, client] of [
          ["anonymous", anonymous],
          ["forged-session", forged],
          ["request-guest", guest],
          ["share-holder", shareHolder],
          ["nearby-guest", nearbyGuest],
          ["same-network-stranger", networkStranger],
        ] as const) {
          const res = await client.raw({ method: route.method as "GET", url: concrete(route.path) });
          assert.ok([401, 403].includes(res.statusCode), `${actor} ${route.method} ${route.path}: ${res.statusCode}`);
          evidence.push({ actor, check: "authentication boundary", status: res.statusCode });
        }
        if (auth === "admin") {
          const res = await ordinary.raw({ method: route.method as "GET", url: concrete(route.path) });
          assert.equal(res.statusCode, 403, `member ${route.method} ${route.path}`);
          evidence.push({ actor: "ordinary-member", check: "administrator boundary", status: res.statusCode });
        }
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(route.method)) {
        for (const headers of [{ origin: "https://untrusted.invalid" }, { "sec-fetch-site": "cross-site" }]) {
          const res = await anonymous.raw({ method: route.method as "POST", url: concrete(route.path), headers });
          assert.equal(res.statusCode, 403, `${route.method} ${route.path} ${JSON.stringify(headers)}`);
          evidence.push({ actor: "cross-site-browser", check: Object.keys(headers)[0], status: res.statusCode });
        }
        if (auth === "member" || auth === "admin") {
          const res = await instance.app.inject({
            method: route.method as "POST",
            url: concrete(route.path),
            headers: { host: "relay.test", cookie: [...administrator.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
          });
          assert.equal(res.statusCode, 403, `missing CSRF ${route.method} ${route.path}`);
          evidence.push({ actor: "session-without-csrf", check: "CSRF token", status: res.statusCode });
        }
      }
      if (!(route.path === "/api/health" && ["GET", "HEAD"].includes(route.method))) {
        const res = await anonymous.raw({
          method: route.method as "GET",
          url: concrete(route.path),
          headers: { host: "untrusted.invalid" },
        });
        assert.equal(res.statusCode, 403, `host ${route.method} ${route.path}`);
        evidence.push({ actor: "rebound-host", check: "Host validation", status: res.statusCode });
      }
      observations.push({ ...route, contract: definition?.key ?? null, auth, evidence });
    }
    if (process.env.RELAY_SECURITY_EVIDENCE) {
      mkdirSync(process.env.RELAY_SECURITY_EVIDENCE, { recursive: true });
      writeFileSync(
        join(process.env.RELAY_SECURITY_EVIDENCE, "route-matrix.json"),
        JSON.stringify(
          {
            baseline: "76044ebd57fd92b037ddc11defe4fe2d1331eb87",
            generatedAt: new Date().toISOString(),
            contractEndpoints: definitions.length,
            registeredOperations: routes.length,
            observations,
          },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(join(process.env.RELAY_SECURITY_EVIDENCE, "runtime-routes.txt"), tree);
    }
  } finally {
    await instance.close();
  }
});
