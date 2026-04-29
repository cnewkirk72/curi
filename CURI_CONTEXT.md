# Curi — Project Context

Handoff document for future Cowork sessions. Read this first to get up to
speed on what Curi is, how it's architected, what's shipped, and where the
sharp edges are.

---

## What Curi is

Curi is a PWA that curates upcoming live-music events in NYC, filtered by
**genre**, **subgenre**, **vibe** (artist-mood), and **setting**
(event-context). Originally scoped to electronic; as of Phase 3.15 it
covers all genres (rock/pop/jazz/hip-hop/metal/folk/latin parents exist
in the taxonomy). The MVP is live, the filter taxonomy was rebuilt in
Phase 3.18, the desktop responsive refactor (Phase 6.1) shipped, the
SoundCloud/Bandcamp avatar fallback (Phase 4f.1) closed the biggest
remaining hero-image gap, and as of 2026-04-27 there's an iOS native
shell distributed via TestFlight (v0.1.1) with native Google Sign-In.

### Unique value in the event-curation space

Most NYC event discovery (RA, Dice, Eventbrite, Shotgun) gives you a flat
list sorted by date or venue. Curi's differentiator is **structured
multi-dimensional filtering** powered by an AI-enriched artist catalog:

- Every artist on the lineup is tagged on three orthogonal axes — `genres`
  (parent), `subgenres` (specific), and `vibes` (artist musical character:
  Groovy, Hypnotic, Dark, Driving, …). Filters combine freely: "deep
  house + hypnotic" returns a different set than "deep house + driving".
- A fourth axis, `setting`, captures event-context (warehouse, basement,
  daytime, peak-time, late-night, outdoor, underground). Distinct from
  `vibes` because it's produced by a different pipeline — deterministic
  derivation from venue + start-time + lineup-follower totals, not LLM
  tagging. The two layers share UI real estate but are intentionally
  decoupled in the data model.
- Genres roll up from the artist layer to the event layer via the
  `events-reaggregate.ts` script, so events inherit their lineup's tags.
- The taxonomy grows on its own. When a scraper surfaces a MusicBrainz or
  Spotify tag without a mapping, the smart-genre layer slots it under the
  closest parent automatically rather than dropping it to a
  human-review log. **Genre normalization** runs on every ingestion write
  via `packages/ingestion/src/genre-normalizer.ts` (Phase 3.18) — junk
  slugs (descriptors, country tags, label names) are dropped, typos
  renamed, wrong-granularity slugs (industrial, hardcore, psychedelic)
  demoted from parent-genre to subgenre with the canonical parent added.
- Filter UI personalizes by user preferences: signed-in users see their
  onboarding-picked genres + vibes bubble to the front of the visible
  pill rows, with a "More genres" disclosure for the long tail.

**Design aesthetic:** Midnight + Cyan (dark mode first, cyan accent). See
`design-system/` for tokens.

---

## Stack (non-negotiable)

- **apps/web** — Next.js 14 App Router, TypeScript, Tailwind, shadcn/ui,
  shipped as a PWA (manifest + service worker + offline route). Also
  the source for the **iOS native shell** — Capacitor 8 wraps the same
  Next.js build for App Store distribution (`apps/web/ios/`,
  `apps/web/capacitor.config.ts`; both untracked locally as of
  2026-04-27, see "Tabled" punch list).
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
- Aggregated from lineup: `genres[]`, `vibes[]` (artist-mood)
- `setting[]` (Phase 3.18, migration 0017) — derived event-context tags:
  warehouse, basement, outdoor, daytime, peak-time, late-night, underground.
  Populated deterministically (no LLM) by SQL update over venue + start-time
  + lineup follower totals; rule documented in migration 0018's comment.
  Distinct GIN index `events_setting_gin` for filter overlap queries.
- `image_url` — optional hero image; falls back through headliner Spotify
  avatar → any-lineup avatar → `venue.image_url` → genre-tinted gradient
  per the Phase 3.17 fallback chain in `apps/web/src/components/event-card.tsx`.
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
- External-image columns (0020, Phase 4f.1): `soundcloud_image_url,
  bandcamp_image_url`. Hot-linked CDN URLs (i*.sndcdn.com,
  f*.bcbits.com) — not mirrored to Storage. Backstop the
  `spotify_image_url ?? soundcloud_image_url ?? bandcamp_image_url
  ?? initials` cascade in `lineup-list.tsx` and the EventCard hero
  fallback chain. As of 2026-04-25: 700 Spotify / 403 SC / 79 BC
  avatars across 1863 artists (~63% covered before initials).

