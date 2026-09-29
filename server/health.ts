// The container's health check: Relay answers its health route, on its socket or its port.
import { request } from "node:http";

const socket = process.env.RELAY_SOCKET;
const req = request(
  {
    ...(socket ? { socketPath: socket } : { host: "127.0.0.1", port: Number(process.env.PORT || 3090) }),
    path: "/api/health",
    timeout: 4000,
  },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on("timeout", () => req.destroy());
req.on("error", () => process.exit(1));
req.end();
