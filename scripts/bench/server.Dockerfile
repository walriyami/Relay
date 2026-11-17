# Relay as the browser tests run it, with the direct-transfer helper, built from any checkout so that
# two versions can be measured the same way. The bench's own files come from the "bench" context.
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund
COPY . .
RUN NODE_ENV=production npx vite build \
    && sed -i 's/host: "localhost", port/host: "0.0.0.0", port/' tests/browser-server.ts
COPY --from=bench shape.sh /shape.sh
ENV RELAY_TEST_PORT=3091 RELAY_TEST_LOCAL=3090
CMD ["node", "tests/browser-server.ts"]