**event_artists** — `(event_id, artist_id, position, is_headliner)`

**venues** — `slug, name, address, default_genres[], default_vibes[],
  image_url` (0016) — defaults feed the enrichment prompt as
  prior-evidence context. `image_url` is consumed by the EventCard hero
  fallback chain when the event has no `image_url` and no lineup artist
  has a Spotify avatar; the per-venue backfill is queued (#43) but not
  yet applied — Public Records, Apollo Studio, Outer Heaven, Jupiter
  Disco, Bossa Nova are the highest-impact venues to seed.

**taxonomy** / **taxonomy_subgenres** / **taxonomy_map** — the genre
  vocabulary. `taxonomy_map` maps raw MB/Spotify tag strings →
  canonical taxonomy entries. `taxonomy_subgenres` carries auto-created
  subgenre rows with `parent_taxonomy_id` FK.

**user_prefs** (0005, extended 0014, 0019) — per-user taste + onboarding
  state. Columns: `preferred_genres[]`, `preferred_vibes[]`,
  `preferred_setting[]` (0019), `preferred_subgenres[]` (0014),
  `default_when` (`'weekend'|'tonight'|'week'|NULL`),
  `notify_artist_drops`, `location_opt_in`, `calendar_opt_in`,
  `onboarding_completed_at`. The completion stamp is what the
  middleware gate reads to decide whether to bounce signed-in users
  to `/onboarding`. Pref-aware sort (Phase 3.18) reads
  `preferred_genres`/`preferred_vibes` server-side on the home page
  and bubbles those slugs to the front of the filter pill rows.

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

## Current status (as of 2026-04-28)

### Phase 6 (desktop + discovery polish) — 6.3 v2 actively in progress

- **6.1 — Desktop responsive refactor — shipped.** Sticky left
  filter sidebar at `lg`+ breakpoint (`apps/web/src/components/desktop/
  desktop-sidebar-filters.tsx`), wider event cards, top-nav for
  desktop. Mobile filter sheet remains for < lg. URL is still the
  source of truth for filter state on both layouts; same
  `serializeFilters` / `parseFilters` round-trip.
- **6.2 — Date selector — shipped.** Custom single-date picker
  (`components/date-picker.tsx`) inline in the desktop sidebar +
  collapsed disclosure on mobile sheet. Selecting a date sets
  `when='custom'` with `date_from = picked day` and `date_to = null`
  for an open-ended "from X onward" window. Round-trips through the
  `?when=custom&from=YYYY-MM-DD` URL param. Date math handles NYC DST
  via `Intl.DateTimeFormat` shortOffset sampling. Subsequent
  refactor by Ahmed (commit `fab72f8`) compressed the picker file
  ~330 lines and reworked the mobile header into a sticky glass
  bar; `a86e6f3` followed up with a calendar-view tweak.
- **6.3 — Search — shipped (basic).** Ahmed shipped a `GlobalSearch`
  component (`apps/web/src/components/global-search.tsx`, commit
  `87ced38`) that debounces input by 350ms and pushes a `?q=` URL
  param; `getUpcomingEvents` adds a server-side `ilike` on
  `events.title` (LIKE-meta-escaped). **Title-only.**
- **6.3 v2 — Smart search with live previews — actively in progress.**
  Replaces the title-only ilike with cross-entity typeahead: events
  (max 10) + artists (max 5) + venues (max 3) returned in one Postgres
  RPC `search_suggestions(q text)` backed by `pg_trgm` GIN indexes for
  typo tolerance. Entity detection adds a "Show events with [Artist]"
  button (violet pill) and "Show events at [Venue]" button (amber
  pill). New `?artist=<slug>` and `?venue=<slug>` URL params plumbed
  through `serializeFilters` / `parseFilters`. Subtasks 6.3.2–6.3.6
  shipped; remaining work is the final wiring + a11y polish.

### Phase 3 polish + maintenance — multiple shipped

- **3.15 — NYC-wide expansion — shipped.** Taxonomy seeded with
  rock/pop/jazz/hip-hop/metal/folk/latin parents; the smart-genre
  layer auto-creates new top-level genres when MB tags don't match
  any existing parent.
- **3.16 — Pre-insert dedup — shipped.** Migration 0015 +
  `find_dupe_event_by_artist` Postgres function. Pre-insert check in
  the scraper pipeline collapses cross-source duplicates (RA + venue
  + Eventbrite reporting the same show) by `(venue_id, starts_at,
  artist-slug-overlap)`.
- **3.17 — Hero fallback chain — shipped.** EventCard cascades
  through event.image_url → headliner Spotify avatar → any lineup
  Spotify avatar → venue.image_url → genre-tinted gradient. Migration
  0016 added `venues.image_url`. Of 93 events without an event hero,
  ~55% are now rescued by the artist avatar fallback before hitting
  the venue or gradient layer.
- **3.18 — Filter vocabulary rebuild — shipped.** Genre vocabulary
  rebuilt from post-3.15 NYC-wide data (24 parents, default-14 row +
  10 in More-genres disclosure). Vibes refocused as artist-mood only
  (`adventurous` rename, `industrial` dropped). Setting filter
  introduced as a new orthogonal axis (`events.setting`, migration
  0017). `preferences-actions.ts` and lib/filters.ts updated; data
  cleaned via migration 0018 with audit backup; user_prefs split via
  0019. Genre normalizer (`packages/ingestion/src/genre-normalizer.ts`)
  guards every ingestion write boundary so future scrapes can't
  reintroduce junk.

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
- **5.3 — Sorting options — superseded by 5.6.** The original
  popularity / preference / time-decay spec was reframed in
  late 2026-04 around social-graph signals instead. SC and
  Spotify follow imports are higher-leverage personalization than a
  generic popularity score. The 5.3 spec is preserved in
  `curi_roadmap.md` for reference only; revisit only if 5.6
  underdelivers for SC-disconnected users.
- **5.6 — SoundCloud follow-graph personalized sort — actively in
  progress.** Username-only connect on `/profile`; imports the user's
  public SC follow graph and uses lineup overlap as a within-day sort
  signal with a "you follow [Artist]" badge. SC api-v2 with anon
  `client_id` first, Playwright headless fallback. Hybrid refresh
  (immediate sync + Sunday cron + lazy invalidation). 5–7 day estimate;
  blocks on 6.3 v2 shipping first. Full subtask spec lives in
  `curi_roadmap.md` §5.6.
- **5.7 — Spotify follow-graph personalized sort — queued after 5.6.**
  Architecturally distinct from 5.6: uses a **single Curi-side bot
  service-account `sp_dc` cookie** + per-user Spotify username. OAuth
  was ruled out (Spotify capped non-approved apps at 5 dev users in
  Feb 2026); pathfinder anon tokens were ruled out (don't authorize
  `queryArtistsFollowed`); per-user cookie paste was ruled out (high
  friction + heavy security commitment). Bot account works because
  Spotify treats followed-artists as readable to any authenticated
  viewer when the target's profile is public. Full spec in
  `curi_roadmap.md` §5.7. 4–5 day estimate.
- **5.8 — Ingestion source expansion — queued after 5.7.** Two new
  sources: Ticketmaster Discovery API (`tm-nyc`, `dmaId=345`,
  Ahmed has a working prototype — clean ship) and Eventbrite (needs a
  1–2h scoping spike first since their public search API may have
  been deprecated post-2020).

### Phase 4 is complete + Phase 4f.1 closes the avatar gap

- **~1880 artists enriched post-cleanup** (1478 → 1896 over Phase
  4f.7/4f.8/4f.9 + Phase 3.16 cross-source dedup; minus 28 phantom
  rows deleted across 4f.8 + 4f.10 audit-cleanup passes). ~99.6%
  have genres + subgenres + vibes populated.
- **Spotify data on 700 artists** (38% of catalog).
- **Events re-aggregated.** 714 upcoming events, 664 have rolled-up
  genres (93%).
- **UI shipped** (commit `a9f8ca3`): artist avatars in `EventCard`,
  popularity badges in `LineupList`, Spotify images via the nested
  PostgREST select in `saves.ts` + `events.ts`.

#### 4f.7–4f.10 — Artist-table audit infrastructure + phantom cleanup — shipped (rolled up to 2026-04-28)

Four iterative passes building a hardened deny architecture against
scraper-leaked event titles in the artists table.

- **4f.7** — Spotify rate-limit catchup after the burn (resumed
  2026-04-23 at concurrency 2; remaining queue cleared in ~4 min
  without re-burning the window).
- **4f.8** — Audit infrastructure: `audit.ts` (read-only categorize)
  + `audit-cleanup.ts` (per-category apply with backup). First
  pattern expansion in `EVENT_WORD_PATTERNS` + `NOISE_EXACT`.
  ~13 garbage rows deleted with cascade.
- **4f.9** — Bare-genre noise rows + the `parr?ty` typo-tolerant
  pattern across all "X party" matchers. Plural-weekday recurring
  series (must have a tail) and the `EXCLUDED_RA_VENUE_IDS` set
  to keep one canonical row per event.
- **4f.10 — Holistic pattern expansion + enrichment-signal rescue —
  shipped 2026-04-28 (PR #2, commit `3f65ceb`).** Three-tier
  architecture:
  - **Tier 1** — ~25 new patterns in `EVENT_WORD_PATTERNS` covering
    after-/day-/warehouse-party shapes, double-`party` titles,
    singular-weekday + genre bigrams, drag/silent-disco/bingo,
    decade-throwback (`like it's 2016`), locality fragments,
    airline/customer-service spam tells, leading `**`.
  - **Tier 2** — replaced the dead `spotify_popularity ≥ 20` rescue
    gate in `audit.ts` with an enrichment-signal gate: any row
    flagged by Tier 1 with `spotify_url` set OR mb-derived
    `genres`/`subgenres` populated routes to `spotify_protected`
    for manual review instead of deletion. Validated against 1896
    prod rows: **100% of pattern-caught phantoms have neither
    signal**, so the rescue keeps real artists safe without
    protecting any phantom.
  - **Tier 3** — `ACT_NAME_SUFFIXES` + `recoverFromActName` so
    RA-style "Ellen Allien All Night Long" → "Ellen Allien"
    recovers the artist instead of dropping the row. Suffixes
    anchored to end-of-string to avoid mid-name false positives.
  - **Tier 4** — loosened `SERIES_PREFIX` in `parseArtists` to
    handle single-act tails like "Wednesday JAmZZ: Alican Bekoglu
    Quartet" (gated on prefix-token count ≤ 4 AND tail-token
    count 2–6).

  Post-merge audit (2026-04-28): 15 → `non_artist_names` (deleted
  via `audit:cleanup --apply`), 75 → `spotify_protected` (manual
  review, **deferred** — see "Tabled" punch list).

#### 4f.1 — SoundCloud + Bandcamp avatar fallback — shipped (2026-04-25)

The 62% of artists with no Spotify avatar were rendering as initials,
which made the lineup grid feel sparse for underground/local acts.

- **Migration 0020** added `artists.soundcloud_image_url` +
  `artists.bandcamp_image_url`. Hot-linked CDN URLs (no Storage
  mirroring) — see comment block in
  `packages/ingestion/src/backfill-avatars.ts` for the rationale.
- **Pipeline** (`firecrawl.ts`) captures the og:image from SoundCloud
  + Bandcamp profile pages during normal enrichment.
- **One-shot backfill** (`backfill-avatars.ts`) closed the gap on
  592 already-enriched artists with `--green-light --hotlink` flags.
- **Web cascade** (`apps/web/src/components/lineup-list.tsx`):
  `spotify_image_url ?? soundcloud_image_url ?? bandcamp_image_url
  ?? initials`. EventCard hero fallback chain (commit `c7f9237`)
  applies the same cascade for the detail-page hero. Coverage as of
  ship: 700 SP / 403 SC / 79 BC across 1863 artists, ~63% rendered
  before initials.

#### 4f.1.1 — og:image direct scrape (LLM hallucination repair) — shipped (2026-04-25)

Right after 4f.1 went live a stale-avatar bug surfaced (DBBD on the
Sirens event was rendering initials despite an SC URL). Root cause:
Firecrawl's LLM extract was returning **hallucinated/stale URLs in
the deprecated SoundCloud numeric format**
(`avatars-000NNNNNNN-XXXXXX-tNNNxNNN.jpg`) — the current CDN format
is base64-style (`avatars-KqLDTziKPSoSZukC-e1UoxA-t500x500.jpg`). 273
of 410 backfilled SC URLs (~67%) were dead.

Fix in `packages/ingestion/src/firecrawl.ts`: a new private
`scrapeOgImage()` helper does a direct GET on the profile page,
regexes `<meta property="og:image" content="...">`, validates against
the CDN allow-list `/^https:\/\/(i\d*\.sndcdn\.com|f\d+\.bcbits\.com)\//i`,
and HEAD-checks before persistence. The old LLM-extracted `imageUrl`
field was removed from the prompt + response schema. Both the og:image
scrape and the LLM fields now run in parallel via `Promise.all` so
there's no added latency.

Repair script `repair-sc-images.ts` re-scraped all 410 existing SC
URLs (`--green-light --hotlink`): 403 replaced, 7 nulled, 0 errors,
25.8s. Notably 0 "kept" — every saved URL was wrong, validating the
systematic-hallucination diagnosis. Bandcamp URLs were spot-checked
and unaffected (BC's HTML is structured enough that the LLM didn't
fabricate from it).

Forward-looking: the firecrawl.ts patch means future enrichment, the
monthly refresh cron, and `backfill-avatars.ts` all auto-correct
without further changes.

### Phase iOS — Native shell + TestFlight v0.1.1 — shipped (2026-04-27)

The web build is now wrapped as a Capacitor 8 iOS app and distributed
via TestFlight. v0.1.1 — the first build that actually opens for
testers — includes the fix that unblocked the project: native Google
Sign-In through `@capgo/capacitor-social-login`, which routes around
Google's `disallowed_useragent` policy that blocks OAuth in embedded
WebViews.

**Architecture.** The hook `apps/web/src/lib/auth/use-google-sign-in.ts`
branches on `Capacitor.isNativePlatform()`:

- **Web** — defers to the existing `signInWithGoogle` server action
  (PKCE redirect through Supabase). No change to the proven path.
- **iOS** — dynamic-imports `@capgo/capacitor-social-login`, calls
  `SocialLogin.login` to surface the native iOS account picker, takes
  the returned `idToken`, and calls
  `supabase.auth.signInWithIdToken({ provider: 'google', token })`
  for the session exchange.

The plugin is initialized once at boot in
`apps/web/src/components/init-social-login.tsx` (mounted in root
layout, mirrors the `RegisterSW` pattern with a Capacitor-native
guard so it's a noop in the browser). Both `/login` and the onboarding
sign-in step (`components/onboarding/signin-step.tsx`) call the same
hook, so platform-branching lives in one place.

**Supabase setup.** There's still a single Google provider on the
Supabase project — the iOS Client ID
(`280343146266-l4k8d1asco7s5ggbjdb98cha8u8ta7e1`) is appended,
comma-separated, to the provider's "Authorized Client IDs" field, with
the "Skip nonce checks" toggle on so the native ID-token can be
accepted alongside the existing web OAuth flow. The web OAuth Client
ID is unchanged. **Don't replace** the Authorized Client IDs value;
append.

**Info.plist** carries the reversed iOS Client ID under
`CFBundleURLTypes` /  `CFBundleURLSchemes` —
`com.googleusercontent.apps.280343146266-l4k8d1asco7s5ggbjdb98cha8u8ta7e1`
— so the system can route the OAuth callback back into the app.

**Untracked-in-repo as of 2026-04-27.** The Capacitor scaffold
(`apps/web/ios/`, `apps/web/capacitor.config.ts`,
`apps/web/public/capacitor-shell/`) lives only on Christian's local
machine. It compiles, archives, and signs from there. Tracking these
files is queued in the punch list — needs a one-time pass to
gitignore the build artifacts (`Pods/`, `xcuserdata/`, `*.xcuserstate`)
without dropping the source. See "Tabled" below.

### Phase 7 (audio previews) — partial early-ship

- **7.1 — Per-artist quick-play widget — shipped early (basic).**
  Ahmed shipped an inline iframe player on `LineupList` (commit
  `8d847d9`, `apps/web/src/components/lineup-list.tsx`): a play
  button next to each artist row expands a Spotify embed iframe
  (preferred when `spotify_url` exists) or a SoundCloud player
  fallback. Single-preview-at-a-time UX. The richer 7.1 spec
  (track-event logging for recommendation signal) is still open.
- **7.2 — Lineup-aggregate "play the lineup" — NOT shipped.**

### Collaborator contributions (Ahmed, 2026-04-25)

Ahmed (`ad@ADs-MacBook-Pro.local`) joined the repo as a contributor
this week and pushed six commits direct to `main`. Treat his work as
shipped + production unless something below says otherwise:

- `87ced38` `feat: Add search` — title-only `?q=` ilike (Phase 6.3
  basic), see above.
- `8d847d9` `feat: Add spotify or soundloud player preview` —
  Phase 7.1 basic iframe player on `LineupList`, see above.
- `fab72f8` `fix(ui): Fix heaer sticking` — date-picker rewrite
  (~330 lines lighter, comments stripped) + sticky glass header on
  mobile (`apps/web/src/components/app-header.tsx`).
- `a86e6f3` `Update calendar view` — small `date-picker.tsx` tweak.
- `8d99a55` `Fix deployment` — 2-line `lineup-list.tsx` follow-up
  to clear a Vercel build error.
- `f4d5b81` `Clean up vulnerabilities` — three concrete changes:
  (1) added `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
  via `next.config.mjs` `headers()`; (2) removed dead
  `toggleSaveForm` server action from `save-actions.ts`;
  (3) made `MUSICBRAINZ_USER_AGENT` required (no default) in
  `env.ts` + scrubbed `cmitsuo7@yahoo.com` from `.env.example`.
  **Heads up:** the MB UA change means Railway must have
  `MUSICBRAINZ_USER_AGENT` set in env or the next nightly cron
  fails — confirm before relying on it.

The date-picker rewrite is the only change worth a closer review:
Ahmed's version dropped the inline rationale comments and the
WAI-ARIA dialog-pattern keyboard nav; if accessibility regression
matters for the picker, that's the place to look.

### Prior phases (merged + live)

- Phase 1: schema + Supabase + seed taxonomy
- Phase 2: scrapers + smart-genre inference + Railway cron
- Phase 3: apps/web (home feed, event detail, filter sheet, saved,
  profile, login, Google OAuth, PWA, responsive)
- Phase 4: full enrichment pipeline (Spotify + LLM + Firecrawl + backfill)
- Phase 4f.1 / 4f.1.1: SC/BC avatar fallback + og:image direct scrape
- Phase iOS: Capacitor 8 wrapper + native Google Sign-In + TestFlight v0.1.1
- Phase 5 (partial, see above): 5.1 profile, 5.2 onboarding,
  5.4 dynamic subgenre pills, onboarding redirect gate

---

## Tabled / flagged for future implementation

### Immediate punch list

- **Phase 6.3 search — extend beyond title-only.** Ahmed's `?q=`
  basic ship covers event titles. Open work: typeahead with a
  popover suggestion list, search across `artists.name` and
  `venues.name`, and (eventually) trigram or `pg_trgm` fuzzy match
  so "deborah" finds "Deborah De Luca". Probably a single new
  PostgREST RPC + a `<SearchSuggestions>` client component.
- **Venue image_url backfill (#43).** Top NYC venues still rendering
  the gradient placeholder when no event hero + no lineup avatar:
  Public Records (16 events), Apollo Studio (6), Outer Heaven (5),
  Jupiter Disco (3), Bossa Nova Civic Club (2). Needs Google Places
  Photos API integration or a curated photo pass — OG-image scraping
  proved unreliable on first attempt.
- **5.3 sorting options.** Still deferred. Now that Phase 4f.1
  closed the visual gap, the sort order has more visible stakes —
  needs `events.popularity_score` numeric column + ranking path in
  `events.ts`.
- **Confirm Railway env has `MUSICBRAINZ_USER_AGENT`.** Ahmed's
  `f4d5b81` made the env var required (no default fallback) — if
  the var isn't set in Railway, next nightly cron will throw at
  startup.
- **Track the iOS Capacitor scaffold in git.** `apps/web/ios/`,
  `apps/web/capacitor.config.ts`, and `apps/web/public/capacitor-shell/`
  exist only on Christian's local machine as of 2026-04-27. v0.1.1
  archives + signs from there. Needs a one-time pass to add a proper
  iOS `.gitignore` (Pods/, xcuserdata/, *.xcuserstate, build/) and
  commit the source. Risk if left untracked: any rebuild on a fresh
  clone (or by Ahmed) requires re-running `npx cap add ios` and
  re-applying the Info.plist URL-scheme block.
- **`spotify_followers` backfill.** Phase 3.18's underground rule
  omits Spotify follower count because the column is sparse — only
  populated on artists enriched after migration 0012. Backfill the
  ~1000 artists with empty `spotify_followers` from the existing
  `/v1/artists/{id}` Spotify response we already make. Tightens the
  "lineup is small" half of the underground heuristic.
- **Scraper noise-list hardening.** 6 non-artist rows slipped through
  prior runs (e.g., "2026", "EarthFest '26", "Opening Day - Sun. May
  17th"). Rare — the LLM stall fallback catches them and tags
  `very-low` so they're easy to audit — but could be prevented
  forward via regex additions for strings with digits, venue terms,
  or month names.

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
- **`artists.spotify_popularity` is universally null/zero in prod.**
  Despite Curi's app pre-dating the Nov 2024 cutoff, the column never
  got backfilled with valid values for the existing rows. Distribution
  as of 2026-04-28: 1,072 null + 824 zero + 0 positive. Any audit /
  ranking gate that relies on it is dead code. Use `spotify_url`
  presence or follower-based signals instead. The dead gate in
  `audit.ts` was replaced in Phase 4f.10.
- **Spotify OAuth user-follow-read is unviable for any user-scale
  feature.** Spotify's Nov 2024 / Feb 2026 changes capped non-approved
  apps at 5 OAuth users hand-allowlisted in the developer dashboard.
  Extended-quota approval requires commercial-traction review Curi
  won't pass. If a feature needs follow-graph data, use the
  bot-service-account architecture from Phase 5.7 spec, not OAuth.
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
- **Firecrawl LLM extract is unreliable for image URLs.** The model
  fabricates plausible-looking CDN URLs in deprecated formats
  (validated in Phase 4f.1.1 — 67% of saved SC og:images were
  wrong). For og:image specifically, always use the direct-GET +
  regex path (`scrapeOgImage` in `firecrawl.ts`). Tags / bio /
  follower counts via the LLM extract are still reliable — only
  image URLs hit this failure mode, presumably because the image
  URL isn't directly visible in the rendered text the model sees.

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
  we're not allowed to set it. Either inline `git -c user.email=… -c
  user.name=…` for the commit, or use the GitHub MCP `push_files`
  call (which signs as `cnewkirk72`) — that's what the Phase 4f.1.1
  push went through.
- **Railway cron is the ingestion deploy target.** Changes to
  `packages/ingestion/` need to be pushed to `main` for the nightly run
  to pick them up.
- **Repo has multiple direct-to-main contributors.** Christian is
  `cnewkirk72` / `christiannewkirk@gmail.com`; Ahmed is
  `AD <ad@ADs-MacBook-Pro.local>` (also seen as
  `ad@macbookpro.mynetworksettings.com`). Both push directly to
  `main`. Always `git fetch origin main` before assuming the local
  tree is the deployed state.

---

## Files worth reading on a fresh start

In priority order:

0. `carryover.md` (if present) — most recent session's handoff.
   Active priorities, deferred items, and implementation strategy
   for whatever's next on the roadmap.
0a. `curi_architecture.md` — system map prose-mirror of
   `architecture-visual.html`. Read when you need to know how a
   specific tier connects to others, or where a module lives.
0b. `curi_roadmap.md` — phase-by-phase plan with full 5.6 / 5.7 /
   5.8 specs.
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
   extensions for onboarding state). Migrations `0015`–`0022` cover
   the dedup function, venue.image_url, events.setting, the genre
   cleanup remap, the user_prefs preferred_setting split, the
   SC/BC artist external image columns, the Phase 6.3 v2
   search_suggestions RPC + pg_trgm indexes (`0021`), and the
   Phase 5.6.3 SoundCloud follow-graph schema (`0022` —
   user_soundcloud_follows table, user_prefs/artists.soundcloud_username
   columns + backfill). Next sequential migration is `0023`.
7. `apps/web/src/app/onboarding/onboarding-flow.tsx` — the client
   state machine that orchestrates the 5-step onboarding, plus
   the co-located `actions.ts` for the server-action surface
8. `apps/web/src/lib/supabase/middleware.ts` — the session-refresh
   helper + onboarding redirect gate (cookie-cached completion flag)
9. `PHASE_4_PLAN.md` — for historical context on why the pipeline is
   shaped the way it is
