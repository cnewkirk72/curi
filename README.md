# Curi

NYC electronic music events, filtered by genre and vibe. Installable PWA.

## Stack

- **apps/web** — Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui, shipped as a PWA
- **packages/ingestion** — fetch-based scrapers + MusicBrainz enrichment, runs on Railway cron
- **supabase/** — Postgres migrations, RLS policies, seed data
- Package manager: **pnpm workspaces**

## Status

Phase 1 — scaffolding in progress. See `STATUS.md` in `packages/ingestion/` for scraper run logs (created after first run).

## Local dev

```bash
pnpm install
cp .env.example .env.local      # fill in real values
pnpm dev                         # runs apps/web on :3000
pnpm ingest --sources=all        # one-off ingestion run
```

See `apps/web/README.md` and `packages/ingestion/README.md` for details.

## Deploy

- **Web** — Vercel (Next.js preset). Not wired up yet; spins up in Phase 3
  once `apps/web` has real pages to serve.
- **Ingestion** — Railway cron, driven by the root-level `Dockerfile` and
  `railway.json`. Ships only the compiled `packages/ingestion/dist/` +
  production deps. See setup below.
- **DB/Auth** — Supabase (project `Curi`, region `us-east-1`).

### Railway cron (ingestion)

The repo has a root `Dockerfile` and `railway.json` that together describe
the deploy. To stand it up in Railway:

1. **New project → Deploy from GitHub repo**, pick `cnewkirk72/curi`,
   default branch `main`. Railway reads `railway.json` and builds from the
   `Dockerfile` automatically.
2. **Variables** — set these on the service (Settings → Variables):
   - `SUPABASE_URL` — copy from Supabase project settings
   - `SUPABASE_SERVICE_ROLE_KEY` — service role key (never exposed to the
     web app; ingestion only)
   - `MUSICBRAINZ_USER_AGENT` — `Curi/0.1 (cmitsuo7@yahoo.com)` or your
     contact per MB's ToS
   - `INGEST_DEFAULT_SOURCES` — `all` (or a comma-separated subset)
   - `INGEST_POLITE_DELAY_MS` — `1500`
3. **Cron schedule** — `railway.json` sets `cronSchedule: "0 10 * * *"`
   (nightly at 10:00 UTC = 06:00 ET). Adjust in the Railway UI if you want
   a different cadence.
4. **First run** — trigger manually via the Railway dashboard to confirm
   env vars are set correctly and the ingest summary shows non-zero
   events. Subsequent runs fire on the cron.

Each invocation is a fresh container — `STATUS.md` and
`unmapped_artists.log` live only for the duration of one run. Railway's
log view is the durable source of truth; if we need persistent run
history later, add an `ingestion_runs` table in Supabase.

### Local smoke of the production image

```bash
docker build -t curi-ingest .
docker run --rm --env-file .env curi-ingest
```
