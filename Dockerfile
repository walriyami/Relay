# The base is pinned by digest, so the same commit always builds the same image. Operating-system and
# Node security fixes arrive by moving this digest to a newer one (Dependabot proposes it weekly).
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencies
WORKDIR /app
COPY package*.json ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund
FROM dependencies AS production-dependencies
# Browser-only packages are dev dependencies (Vite bundles them into dist/), so this keeps only what
# the server imports.
RUN npm prune --omit=dev \
    && mv node_modules/@walriyami/auth /wal-auth \
    && rm -f node_modules/.package-lock.json
FROM dependencies AS build
COPY . .
# Every image records the commit it was built from, and the build stops when it can't tell (see
# server/build-info.ts). `walctl deploy relay-production --commit <ref>` fills it in by itself.
ARG RELAY_COMMIT=""
RUN node server/build-stamp.ts "$RELAY_COMMIT"
RUN npm run build

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# Relay starts with node directly; npm and Yarn are only needed in the build stage.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3090 RELAY_DATA=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /wal-auth ./node_modules/@walriyami/auth
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/local ./local
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -m 0700 /data && chown node:node /data
USER node
EXPOSE 3090
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD ["node", "server/health.mjs"]
# Node 24 runs the TypeScript sources directly (type stripping); there is no compile step.
CMD ["node", "server/main.ts"]
