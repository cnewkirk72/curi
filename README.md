# Curi

NYC electronic music events, filtered by genre and vibe. Installable PWA.

## Stack

- **apps/web** — Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui, shipped as a PWA
- **packages/ingestion** — fetch-based scrapers + MusicBrainz enrichment, runs on Railway cron
- **supabase/** — Postgres migrations, RLS policies, seed data
- Package manager: **pnpm workspaces**

## Status

MVP — live. Web on Vercel, ingestion on Railway, Postgres + Auth on Supabase.
See `STATUS.md` in `packages/ingestion/` for the latest scraper run log.

## Local dev

```bash
pnpm install
cp .env.example .env.local      # fill in real values
pnpm dev                         # runs apps/web on :3000
pnpm ingest --sources=all        # one-off ingestion run
```

See `apps/web/README.md` and `packages/ingestion/README.md` for details.

## Deploy

- **Web** — Vercel (Next.js preset), region `iad1` (pinned via
  `apps/web/vercel.json`) to co-locate with Supabase `us-east-1`.
- **Ingestion** — Railway cron (live), driven by the root-level `Dockerfile`
  and `railway.json`. Ships only the compiled `packages/ingestion/dist/` +
  production deps. See setup below.
- **DB/Auth** — Supabase (project `Curi`, region `us-east-1`).

### Architecture

```
                         ┌──────────────────────────┐
                         │      Supabase (DB)       │
                         │  Postgres + Auth + RLS   │
                         └──┬───────────────────┬───┘
         ┌──────────────────┘                   │
         │ service-role key (writes)            │ anon key (reads, scoped by RLS)
         │ server-only                          │ + OAuth via browser
  ┌──────▼──────────┐                   ┌───────▼──────────┐
  │  Railway cron   │                   │  Vercel (Next)   │
  │  @curi/ingestion│                   │  @curi/web (PWA) │
  │  nightly 10 UTC │                   │  public routes + │
  │  scrapers + MB  │                   │  Google OAuth    │
  └─────────────────┘                   └──────────────────┘
```

Vercel and Railway never talk to each other directly. Both hit Supabase with
different keys: Railway uses the service role key (bypasses RLS, server-only)
to write events; Vercel uses the anon key (RLS-gated) to read them, and the
Google OAuth flow establishes the user's session. Auth cookies live on the
Vercel domain; the ingestion worker is completely auth-agnostic.

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

### Web (Vercel)

The app is live. These are the one-time setup steps; re-read if you ever
need to re-provision the Vercel project from scratch.

**1. Vercel project**
- Vercel dashboard → **Add New → Project** → import `cnewkirk72/curi`
- **Framework preset:** Next.js (auto-detected; also pinned by
  `apps/web/vercel.json`)
- **Root directory:** `apps/web` — critical; without it Vercel tries to
  build from the repo root and fails with "no framework detected"
- **Build command:** leave default (`next build`). pnpm workspaces resolve
  automatically because `pnpm-workspace.yaml` is at the repo root and
  Vercel detects the monorepo
- **Install command:** Vercel auto-detects pnpm from `packageManager` in
  the root `package.json`; no override needed
- **Region:** `iad1` — pinned via `apps/web/vercel.json` so RSC and Server
  Actions land in the same AWS region as Supabase `us-east-1`
- **Node version:** 20.x (matches the Railway ingestion build)

**2. Environment variables** (Project Settings → Environment Variables)

Set for all three envs (Production, Preview, Development):

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | same URL as Railway's `SUPABASE_URL` | Exposed to browser; safe |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API → `anon` key | Browser-visible; RLS gates all reads |

> **Never** put `SUPABASE_SERVICE_ROLE_KEY` on Vercel. It bypasses RLS and
> would give anyone with browser devtools full DB access. Service role stays
> on Railway only.

**3. Supabase — update Auth URL config for production**

Dashboard → Authentication → URL Configuration:

- **Site URL:** `https://<your-vercel-domain>` (Vercel gives you one free
  `*.vercel.app` domain; swap to your apex once you buy one)
- **Redirect URLs** (add all three):
  - `https://<your-vercel-domain>/auth/callback` — production
  - `https://*-cnewkirk72.vercel.app/auth/callback` — preview deploys
  - `http://localhost:3000/auth/callback` — local dev

**4. Google OAuth provider** (Supabase → Authentication → Providers → Google)

You already have a Google Cloud project. In GCP:

- **APIs & Services → Credentials → + Create credentials → OAuth client ID**
- **Application type:** Web application
- **Authorized redirect URIs:** add `https://<supabase-ref>.supabase.co/auth/v1/callback`
  (Supabase shows you the exact URL on the Google provider settings page)

Paste the Client ID + Client Secret back into Supabase's Google provider
settings. Toggle "Enable Sign in with Google" on.

**5. First deploy verification**
- Trigger a Preview deploy by opening a PR, or Production by pushing to `main`
- Visit the URL, click Sign in with Google, confirm the redirect lands back
  on `/auth/callback` and a Supabase session is established
- Check Supabase → Authentication → Users — your Google account should appear
- Home feed should render events written by the Railway cron

**Troubleshooting**
- *"Invalid redirect URL" from Supabase:* the exact URL you're redirecting to
  must be in the Redirect URLs allow-list — wildcards supported but the
  pattern has to match
- *Build fails with "Cannot find module @curi/..."*: root directory is probably
  wrong. It should be `apps/web`, not the repo root
- *OAuth succeeds but feed is empty*: RLS is probably too strict on the
  `events` table; verify the anon role has `SELECT` policy for public events
