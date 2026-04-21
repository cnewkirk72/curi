# Curi — Project Context

Handoff document for future Cowork sessions. Read this first to get up to
speed on what Curi is, how it's architected, what's shipped, and where the
sharp edges are.

---

## What Curi is

Curi is a PWA that curates upcoming live-music events in NYC, filtered by
**genre**, **subgenre**, and **vibe**. Originally scoped to electronic, as
of Phase 3.15 it covers all genres (rock/pop/jazz/hip-hop/metal/folk/latin
parents exist in the taxonomy). The MVP is live.

### Unique value in the event-curation space

Most NYC event discovery (RA, Dice, Eventbrite, Shotgun) gives you a flat
list sorted by date or venue. Curi's differentiator is **structured
multi-dimensional filtering** powered by an AI-enriched artist catalog:

- Every artist on the lineup is tagged on three orthogonal axes — `genres`
  (parent), `subgenres` (specific), and `vibes` (musical character:
  Melodic, Hypnotic, Dark, Driving, …). Filters combine freely: "deep
  house + hypnotic" returns a different set than "deep house + driving".
- Vibes are curated as musical-character descriptors only, not venue
  atmospherics — that separation is load-bearing. Don't conflate.
- Genres roll up from the artist layer to the event layer via the
  `events-reaggregate.ts` script, so events inherit their lineup's tags.
- The taxonomy grows on its own. When a scraper surfaces a MusicBrainz or
  Spotify tag without a mapping, the smart-genre layer slots it under the
  closest parent automatically rather than dropping it to a
  human-review log.

**Design aesthetic:** Midnight + Cyan (dark mode first, cyan accent). See
`design-system/` for tokens.

---

## Stack (non-negotiable)

- **apps/web** — Next.js 14 App Router, TypeScript, Tailwind, shadcn/ui,
  shipped as a PWA (manifest + service worker + offline route).
- **packages/ingestion** — TypeScript ingestion worker. Scrapers +
  MusicBrainz + Spotify + LLM enrichment. Runs on Railway cron.
