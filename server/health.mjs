// The container's health check: Relay answers its health route on its port with a 200. It prints
// what Relay reported, which `docker inspect` keeps with each check. Plain JavaScript, so each probe
// (every 20 s) starts without Node's TypeScript stripper: about a third of the CPU time and 25 MB
// less memory on the Pi.
import { request } from "node:http";

const req = request(
  { host: "127.0.0.1", port: Number(process.env.PORT || 3090), path: "/api/health", timeout: 4000 },
  (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (body = (body + chunk).slice(0, 2000)));
    res.on("end", () => {
      try {
        const { status, problems } = JSON.parse(body);
        process.stdout.write(`${problems?.length ? `${status}: ${problems.join(", ")}` : status}\n`);
      } catch {
        process.stdout.write(`HTTP ${res.statusCode}\n`);
      }
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);
req.on("timeout", () => req.destroy());
req.on("error", (error) => {
  process.stdout.write(`no answer: ${error.message}\n`);
  process.exit(1);
});
req.end();
