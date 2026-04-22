# Curi Roadmap

Forward plan, phased by lift (lowest → highest). Items sourced from
Christian's consolidated idea list + notes flagged during Phase 4.

**Currently shipped:** Phases 1–4 in full; Phase 5 partial
(5.1 / 5.2 / 5.4 + onboarding redirect gate). See `CURI_CONTEXT.md`
for status detail.

---

## Phase 5 — Personalization foundations

Low-to-medium lift, highest user-value. Everything in this phase leans on
data we already have (`user_prefs` table from migration 0005, full
taxonomy, artist popularity signal). Shipped as one coherent bundle so
the onboarding flow hands off directly to the personalized feed.

### 5.1 User profile completion — **shipped**

- Profile picture defaults to compressed Google photo from OAuth; users
  can remove / upload from library / save on change
- Curi username (`@[username]`), editable, save on change
- Display name field

Shipped schema: `profiles` table (migration 0013) with `username`
(citext unique), `display_name`, `avatar_url`, timestamps. Supabase
Storage `avatars/` bucket with per-user RLS folder
(`avatars/{user_id}/*`), 2 MB cap, client-side compression. OAuth
seeds the row via the `handle_new_user` trigger.

### 5.2 Onboarding genre/subgenre/vibe picker — **shipped**

Five-step `/onboarding` flow: welcome → signin (with Skip) →
genres (min 2, with inline subgenre disclosure via the 5.4 picker)
→ vibes → when & notifications → ready. Each step fires a server
action in an optimistic fire-and-forget pattern; failures surface
as an amber toast and are paper-patched by the next step's write.
`user_prefs.onboarding_completed_at` is stamped on the terminal
step, read by the middleware gate.

Retroactively editable from `/profile` via `<PreferencesForm>`.

### 5.3 Sorting options — **deferred**

Not shipped in Phase 5. Re-open when the feed starts feeling
generic to onboarded users.

- **Popularity (default):** already computable — weighted score across
  `spotify_popularity`, `soundcloud_followers`, `bandcamp_followers`.
  Compute at aggregation time; store as `events.popularity_score`
  numeric (new column) so sort is indexable.
- **User preference:** rank events by overlap count between their
  rolled-up genres/subgenres/vibes and the user's stored prefs.
- **Time-decay weighting:** as the user saves/attends events, nudge
  their stored prefs toward those tags. Simple exponential moving
  average on tag frequency is fine — no ML needed at this scale.

### 5.4 Dynamic subgenre pills — **shipped**

Shared `<SubgenrePicker>` component used by both the filter sheet
and the onboarding genres step. Parent selection animates in the
relevant subgenre rows (per curated map in `lib/filters.ts`);
deselection animates them out and cascades cleanup on the stored
subgenre list.

No schema changes — uses the existing `parent_taxonomy_id` FK on
`taxonomy_subgenres`.

### 5.5 Onboarding redirect gate — **shipped**

Middleware-level check (`lib/supabase/middleware.ts`) bounces any
signed-in user with `onboarding_completed_at IS NULL` to
`/onboarding` from any non-exempt route. A `curi_onboarded=1`
cookie short-circuits the DB roundtrip after the first confirmation;
the sign-out action clears it so a different user on the same
browser re-verifies. `/auth/callback` makes the same decision at
exchange time to save a redirect hop.

---

## Phase 6 — Desktop experience + discovery polish

Medium lift. Christian has screenshots for reference — review those
before starting.

### 6.1 Desktop responsive refactor

Current UI is mobile-first. Desktop layout needs its own information
density, side-by-side filter + feed, wider event cards, hover states
for secondary info. Keep the PWA install flow intact for iPad/iPhone.

### 6.2 Date selector

Currently implicit (feed shows upcoming by date). Add an explicit
date-range control in the filter sheet.

### 6.3 Dynamic live search (typeahead)

Results narrow automatically as the user types, across event title,
artist name, venue. Debounce ~150ms. Reuse the existing PostgREST
select shape, add server-side `ilike` filter via a search param.

---

## Phase 7 — Audio previews

Medium-to-high lift. Real user value-add but requires integration
surface area. Consider feature-flagging for beta.

### 7.1 Per-artist quick-play widget

Embed Spotify's audio preview iframe on each `LineupList` artist card.
Falls back gracefully when no `spotify_url` is present. Track play
events for future recommendation signal.

### 7.2 Lineup-aggregate playlist

Single "play the lineup" button on event detail. Concatenates top track
from each artist. Simplest implementation: client-side queue with
Spotify Web Playback SDK (requires user Spotify auth) or sequential
iframe cycling for unauthenticated users.

---

## Phase 8 — Coverage expansion

Medium-to-high lift. Incremental value per scraper, but the long tail
matters — the Chmura example cited in the idea list came from a label's
tour page that none of the main aggregators indexed.

### 8.1 Label/record-group scrapers

Per-site custom scrapers for standout labels + promoter groups with
their own event sections. Each is small (~100 lines) but bespoke. Set
up once; let the Railway cron pick them up automatically.

