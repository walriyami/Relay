FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3090 RELAY_DATA=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/local ./local
COPY --from=build --chown=node:node /app/dist ./dist
# /run/relay holds Relay's socket (RELAY_SOCKET) for a proxy in Relay's group.
RUN mkdir -m 0700 /data && mkdir -m 0750 /run/relay && chown node:node /data /run/relay
USER node
EXPOSE 3090
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD ["node", "server/health.ts"]
# Node 24 runs the TypeScript sources directly (type stripping); there is no compile step.
CMD ["node", "server/main.ts"]
