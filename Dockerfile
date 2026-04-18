# Curi ingestion worker — Railway cron target.
#
# Multi-stage so the runtime image ships only compiled JS + prod deps,
# not the TS toolchain. Base is node:20-alpine (matches apps/web's
# engines constraint of node >=20.11) and pulls pnpm 9.15.9 via
# corepack — the same version pinned in root package.json.
#
# Build context: repo root. pnpm's workspace awareness needs the root
# package.json + pnpm-workspace.yaml + the lockfile before it can
# resolve @curi/ingestion, so we copy those first (keeps the install
# layer cache-friendly across src-only edits).

# ─── Builder: compile TypeScript ────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
RUN corepack enable

# Playwright is listed as an ingestion dep for future use, but no
# scraper imports it today — skip the ~300MB chromium download. Flip
# this off (or remove) the day a scraper actually needs a headless
# browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy workspace manifest first — lets Docker cache `pnpm install` when
# only src/ files change (which is most commits).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ingestion/package.json packages/ingestion/

# Install ingestion's deps (+ its workspace ancestors, though it has
# none yet). --frozen-lockfile keeps Railway builds deterministic.
RUN pnpm install --frozen-lockfile --filter @curi/ingestion...

# Now pull source and compile.
COPY packages/ingestion packages/ingestion
RUN pnpm --filter @curi/ingestion build

# ─── Runtime: only what we need to `node cli.js` ────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app
RUN corepack enable

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Re-install production deps against the same lockfile in a clean layer.
# Cheaper than copying node_modules from builder (avoids the dev deps).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/ingestion/package.json packages/ingestion/
RUN pnpm install --frozen-lockfile --prod --filter @curi/ingestion...

# Compiled JS from the builder.
COPY --from=builder /app/packages/ingestion/dist packages/ingestion/dist

# Railway's cron trigger will run this command at the schedule defined
# in railway.json. Each invocation is a fresh container — STATUS.md and
# unmapped_artists.log are ephemeral. If we need persistent run history
# later, add an `ingestion_runs` table on the Supabase side.
CMD ["node", "packages/ingestion/dist/cli.js"]
