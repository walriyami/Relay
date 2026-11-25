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
# Relay starts with node directly; npm, Yarn and corepack are only needed in the build stage. bash and
# perl aren't needed at all: nothing in Relay, its health check, deploy/*.sh or Walriyami Control runs
# them, so a bug that let someone run a program in here finds fewer tools. /bin/sh (dash), tar and find
# stay for deploy/backup.sh and restore.sh.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
       /usr/bin/bash /usr/bin/rbash /bin/bash /bin/rbash /usr/bin/perl /usr/bin/perl5.* \
    && sed -i 's#^\(node:.*:\)/bin/bash$#\1/bin/sh#' /etc/passwd
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3090 RELAY_DATA=/data
WORKDIR /app
# The app's own files stay owned by root, so Relay (running as `node`) can read them but never
# rewrite them: a bug that let someone run code inside Relay couldn't change Relay itself, even
# without a read-only root filesystem. /data is the only place it writes.
COPY --from=build /app/package*.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /wal-auth ./node_modules/@walriyami/auth
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/local ./local
COPY --from=build /app/dist ./dist
RUN mkdir -m 0700 /data && chown node:node /data
USER node
EXPOSE 3090
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s CMD ["node", "server/health.mjs"]
# Node 24 runs the TypeScript sources directly (type stripping); there is no compile step.
CMD ["node", "server/main.ts"]