- **supabase/** — Postgres migrations, RLS policies, seed data.
- **pnpm workspaces** at the repo root.

Don't propose alternative stacks (Astro, Next 15, Drizzle, Prisma, etc.)
without being asked — Christian picked this deliberately.

---

## Hosted infrastructure

- **GitHub repo:** `cnewkirk72/curi` (private, main-branch development)
- **Supabase project:** `Curi`, ref `gnglasgrlgervpgqwrvj`, org `CN Org`
  (`rfixgvusegjarptrfqui`), region `us-east-1`
- **Web host:** Vercel, region `iad1` (pinned via `apps/web/vercel.json`
  to co-locate with Supabase)
- **Ingestion host:** Railway cron, nightly 10:00 UTC (06:00 ET), driven
  by root `Dockerfile` + `railway.json`
- **Vercel and Railway never talk to each other.** Both hit Supabase
  with different keys. Railway uses the service-role key (bypasses RLS,
  server-only) for writes. Vercel uses the anon key (RLS-gated) for
  reads. Google OAuth establishes the user session on the Vercel domain.

---

## Repo layout

```
apps/web/
  src/app/              App Router routes: events, saved, profile, login, auth, offline
  src/components/       UI components + shadcn primitives
  src/lib/              events.ts (feed query), saves.ts (user saves), supabase client, utils
  src/middleware.ts     Auth middleware

packages/ingestion/
  src/scrapers/
    aggregators/        ra-nyc.ts (Resident Advisor GraphQL)
    venues/             elsewhere.ts, nowadays.ts, public-records.ts
  src/                  All enrichment + orchestration modules (see below)

supabase/migrations/    0001–0014 applied
```

---

## Data model (key tables)

**events**
- `id, slug, title, starts_at, ends_at, venue_id, source, source_url`
- Aggregated from lineup: `genres[]`, `subgenres[]`, `vibes[]`
- Filled by `events-reaggregate.ts`, not by scrapers directly

**artists**
- `id, slug, name`
- `genres[], subgenres[], vibes[]` — canonical arrays, written by enrichment
- `mb_tags jsonb` — raw MusicBrainz signal
- `last_enriched_at, enrichment_confidence` — `high|medium|low|very-low`
- Spotify columns (0012): `spotify_id, spotify_url, spotify_image_url,
  spotify_popularity, spotify_followers, spotify_discovery_failed_at`
- Popularity columns (0010): `soundcloud_url, soundcloud_followers,
  bandcamp_url, bandcamp_followers`

**event_artists** — `(event_id, artist_id, position, is_headliner)`

**venues** — `slug, name, address, default_genres[], default_vibes[]` —
  defaults feed the enrichment prompt as prior-evidence context

**taxonomy** / **taxonomy_subgenres** / **taxonomy_map** — the genre
  vocabulary. `taxonomy_map` maps raw MB/Spotify tag strings →
  canonical taxonomy entries. `taxonomy_subgenres` carries auto-created
  subgenre rows with `parent_taxonomy_id` FK.

**user_prefs** (0005, extended 0014) — per-user taste + onboarding
  state. Columns: `preferred_genres[]`, `preferred_vibes[]`,
  `preferred_subgenres[]` (0014), `default_when`
  (`'weekend'|'tonight'|'week'|NULL`), `notify_artist_drops`,
  `location_opt_in`, `calendar_opt_in`, `onboarding_completed_at`.
  The completion stamp is what the middleware gate reads to decide
  whether to bounce signed-in users to `/onboarding`.

**profiles** (0013) — public-read identity: `username` (citext,
  unique), `display_name`, `avatar_url`, timestamps. Seeded on
  `auth.users` insert via the `handle_new_user` trigger — by the
  time a signed-in user hits any app route, their profile row
  always exists. Avatar uploads land in Supabase Storage under
  the `avatars/` bucket, per-user folder, with RLS that scopes
  writes to `auth.uid()::text` as the prefix.

**saves** — user ↔ event saves for the profile/saved page.

---

## Connected tools + APIs + MCPs

- **Supabase MCP** — direct SQL + migration tooling. Used for verification
  and surgical data fixes. Don't use it for DDL on prod without thinking
  through RLS implications.
- **MusicBrainz API** — artist tag signal. UA `Curi/0.1 (cmitsuo7@yahoo.com)`,
  strict 1 req/sec rate limit. Noisy for underground acts.
- **Spotify Web API** — `/v1/search` + `/v1/artists/{id}` via Client
  Credentials. **Important:** Spotify stripped `popularity`, `genres`,
  and `followers` from `/v1/artists/{id}` for apps registered after Nov
  27, 2024. Our app pre-dates that cutoff so we still get full data.
  Client Credentials quota is tight — see "Known sharp edges" below.
- **Anthropic API** — Claude Sonnet 4.6 for LLM enrichment with tool-use.
  Prompt caching on system + tools (ephemeral, ~90% cache hit savings on
  backfill). Model string `claude-sonnet-4-6`.
- **Exa** — neural search. Used as the `search_web` and `find_artist_profile`
  tools.
- **Firecrawl** — structured scrape of SoundCloud/Bandcamp artist profiles
  for self-authored hashtags + follower counts.
- **GitHub MCP** — PRs, commits, file ops. Christian's account.

---

## Enrichment pipeline (Phase 4)

The heart of Curi's differentiation. Given an artist name + event context,
Sonnet returns `{ genres, subgenres, vibes, confidence, sources, reasoning }`.

### Escalation flow (lowest cost first)

1. **Spotify lookup.** Search by name, fetch full artist object, extract
   genres/popularity/followers/image. Confidence tiers: `high`
   (exact-name match + popularity ≥ 10), `medium` (exact-name, low
   popularity), `low` (fuzzy only — we reject these to avoid wrong-artist
   tagging). Fires first so the LLM has prior evidence.
2. **Training knowledge.** For artists Claude knows from training (~60%),
   returns tags directly.
3. **Web search** via Exa (~25%). Kicks in when training is thin.
4. **Profile self-tag fetch** via Firecrawl (~15%). Gated on
   electronic-ish context so we don't waste credits scraping folk/jazz
   acts' SoundCloud.

Tools exposed to Sonnet: `search_web`, `find_artist_profile`,
`fetch_artist_self_tags`, and one terminal tool `submit_enrichment`.

### Fuzzy taxonomy merging

Proposed subgenre strings go through a three-tier check before DB write:

1. Canonical exact match (lowercase, strip punct) → merge
2. Levenshtein near-match against existing entries → merge (spelling
   drift like "hardtranse" → "hard-trance")
3. Else falls through to smart-add, creating a new subgenre under the
   closest parent

### Stall fallback

If Sonnet burns 6 tool iterations without calling `submit_enrichment`, we
inject a nudge + pin `tool_choice` to force-submit. Those rows get
`confidence='very-low'` and `stalled=true` in the log regardless of what
the model claimed.

### Consecutive search_web cap

After 4 consecutive `search_web` calls, the 5th short-circuits with an
`is_error` result to force a tool pivot. Prevents obscure-artist search
spirals.

---

## Scrapers (current inventory)

All run nightly at 10:00 UTC on Railway. Polite delays via
`INGEST_POLITE_DELAY_MS` (default 1500ms).

| Source | Type | File | Notes |
|---|---|---|---|
| Resident Advisor NYC | GraphQL aggregator | `scrapers/aggregators/ra-nyc.ts` | Uses RA's internal GraphQL. Also carries genre hints that flow through `taxonomy_map`. |
| Elsewhere | Venue HTML | `scrapers/venues/elsewhere.ts` | |
| Nowadays | Venue HTML | `scrapers/venues/nowadays.ts` | |
| Public Records | Venue HTML | `scrapers/venues/public-records.ts` | |

Orchestrated by `packages/ingestion/src/runner.ts` and `cli.ts`. Artist
name extraction is in `artist-parsing.ts` with a noise-list filter —
some scraper-junk still occasionally slips through (see "Sharp edges").

---

## Current status (as of 2026-04-20)

### Phase 5 (personalization foundations) — partial ship

Shipped as one coherent bundle so the onboarding handoff to the
personalized feed lands cleanly:

- **5.1 — Profile completion.** `profiles` table (migration 0013)
  with public-read RLS + `handle_new_user` trigger. Username
  (citext unique), display name, avatar. `<ProfileForm>` renders
  inline on `/profile`; Google OAuth avatar is the default and can
  be replaced via Supabase Storage upload (`avatars/{user_id}/*`).
- **5.2 — `/onboarding` flow.** Five-step wizard
  (welcome → signin → genres → vibes → when → ready) with
  fire-and-forget server actions on each advance. Returning but
  unfinished users get hydrated from their existing
  `user_prefs` draft. Skip-for-now path preserves local state for
  anon users.
- **5.4 — Dynamic subgenre pills.** Shared `<SubgenrePicker>`
  component used by both the filter sheet and the genres step of
  onboarding. Parent-selection animates in only the relevant
  subgenre rows; curated map lives in `lib/filters.ts`.
- **Onboarding redirect gate.** Middleware (phase 5.6, task #6)
  checks `user_prefs.onboarding_completed_at` on every signed-in
  request and bounces un-onboarded users to `/onboarding`. A
  `curi_onboarded=1` cookie short-circuits the DB roundtrip after
  the first confirmation. The sign-out action clears the cookie so
  a new session correctly re-checks. `/auth/callback` short-circuits
  the middleware hop by inspecting `onboarding_completed_at`
  directly and routing to `/onboarding` or `/events` (or `next`).
- **5.3 — Sorting options (popularity / preference overlap / time-
  decay weighting) is NOT shipped** in this phase. Deferred to a
  follow-up — needs an `events.popularity_score` numeric column
  plus a ranking path in `events.ts`. Flagged here so the roadmap
  entry doesn't read as complete when it isn't.

### Phase 4 is complete

- **1478 artists enriched.** Tier distribution: 181 high, 1012 medium,
  212 low, 79 very-low. ~99.6% have genres + subgenres + vibes populated.
- **Spotify data on 512 artists** (34% of catalog). Remaining 967 either
  had no match, aren't really artists, or got skipped during the tonight's
  rate-limit cooldown.
- **305 artists marked `spotify_discovery_failed_at`** — follow-up
  backfill queued for when the Spotify Client Credentials quota resets.
- **Events re-aggregated.** 714 upcoming events, 664 have rolled-up
  genres (93%).
- **UI shipped** (commit `a9f8ca3`): artist avatars in `EventCard`,
  popularity badges in `LineupList`, Spotify images via the nested
  PostgREST select in `saves.ts` + `events.ts`.

### Prior phases (merged + live)

- Phase 1: schema + Supabase + seed taxonomy
- Phase 2: scrapers + smart-genre inference + Railway cron
- Phase 3: apps/web (home feed, event detail, filter sheet, saved,
  profile, login, Google OAuth, PWA, responsive)
- Phase 4: full enrichment pipeline (Spotify + LLM + Firecrawl + backfill)
- Phase 5 (partial, see above): 5.1 profile, 5.2 onboarding,
  5.4 dynamic subgenre pills, onboarding redirect gate

---

## Tabled / flagged for future implementation

### Immediate punch list

- **Targeted Spotify-only follow-up pass** (tomorrow, once cooldown clears).
  Simple script: `SELECT id, name FROM artists WHERE spotify_url IS NULL
  AND last_enriched_at IS NOT NULL`, call `searchArtistOnSpotify`, write
  back 4 Spotify columns. ~200ms/artist. No LLM, no Firecrawl.
- **Scraper noise-list hardening.** 6 non-artist rows slipped through
  tonight (e.g., "2026", "EarthFest '26", "Opening Day - Sun. May 17th").
  Rare — the LLM stall fallback catches them and tags `very-low` so
  they're easy to audit — but could be prevented forward via regex
  additions for strings with digits, venue terms, or month names.

### Known sharp edges

- **Spotify Client Credentials quota is tight.** During tonight's
  backfill at concurrency 8 we burned through quota and Spotify returned
  `retry-after: 76970` (21.4 hours). The code now caps retry-after at 30s
  and aborts the artist if Spotify wants longer (commit pending push).
  There's also a 15s `Promise.race` timeout on `safeSpotifyLookup` for
  stalled TCP/DNS cases. If a future bulk pass is needed, run at
  `--concurrency ≤ 4` with `MIN_INTERVAL_MS = 400` in `spotify.ts`.
- **Spotify's Nov 2024 field restriction.** Post-Nov 2024-registered apps
  get empty genres/popularity/followers back from `/v1/artists/{id}`.
  Curi's app pre-dates the cutoff; if we ever re-register, we lose that
  signal. Preserve the current app credentials.
- **MusicBrainz is noisy for underground NYC acts.** Don't treat MB
  tags as authoritative — the LLM layer is the source of truth for tags.
- **`last_enriched_at` bumps on every enrichment.** If running a
  follow-up pass, scope by `enrichment_confidence IS NULL` or by a
  specific condition — don't rely on the timestamp as a "hasn't been
  touched yet" filter.
- **Per-artist JSON checkpointing in backfill.** `backfill-run.ts`
  writes to `/tmp/curi-backfill-*.json` after every artist. If a run
  stalls, the DB state is durable; use SQL to reset just the unenriched
  rows (`UPDATE artists SET last_enriched_at = NULL WHERE
  enrichment_confidence IS NULL`) and rerun without `--force`.

### Deferred features (captured in `curi_roadmap.md`)

The full roadmap — sorting, onboarding, dynamic pills, desktop UI,
playlist player, label-site scrapers, vector viz, venue feedback —
lives in `curi_roadmap.md`. That doc prioritizes them into phases by lift.

---

## Collaboration notes

- **Flag uncertain inclusions loudly.** If unsure whether something
  belongs (a venue, a dependency, a feature scope item), call it out at
  the decision point rather than burying a caveat in a comment.
  Christian would rather cut than silently absorb.
- **No alternative stacks.** The Next 14 / Supabase / Tailwind / pnpm
  stack is deliberate. Don't propose swaps.
- **Use the Supabase MCP for verification.** It's the fastest way to
  confirm what actually landed in prod. Don't guess from code — query.
- **Commits from the sandbox fail.** Git identity isn't configured and
  we're not allowed to set it. Give Christian the commit command and
  have him run it from his terminal.
- **Railway cron is the ingestion deploy target.** Changes to
  `packages/ingestion/` need to be pushed to `main` for the nightly run
  to pick them up.

---

## Files worth reading on a fresh start

In priority order:

1. `README.md` — stack, local dev, deploy, architecture diagram
2. `packages/ingestion/src/backfill-run.ts` — the orchestrator, reads
   like a table of contents for the enrichment pipeline
3. `packages/ingestion/src/llm-enrichment.ts` + `anthropic.ts` — the
   tool-use loop and its quirks (cache, stall fallback, search cap)
4. `packages/ingestion/src/spotify.ts` — Spotify client, throttle,
   retry-after cap
5. `apps/web/src/lib/events.ts` + `saves.ts` — how the feed query is
   shaped and what fields the UI expects from PostgREST
6. `supabase/migrations/0013_profiles_and_avatars.sql` +
   `0014_user_prefs_onboarding.sql` — the Phase 5 schema changes
   (profiles/OAuth trigger/avatars Storage, then user_prefs
   extensions for onboarding state)
7. `apps/web/src/app/onboarding/onboarding-flow.tsx` — the client
   state machine that orchestrates the 5-step onboarding, plus
   the co-located `actions.ts` for the server-action surface
8. `apps/web/src/lib/supabase/middleware.ts` — the session-refresh
   helper + onboarding redirect gate (cookie-cached completion flag)
9. `PHASE_4_PLAN.md` — for historical context on why the pipeline is
   shaped the way it is
