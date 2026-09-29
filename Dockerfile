FROM node:22-slim AS base
RUN corepack enable pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# FROM deps, not base: pnpm ITSELF is downloaded by corepack the first time
# `pnpm` runs, into /root/.cache/node/corepack — that happened in the deps
# stage's install. A build stage started from `base` has no copy, so every
# code change fetched pnpm from registry.npmjs.org again, and the 2026-09-29
# deploy died on that one fetch (a connect timeout from the server) with
# nothing of ours changed (DECISIONS #1228). From deps, a deploy that finds
# the deps layer cached fetches nothing from npm. The layer is NOT cached — and
# the install needs registry.npmjs.org, for pnpm and every package — when
# package.json (a new script counts), pnpm-lock.yaml or pnpm-workspace.yaml
# changed, when node:22-slim resolves to a new digest (Docker's containerd
# image store asks Docker Hub first), or when the build cache was pruned.
# `.dockerignore` keeps the host's node_modules out, so `COPY . .` does not
# replace the installed ones.
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# V8's default heap on the owner's server is about 2 GB, and the 0113-0116
# build died at 2,044 MB checking types (DECISIONS #1223). The flag rides on
# this line and not an ENV: `migrate` and `tg-listen` run THIS stage's image,
# and a heap chosen for a compiler is not theirs.
RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm build

FROM node:22-slim AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0 is load-bearing. Next's standalone `server.js` binds to
# `process.env.HOSTNAME || '0.0.0.0'`, and Docker sets HOSTNAME to the
# container id — so without this the server listens ONLY on the container's
# bridge address. Caddy reaches it either way (`app:3000`), which is why this
# was invisible for a year; what does not work is 127.0.0.1 from inside the
# container, so every health probe and every debugging session gets
# ECONNREFUSED from a process that is running perfectly. Found during the
# owner's VPS move, on the machine where a false alarm costs the most.
# Not a widening: the port is still unpublished, so only the compose network
# can reach it (round 81).
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/src/modules/platform/db/migrations ./migrations
COPY --from=build /app/src/assets ./src/assets
# The healthcheck + watchdog (docker-compose.yml, B9) — node builtins only.
COPY --from=build /app/ops/health-probe.mjs ./ops/health-probe.mjs
EXPOSE 3000
CMD ["node", "server.js"]
