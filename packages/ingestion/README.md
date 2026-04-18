# @curi/ingestion

Playwright-driven venue scrapers + MusicBrainz enrichment. Runs on cron (Railway).

## Design

```
RawEvent  ──►  normalizer.upsertEvent  ──►  events (upsert on source, source_id)
                                         │
artist parsing ──►  artists ──► MusicBrainz ──► mb_tags ──► taxonomy_map ──► artists.genres/flavors
                                                                              │
                                                                  event rollup (headliner 2×)
                                                                              ▼
                                                                   events.genres / events.flavors
```

- **Rate limits**: MusicBrainz is 1 req/sec, strict. Venues get a 1.5s polite delay.
- **Resilience**: every scraper wraps in try/catch and appends to `STATUS.md`. A Cloudflare challenge or aggressive rate limit means *skip + log*, never fight.
- **Artist parsing heuristics**: `X b2b Y`, `X, Y, Z`, `presents: X + Y`, `X (live)`, `support: A, B`.

## Scrapers shipped in Phase 2

1. Public Records (`src/scrapers/venues/public-records.ts`)
2. Nowadays (`src/scrapers/venues/nowadays.ts`)
3. Elsewhere (`src/scrapers/venues/elsewhere.ts`)
4. Shotgun NYC (`src/scrapers/shotgun.ts`) — expect fragility

## Local run

```bash
pnpm install                                           # from repo root
cp ../../.env.example ../../.env.local                 # fill in SERVICE_ROLE key
pnpm ingest --sources=all
pnpm ingest --sources=venue:public-records,shotgun     # subset
```

## Railway cron deploy (Phase 4)

- Container image with `mcr.microsoft.com/playwright:v1.48.1-jammy` as base
- Cron: hourly for Shotgun, every 6h for venues
- `SUPABASE_SERVICE_ROLE_KEY` injected as Railway secret
- Logs to Railway + append to `STATUS.md` committed back via GitHub Action (TBD)