Candidate targets to scope first pass: labels with strong NYC residency
presence (to be enumerated with Christian).

### 8.2 Monthly popularity refresh (task #64, already queued)

Re-hit Spotify + Firecrawl on all artists monthly. Catches rising acts
whose popularity has grown since their last enrichment. Also a clean
trigger point for newly-added artists to get their first Spotify pass.

Tolerate the Client Credentials rate limit — `--concurrency 4` and
`MIN_INTERVAL_MS = 400` in `spotify.ts`.

---

## Phase 9 — Social layer

High lift. Requires new auth-gated tables (follows, RSVPs),
notification surface, moderation considerations. Don't start this
before Phases 5–8 have enough runway to validate the core product
loop.

### 9.1 Friends attending

- `follows(follower_id, following_id)` table with RLS
- User search (by `@username` once 5.1 ships)
- Event card badge: "N friends saved this"
- Sort option: "friends attending" (list ordered by number of followed
  users who've saved or RSVPed)

### 9.2 Venue feedback

Per-venue user-submitted ratings on dimensions: sound, vibe, lighting,
seating. Schema: `venue_reviews(venue_id, user_id, sound,
vibe, lighting, seating, notes, created_at)`. Surface aggregate on
venue pages + event detail.

Moderation is flagged for "later implementation" — ship with a simple
report-button MVP, add moderator role + review queue as a follow-up.

---

## Phase 10 — Advanced visualization

High lift, high polish. Vector UI is distinctive but non-trivial. Scope
carefully — it's easy to spend weeks on graph aesthetics that don't
move retention.

### 10.1 Artist vector graph

Show an artist's cross-genre presence visually — if they drop DnB,
breaks, and house tracks, render each release as a point in
reduced-dimension genre space. Requires:
- Artist bios (another enrichment pass via the Phase 4 pipeline)
- Track-level genre data (new ingestion: Spotify top tracks + per-track
  audio features, or MB per-release tags)
- A dimensionality-reduction step (PCA or UMAP on a genre-embedding
  space) baked into a view

### 10.2 Event mixed-genre visual plot

On event detail, show a small visualization of the lineup's genre
distribution — effectively a bubbled-up version of 10.1 aggregated
across performing artists.

### 10.3 Artist 4D timecapsule (R&D)

Christian explicitly flagged this as "hard maybe down the route —
difficult to implement." Visualize an artist's stylistic evolution
over time in a reduced-dimension space. Temporal axis + 3D style
space. Don't plan real work here until 10.1/10.2 have shipped and
demand is proven.

---

## Cross-cutting notes

- **Every phase ships to the same infrastructure** — Vercel for web,
  Railway cron for any new enrichment passes, Supabase for storage.
  No new hosts.
- **Schema migrations get numbered sequentially.** Next available is
  `0015_*` (0013 shipped profiles+avatars, 0014 shipped user_prefs
  onboarding extensions). Migrations don't get rewritten; if a change
  is wrong, it's superseded by the next numbered migration.
- **User-facing ML stays simple.** Tag-overlap scoring, exponential
  moving averages, weighted popularity — no model training, no vector
  DB, until the taxonomy-based approach obviously saturates.
- **Phase 4's 305 `spotify_discovery_failed_at` artists** will be
  revisited in the targeted follow-up pass (captured in
  `CURI_CONTEXT.md`), likely as part of Phase 8.2's monthly refresh.

---

## Active follow-ups (Phase 4 tail)

### 4f.7 — Resume `spotify-catchup` after rate-limit burn

Catchup run on 2026-04-21 processed ~321/732 never-attempted artists
before Spotify returned `retry-after: 83763s` (~23.3h) on the Client
Credentials quota at row 322. Kernel `--concurrency 4` pushed ~320
requests through in ~60s, which burned the window.

**Resume:** on or after **2026-04-22 22:00 EDT (2026-04-23 02:00 UTC)**
— once the retry-after window has elapsed.

```
pnpm --filter @curi/ingestion spotify-catchup --concurrency 2
```

Drop `--concurrency` to 2 this run to stay well inside the window.
Remaining queue is ~390 artists; at 2-concurrency + 100ms throttle
that's ~4 minutes, comfortably below any burn threshold.

### 4f.8 — Artist-table cleanup pass (event-title pollution)

Catchup run surfaced ~50–100 rows in `artists` that are actually event
titles / lineup strings leaking in through pre-`classifyArtistName`
scraper paths — "REGGAETON Boat Party NYC Yacht Cruise", "Refuge
Fridays", "Cinco De Mayo Party at Dive Bar", "The Nursery: HAAi All
Day Long", "- Brooklyn Warehouse", etc. Approach: expand
`EVENT_WORD_PATTERNS` and `NOISE_EXACT` in
`packages/ingestion/src/artist-parsing.ts`, then run the existing
`audit.ts` + `audit-cleanup.ts --category=non_artist_names --apply`
pipeline (which already backs up to `artists_audit_backup` and
cascades `event_artists` deletes). Proposed patterns + the 53-row
candidate delete list to be reviewed with Christian before commit.
