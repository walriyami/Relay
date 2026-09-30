FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
# Apply Debian security updates and keep build/package-manager tooling out of the runtime.
# Relay starts with node directly; npm and Yarn are only needed in the build stage.
RUN apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /opt/yarn* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3090 RELAY_DATA=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/local ./local
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -m 0700 /data && chown node:node /data
USER node
EXPOSE 3090
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD ["node", "server/health.ts"]
# Node 24 runs the TypeScript sources directly (type stripping); there is no compile step.
CMD ["node", "server/main.ts"]
