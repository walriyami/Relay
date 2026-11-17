// The container's health check: Relay answers its health route on its port. Plain JavaScript, so
// each probe (every 20 s) starts without Node's TypeScript stripper: about a third of the CPU time
// and 25 MB less memory on the Pi.
import { request } from "node:http";

const req = request(
  { host: "127.0.0.1", port: Number(process.env.PORT || 3090), path: "/api/health", timeout: 4000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on("timeout", () => req.destroy());
req.on("error", () => process.exit(1));
req.end();
