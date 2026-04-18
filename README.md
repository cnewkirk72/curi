# Curi

NYC electronic music events, filtered by genre and vibe. Installable PWA.

## Stack

- **apps/web** — Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui, shipped as a PWA
- **packages/ingestion** — Playwright-based scraper + MusicBrainz enrichment, runs on cron (Railway planned)
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

- Web: Vercel (Next.js preset)
- Ingestion: Railway cron (Playwright-ready container)
- DB/Auth: Supabase (project `Curi`, region `us-east-1`)
