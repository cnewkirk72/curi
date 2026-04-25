# Curi Roadmap

Forward plan, phased by lift (lowest → highest). Items sourced from
Christian's consolidated idea list + notes flagged during Phase 4.

**Currently shipped:** Phases 1–4 in full; Phase 5 partial (5.1 / 5.2 /
5.4 + onboarding redirect gate); Phase 6 partial (6.1 desktop responsive
+ 6.2 date selector); Phase 3 polish 3.15–3.18 (NYC-wide expansion,
pre-insert dedup, hero fallback chain, filter vocabulary rebuild). See
`CURI_CONTEXT.md` for status detail.

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

### 6.1 Desktop responsive refactor — **shipped**

Sticky left filter sidebar at `lg`+ breakpoint
(`apps/web/src/components/desktop/desktop-sidebar-filters.tsx`),
wider event cards in a 2-col grid, dedicated `DesktopTopNav`. Mobile
filter sheet remains for `< lg`. URL stays the source of truth on
both layouts; same `serializeFilters` / `parseFilters` round-trip.

### 6.2 Date selector — **shipped**

Custom single-date picker (`components/date-picker.tsx`) inline in
the desktop sidebar + collapsed disclosure on mobile sheet. Selecting
a date sets `when='custom'` with `date_from = picked day` and
`date_to = null` for an open-ended "from X onward" window. Round-trips
through the `?when=custom&from=YYYY-MM-DD` URL param. Date math
handles NYC DST via `Intl.DateTimeFormat` shortOffset sampling.

### 6.3 Dynamic live search (typeahead) — **next priority**

Results narrow automatically as the user types, across event title,
artist name, venue. Debounce ~150ms. Reuse the existing PostgREST
select shape, add server-side `ilike` filter via a search param.
Highest-impact remaining feature in Phase 6 — users currently can't
search at all, only filter.

---

## Phase 3 polish + maintenance — shipped phases

These didn't fit the original 5-phase numbering but landed in 2026-04.
Documented here so the roadmap is honest about what shipped between
Phase 5 and Phase 6.

### 3.15 NYC-wide expansion — **shipped**

Taxonomy seeded with rock/pop/jazz/hip-hop/metal/folk/latin parents.
The smart-genre layer auto-creates new top-level genres when MB tags
don't match any existing parent. Originally Curi was electronic-only;
this opened the door to the broader NYC live-music catalog.

### 3.16 Pre-insert dedup — **shipped**

Migration 0015 + Postgres function `find_dupe_event_by_artist`. Pre-
insert check in the scraper pipeline collapses cross-source duplicates
(RA + venue + Eventbrite reporting the same show) by `(venue_id,
starts_at, artist-slug-overlap)`. ~10 strict-duplicate events were
backfill-deleted with audit backup at the same time.

### 3.17 Hero fallback chain — **shipped**

EventCard cascades through event.image_url → headliner Spotify avatar
→ any-lineup Spotify avatar → venue.image_url → genre-tinted gradient.
Migration 0016 added `venues.image_url`. Of 93 events without an
event hero, ~55% are now rescued by the artist avatar fallback before
hitting the venue or gradient layer. Per-venue backfill is queued
(see "Active follow-ups" below) — the column is in place, the curation
of photos is the remaining work.

### 3.18 Filter vocabulary rebuild — **shipped**

Genre vocabulary rebuilt from post-3.15 NYC-wide data: 24 parents,
default-14 row + 10 in More-genres disclosure, slugs match
`events.genres` byte-for-byte. Vibes refocused as artist-mood only
(`adventurous` rename, `industrial` dropped). New Setting filter
introduced as a fourth orthogonal axis (`events.setting`, migration
0017) — event-context tags derived deterministically from venue +
start-time + lineup follower totals.

Migrations 0017 / 0018 / 0019 cover schema add, data cleanup with
audit backup (16 deletes + 9 renames + 4 wrong-granularity moves),
and the user_prefs split. Genre normalizer
(`packages/ingestion/src/genre-normalizer.ts`) guards every
ingestion write boundary so future scrapes can't reintroduce junk.
Pref-aware sort wired into the home filter UI: signed-in users see
their onboarding-picked genres bubble to the top of the visible-by-
default 14.

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
  `0020_*`. Recent additions: 0015 dedup function, 0016 venue.image_url,
  0017 events.setting, 0018 genre cleanup + remap, 0019 user_prefs
  preferred_setting split. Migrations don't get rewritten; if a change
  is wrong, it's superseded by the next numbered migration.
- **User-facing ML stays simple.** Tag-overlap scoring, exponential
  moving averages, weighted popularity — no model training, no vector
  DB, until the taxonomy-based approach obviously saturates.
- **Phase 4's 305 `spotify_discovery_failed_at` artists** will be
  revisited in the targeted follow-up pass (captured in
  `CURI_CONTEXT.md`), likely as part of Phase 8.2's monthly refresh.

---

## Active follow-ups

### Venue image_url backfill (Phase 3.17 tail)

Top NYC venues still rendering the gradient placeholder when no event
hero + no lineup avatar. Counts are upcoming-event impact at time of
3.17 ship:

- Public Records (16 events)
- Apollo Studio (6)
- Outer Heaven (5)
- Jupiter Disco (3)
- Bossa Nova Civic Club (2)

OG-image scraping was attempted but proved unreliable (publicrecords.nyc
returned an SVG logo, bossanovacivicclub.nyc was unreachable, House of
Yes returned a wordmark PNG). Two viable paths:

1. **Google Places Photos API** (preferred) — paid but reliable, ~one
   high-quality photo per venue, low ongoing cost.
2. **Manual curation** — pull a hand-picked image per venue from their
   Instagram or press kit, host on Supabase Storage. Higher curation
   effort, zero ongoing cost.

Either way, the destination column is `venues.image_url` from migration
0016. Once populated, the EventCard fallback chain picks them up
automatically.

### Spotify followers backfill (Phase 3.18 tail)

The Phase 3.18 underground rule omits Spotify follower count because
~1000 artists have empty `spotify_followers`. Backfill from existing
Spotify enrichment context — the `/v1/artists/{id}` response we already
fetch carries a `followers.total` field. Tightens the "lineup is small"
half of the underground heuristic without rerunning LLM enrichment.

### Phase 4 tail — both shipped

- **4f.7 — Resume `spotify-catchup` after rate-limit burn — done.**
  Cooldown cleared on 2026-04-23; resumed at `--concurrency 2`,
  remaining queue processed in ~4 minutes without re-burning the window.
- **4f.8 — Artist-table cleanup pass — done.** Expanded
  `EVENT_WORD_PATTERNS` + `NOISE_EXACT` in
  `packages/ingestion/src/artist-parsing.ts`, ran `audit.ts` +
  `audit-cleanup.ts --category=non_artist_names --apply`. ~13 garbage
  artist rows deleted with audit backup; cascaded `event_artists`
  deletes handled cleanly.
