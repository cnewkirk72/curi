# Curi Roadmap

Forward plan, phased by lift (lowest → highest). Items sourced from
Christian's consolidated idea list + notes flagged during Phase 4.

**Currently shipped:** Phases 1–4 in full; Phase 4f.1 + 4f.1.1
(SC/BC avatar fallback + og:image LLM-hallucination repair); Phase 5
partial (5.1 / 5.2 / 5.4 + onboarding redirect gate); Phase 6 partial
(6.1 desktop responsive + 6.2 date selector + 6.3 basic title-only
search by Ahmed); Phase 7 partial (7.1 basic iframe player by Ahmed);
Phase 3 polish 3.15–3.18 (NYC-wide expansion, pre-insert dedup, hero
fallback chain, filter vocabulary rebuild); **Phase iOS** (Capacitor 8
shell + native Google Sign-In + TestFlight v0.1.1, 2026-04-27). See
`CURI_CONTEXT.md` for status detail.

**Actively in progress (2026-04-27):**
- **Phase 6.3 v2** — smart search with live previews + entity detection
  (purple artist pill / amber venue pill). Completes Ahmed's basic
  ship.
- **Phase 5.6** — SoundCloud-following personalized sort. Imports the
  user's SC follow graph as a ranking signal in the within-day
  re-sort. Repurposes (and effectively supersedes) Phase 5.3.

**Queued immediately after 5.6 (2026-04-28):**
- **Phase 5.7** — Spotify-following personalized sort via OAuth
  `user-follow-read` scope (mirrors 5.6 UX, no scraping).
- **Phase 5.8** — Ingestion source expansion: Ticketmaster Discovery
  API (`tm-nyc`) + Eventbrite (post scoping spike).

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

### 5.3 Sorting options — **deferred / superseded by 5.6**

> **Update (2026-04-27):** the personalization-via-sort story is being
> picked up by **Phase 5.6 (SoundCloud follow boost)** rather than the
> generic popularity/preference/time-decay model below. The SC-follow
> signal is a stronger personalization input than tag overlap — it's a
> direct expression of taste from a platform users already curate
> heavily — and it boosts the existing `enrichmentScore` rather than
> introducing a new `events.popularity_score` column. The original 5.3
> spec is preserved here for reference; revisit only if 5.6 ships and
> still feels generic for users who don't connect SoundCloud.

Original 5.3 spec — re-open only if 5.6 underdelivers for SC-disconnected
users:

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

### 5.6 SoundCloud-following personalized sort — **actively in progress**

Replaces the generic 5.3 spec. The user connects their SoundCloud
account by entering their username on `/profile`; Curi imports their
public follow graph and uses it as a personalization signal in the
within-day event re-sort. Events whose lineup contains followed
artists float to the top of each day's bucket, and the event card
surfaces a small "you follow [Artist]" badge so the user understands
*why* the event is prioritized.

**Why SC follows specifically:** SoundCloud is the platform NYC's
underground scene curates most heavily — a follow there is a stronger
taste signal than a Spotify follow or a tag overlap. The signal is
also free of OAuth friction because SC's `/{username}/following` page
is publicly readable.

**Auth approach: username-only, no SC OAuth.** SoundCloud closed new
API app registrations years ago and the application form is a black
hole. Username-only is also a cleaner mental model — the user is
telling Curi who they follow, not authorizing third-party access.

**Profile UX flow (per Christian's spec):**

1. **Idle state:** `/profile` shows a "Connect your SoundCloud" card
   with a single text input (`soundcloud.com/` prefix label, then
   editable username). No Save button visible.
2. **Typing state:** as soon as the user types into the input, a
   sleek "Save" button slides in next to the field (cyan accent,
   `enter-up` 280ms).
3. **Save tap:** instead of writing immediately, surface a glass
   confirmation toast card describing the sync in user-facing
   language. **No "scrape" terminology** — say "sync your follows"
   or "import the artists you follow." Buttons: **Cancel** (ghost) /
   **Sync follows** (cyan primary).
4. **Confirm:** the toast dismisses; a small dynamic status bar
   appears under the SC card on the profile page (tabular numerals,
   thin progress indicator, "Syncing your follows…" copy). **The
   sync runs in the background** — the user can navigate away and
   keep using the app while it runs.
5. **Sync complete:** a confirmation toast appears with copy along
   the lines of "Imported 247 artists you follow on SoundCloud" and
   a single **OK** button.
6. **OK tap:** hard-refreshes the page so the home feed re-sorts
   with the new follow-aware ranking applied.
7. **Error path:** the status bar turns amber and surfaces a retry
   button; the toast on completion is replaced with a non-blocking
   amber error toast.

**Refresh strategy: hybrid.**

- Immediate sync on first save and on manual "Refresh" tap in
  profile.
- Weekly background re-sync via existing Railway cron (Sunday night,
  piggybacks on Phase 8.2). Nightly is overkill — most users don't
  follow new SC artists daily.
- Lazy invalidation: if `soundcloud_last_synced_at < now() - 14 days`
  and the user opens the app, fire a non-blocking re-sync and surface
  a subtle "Your SoundCloud follows were updated" toast on
  completion.

**Scrape strategy: SC api-v2 first, Playwright fallback.** SC's lazy-
loaded `/following` page is backed by a public XHR endpoint
(`api-v2.soundcloud.com/users/{user_id}/followings?client_id=…&limit=200`)
that returns clean JSON. The `client_id` is publicly visible in SC's
homepage bundle and rotates rarely; a small "fetch fresh client_id
from sc.com homepage HTML" helper handles the rotation case. If SC
ever blocks the api-v2 path by user-agent or rate, fall back to
Playwright headless with scroll simulation. Christian has explicitly
green-lit this approach.

**Schema (target — to be confirmed against the live schema before
the migration drafts):**

```sql
create table user_soundcloud_follows (
  user_id uuid references auth.users(id) on delete cascade,
  soundcloud_username text not null,
  display_name text,
  followed_at timestamptz,
  synced_at timestamptz default now(),
  primary key (user_id, soundcloud_username)
);

alter table user_prefs
  add column soundcloud_username text,
  add column soundcloud_last_synced_at timestamptz;

alter table artists
  add column soundcloud_username text;

create index idx_artists_soundcloud_username
  on artists (lower(soundcloud_username));
```

`user_soundcloud_follows` rather than a `text[]` on `user_prefs`
because (a) RLS is cleaner with a row policy, (b) per-row
`synced_at` lets us do delta syncs, (c) joins from
`event_artists → artists.soundcloud_username → user_soundcloud_follows`
stay clean SQL.

**Sort integration.** Extend the existing `enrichmentScore` in
`apps/web/src/lib/enrichment.ts` with an optional
`followedArtistUsernames: Set<string>` parameter. If any lineup
artist's `soundcloud_username` (lowercased) is in the set, add a
constant boost (`FOLLOWED_ARTIST_BOOST` ~ 1000 per match). The
within-day re-sort in `infinite-feed.tsx` already calls
`enrichmentScore` on the rendered window — this piggybacks on it
with zero changes to keyset cursor or server-side ordering.

**Subtasks:**

- 5.6.1 Profile UI: SC username card, dynamic Save button, glass
  confirmation toast, status bar, success toast → page-refresh flow
- 5.6.2 Scraper: SC api-v2 client + client_id resolver + Playwright
  fallback path scaffolded but not deployed unless needed
- 5.6.3 Schema migration: `user_soundcloud_follows`,
  `user_prefs.soundcloud_username`,
  `user_prefs.soundcloud_last_synced_at`, `artists.soundcloud_username`
  + index + backfill from `artists.soundcloud_url`
- 5.6.4 Sort integration: `enrichmentScore` boost +
  `<EventCard>` "you follow [Artist]" badge
- 5.6.5 Background refresh: Sunday-night Railway cron + lazy
  invalidation hook on app open

Estimate: 5–7 days end-to-end, blocking on 6.3 shipping first.

### 5.7 Spotify-following personalized sort — **planned (immediately follows 5.6)**

Mirror of 5.6 for Spotify users. The user connects Spotify on
`/profile`, Curi imports their followed artists, and lineup matches
boost the within-day sort exactly the same way SC follows do.

**Auth approach: single Curi-side service-account cookie + per-user
username. Mirrors 5.6's UX exactly.** Earlier specs explored three
alternatives that all failed scoping:

- **OAuth `user-follow-read` rejected.** Spotify's Nov 2024 / Feb
  2026 changes capped non-approved apps at **5 OAuth users**
  (down from 25 after Nov 2024). Extended-quota approval requires
  a commercial-traction review Curi won't pass at this stage.
- **Anonymous-token GraphQL rejected.** Spotify's pathfinder anon
  token authorizes *public* resources (artist pages, search) but
  rejects `queryArtistsFollowed` — that operation requires a real
  authenticated viewer session, not just permission to view a
  public page.
- **Per-user `sp_dc` cookie paste rejected.** Originally specced
  as the MVP path; ruled out because (a) every Spotify user who
  connects would have to extract their own cookie from DevTools
  every ~3–6 months when their session rotates, (b) storing a 1-
  year full-account credential per user is a heavy security
  commitment (KMS, audit logs, disclosure), and (c) it's
  unnecessary given the actual access model below.

**Key insight: Spotify treats followed-artists lists as readable
to *any authenticated viewer* when the target user's profile is
public.** When you log into Spotify and navigate to
`spotify.com/user/{anyone}/following`, Spotify serves that target
user's followed-artists list to your session. The cookie identifies
the viewer, not the target. So Curi only needs **one** authenticated
session — its own — to read followed-artists for any user whose
profile is set to public.

**Mainline path: bot service account + pathfinder GraphQL.** Curi
maintains a dedicated Spotify "bot" account (a throwaway, *not*
Christian's personal Spotify — see ban risk below). The bot's
`sp_dc` cookie lives in Curi's server-side env / admin config.
Christian re-pastes it ~yearly when it expires.

Per-user sync flow:

1. User enters their Spotify username on `/profile` connect card.
2. Curi server uses bot's `sp_dc` to mint a session token via
   `https://open.spotify.com/api/token`.
3. Curi POSTs to `api-partner.spotify.com/pathfinder/v1/query`
   with `operationName=queryArtistsFollowed`,
   `variables={uri:"spotify:user:{user_username}"}`,
   `extensions.persistedQuery.sha256Hash=<known-hash>`, bot's
   Bearer token in `Authorization`.
4. Receive clean JSON: artist ID, name, image URL, follower count.
   Paginate with `offset` + `limit=100`.
5. Stored under `user_id` in `user_spotify_follows`. Background
   re-sync runs through the same flow.

**UX flow** — identical shape to 5.6:

- Connect card: single text input (`open.spotify.com/user/`
  prefix label, editable username), no Save button until typing
  begins. Inline helper text: *"Make sure your Spotify profile
  is set to public so Curi can see your followed artists."*
  Link to the relevant Spotify privacy settings page.
- Save / sync / status-bar / refresh flow copy-paste from 5.6
  with copy-strings adjusted ("Imported 234 artists you follow
  on Spotify").
- Error path: pathfinder returns empty for valid username →
  *"Couldn't find any followed artists for `{username}`. Make
  sure your profile is public in Spotify privacy settings."*

**Schema (clean — no per-user secrets):**

```sql
create table user_spotify_follows (
  user_id uuid references auth.users(id) on delete cascade,
  spotify_artist_id text not null,
  display_name text,
  followed_at timestamptz,
  synced_at timestamptz default now(),
  primary key (user_id, spotify_artist_id)
);

alter table user_prefs
  add column spotify_username text,
  add column spotify_last_synced_at timestamptz;
```

`artists.spotify_id` already exists from enrichment work, so joins
from `event_artists → artists.spotify_id → user_spotify_follows`
are supported as-is.

**Bot cookie storage.** Single env var `SPOTIFY_BOT_SP_DC` on
Railway (or KMS-encrypted entry in an admin-config table —
Supabase Vault works). Never returned in API responses, never
logged, never included in client-bound payloads. When it expires
(token mint returns 401), an alert pages Christian via
Slack/email so he can re-paste before users notice.

**Playwright fallback.** If pathfinder ever stops accepting
bot-cookie-derived tokens for cross-profile reads, fall back to
server-side Playwright with the bot's cookie set: navigate to
`open.spotify.com/user/{username}/following`, scroll-simulate,
scrape DOM. Same fallback architecture as 5.6's SC path.
Scaffolded but not deployed unless needed.

**Sort integration.** Same `enrichmentScore` boost mechanism as
5.6. A second `followedSpotifyArtistIds: Set<string>` parameter
alongside the SC set; both contribute the same
`FOLLOWED_ARTIST_BOOST` constant so the two signals stack cleanly
when a user has both connected. Card badge: "you follow [Artist]
on Spotify" / "on SoundCloud" / "on both" depending on which sets
matched.

**Subtasks:**

- 5.7.1 Bot account provisioning: create dedicated Spotify
  account, document the cookie-extraction + Railway env-var
  rotation procedure in `OPS.md`. Set up healthcheck cron that
  pings token mint daily and pages on 401.
- 5.7.2 Pathfinder client: bot-cookie → token mint → paginated
  `queryArtistsFollowed{uri}`. Includes the persisted-query hash
  resolver for the rotation case.
- 5.7.3 Schema migration: `user_spotify_follows` +
  `user_prefs.spotify_*` columns. No KMS work needed (no per-user
  secrets).
- 5.7.4 Profile UI: connect card + privacy-helper copy + status
  bar. Mirrors 5.6.1 verbatim with copy strings adjusted.
- 5.7.5 Sort integration: extend `enrichmentScore` to accept
  Spotify-follow set; update card badge logic.
- 5.7.6 Background refresh: weekly cron + lazy invalidation hook
  (piggyback on 5.6's cron). Throttle to ~1–2 req/sec across all
  user syncs to stay under bot-account rate budget.
- 5.7.7 Playwright fallback scaffolded but gated off.
- 5.7.8 *Parallel track:* file Spotify extended-quota application.
  If approved later, layer OAuth `user-follow-read` as a *secondary*
  auth path so individual users can opt into a more compliant
  connection if they want.

**Open questions / risks:**

- **Bot-account ban risk.** A single Spotify account fetching
  hundreds of different user URIs' followed-artists looks like
  scraping to Spotify's behavioral classifier. Mitigations:
  (a) dedicated throwaway account (NOT Christian's personal —
  losing it to a ban shouldn't lose his music account); (b)
  rate-throttle to 1–2 req/sec; (c) spread daily background
  re-syncs across the 24-hour window instead of bursting at
  cron-time; (d) if banned, recovery is "create new bot account,
  re-paste cookie" — feature down for ~10 minutes, no user data
  loss.
- **Shared rate budget.** All user syncs hit one token bucket.
  Fine at MVP scale (50–500 users). At 5k+ users, may need a
  queue or multiple rotating bot accounts. Defer until usage
  justifies.
- **Bot-cookie expiry monitoring is critical.** When the cookie
  invalidates, every user's sync starts failing silently. The
  daily healthcheck cron in 5.7.1 must page Christian within 24
  hours of any 401.
- **Public-profile requirement may surprise users.** Spotify
  defaults profile public for new accounts but power-users often
  flip it private. Quick poll of early-access Curi users on
  acceptance before weighting the feature heavily.
- **ToS posture.** Technically scraping per Spotify ToS §7. The
  bot-account model is closer to traditional bot scraping than
  per-user cookie use would have been (where the user is "doing
  what they could do themselves"). Real-world enforcement at
  Curi's scale is rare but non-zero. Acceptable for MVP; revisit
  if Spotify ever sends a takedown.
- **Persisted-query hash rotation.** Same handling as SC's
  `client_id` case — extract from page bundle on 400/401, retry
  once.

Estimate: 4–5 days end-to-end. Larger than 5.6's SC path because
the bot-account healthcheck + Railway env-var rotation procedure
are new infra concerns the SC path didn't have, but smaller than
the per-user-cookie spec since there's no KMS/audit-log work.

### 5.8 Ingestion source expansion — **planned (Ticketmaster + Eventbrite)**

Two new sources to broaden NYC event coverage beyond the current set
(Public Records, Nowadays, Elsewhere, RA-NYC). Both run inside the
existing daily 10:00 UTC Railway cron via the same `Scraper`
interface as the rest of `packages/ingestion/src/scrapers/*`.

**5.8.1 Ticketmaster Discovery API — `tm-nyc`**

Free tier (5000 calls/day) is plenty for daily polling. Ahmed has
already prototyped the API integration locally; this task wires it
into the cron and the dedup pipeline.

- Endpoint: `https://app.ticketmaster.com/discovery/v2/events.json`
- Required params: `classificationName=music&dmaId=345` (NYC DMA).
  Without this, the music classification still includes stadium
  country tours, comedy, and theater — all noise for Curi.
- Rate limit: 5 requests/second (well within budget for a daily
  paginated pull).
- Source slug: `tm-nyc` (matches `ra-nyc` convention).
- Dedup: relies on the existing pre-insert venue+day+fingerprint
  gate (#34) since the same event will frequently appear on both
  TM and RA-NYC. No new dedup logic needed.
- Coverage: complements existing scrapers well — TM dominates the
  larger rooms (Brooklyn Steel, Music Hall of Williamsburg,
  Knockdown Center, Webster Hall, Bowery Ballroom) that the current
  curated venue scrapers don't cover.
- Future tightening: if noise ratio is too high after launch, add a
  venue allowlist by Ticketmaster `_embedded.venues[].id`. Start
  without one; let the user-side filters handle relevance.

**5.8.2 Eventbrite — scoping spike required first**

Christian's note: "open API - free, accessible." This may be
outdated — Eventbrite restricted public search in 2019/2020. The
`events/search` endpoint that previously allowed location/category
queries was deprecated for new apps; existing apps lost access. The
current public API mostly exposes events under organizers you
control, or events you already know the ID of.

**Spike (1–2 hours, blocks 5.8.2 implementation):**

- Test `https://www.eventbriteapi.com/v3/events/search/?location.address=brooklyn`
  with Ahmed's token. Document what comes back.
- If it works → ship as a Scraper using the public API.
- If it returns deprecation/404 → scope a scraper for the public
  site (server-rendered HTML, similar playbook to `publicrecords.nyc`).
  Eventbrite's `/d/ny--brooklyn/all-events/` listing pages are
  scrape-friendly.
- Marketing-partner program is option C — formal, slow, overkill
  for an MVP source.

**Subtasks (post-spike):**

- 5.8.1 Implement `tm-nyc` Scraper; wire into `runScrapers()` cohort;
  verify dedup against `ra-nyc` for overlap days
- 5.8.2a Eventbrite scoping spike — verify which API path works
- 5.8.2b Implement `eventbrite-nyc` Scraper using whichever path the
  spike validated
- 5.8.3 Cron-duration sanity check after both ship; current daily
  run is comfortably under Railway's timeout but worth re-baselining

Estimate: 2 days for `tm-nyc` (Ahmed's prototype reduces the lift),
plus 0.5 day spike + 1–2 days for Eventbrite depending on spike
outcome.

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

### 6.3 Dynamic live search (typeahead) — **partial ship → v2 actively in progress**

Ahmed shipped a basic version (commit `87ced38`): debounced 350ms
input → `?q=` URL param → server-side `ilike` on `events.title` only.
The Ahmed version is live and useful, but the original 6.3 spec
called for cross-entity search with live previews and entity-aware
filter pills. **v2 is the active workstream as of 2026-04-27.**

**v2 spec (Christian, 2026-04-27):**

- Replace the page-refresh debounced search with a **live preview
  dropdown** anchored to the input. Width matches the search bar.
- Up to 10 events shown: thumbnail image + event name + venue name.
- **Smart entity detection:** if the typed query matches an artist
  name with high confidence, show a "Show events with [ARTIST]"
  button at the top of the dropdown (greyed/secondary affordance
  until tapped). Same pattern for venues with "Show events at
  [VENUE]".
- Tapping an artist entity button filters the main listing to that
  artist with a **violet filter pill** (uses `--violet` /
  `--violet-chip-bg` tokens already defined in `globals.css`).
- Tapping a venue entity button filters with an **amber filter
  pill** (`--amber` / `--amber-chip-bg`).
- Existing genre pills remain cyan. Vibes / settings stay on their
  current tokens. The new pill colors slot into the active-chip row
  in `filter-bar.tsx` without breaking the visual rhythm.

**Architecture (target — to be confirmed during the kickoff):**

- Single Postgres RPC `search_suggestions(q text)` returning three
  buckets in one round-trip: events (max 10), artists (max 5),
  venues (max 3).
- `pg_trgm` extension + GIN indexes on `lower(events.title)`,
  `lower(artists.name)`, `lower(venues.name)` for typo tolerance and
  sub-100ms p95.
- Client component `<SearchSuggestions>` — glass dropdown using the
  existing `curi-glass` utility, anchored under the input,
  AbortController-cancelled in-flight requests, 150ms debounce
  (down from current 350ms — Christian flagged the slower value).
- URL state: new `?artist=<slug>` and `?venue=<slug>` params plumbed
  through `serializeFilters` / `parseFilters` in `lib/filters.ts`.
- Mobile: full-width sheet that slides up from the input.

**Subtasks (proposed):**

- 6.3.1 Migration: `pg_trgm`, GIN indexes, `search_suggestions` RPC,
  `artists.slug` if not already present
- 6.3.2 `<SearchSuggestions>` popover (glass dropdown, kbd nav,
  abortable fetch, 150ms debounce)
- 6.3.3 Entity detection (top match score ≥ 0.7 + query length
  threshold) + violet/amber filter pill variants in `filter-bar.tsx`
- 6.3.4 URL state: `?artist=` / `?venue=` params end-to-end (parse,
  serialize, server-side filter join)
- 6.3.5 Mobile sheet variant + a11y polish (aria-activedescendant,
  Esc-to-dismiss, focus management)

Estimate: 3–4 days. Ships before Phase 5.6 because the search RPC
and slug infrastructure unblock part of 5.6's match path.

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

## Phase 4f.1 — SoundCloud + Bandcamp avatar fallback — **shipped**

Closed the visible-image gap for the 62% of artists with no
Spotify avatar — underground/local acts that were rendering as
deterministic initials in the lineup grid.

- **Migration 0020** added `artists.soundcloud_image_url` +
  `artists.bandcamp_image_url`. Hot-linked CDN URLs (no Storage
  mirroring) — see `backfill-avatars.ts` header comment for
  rationale.
- Pipeline (`firecrawl.ts`) captures og:image during normal
  enrichment.
- One-shot backfill (`backfill-avatars.ts`) closed the gap on 592
  already-enriched artists with `--green-light --hotlink`.
- Web cascade (`lineup-list.tsx`, EventCard hero):
  `spotify_image_url ?? soundcloud_image_url ?? bandcamp_image_url
  ?? initials`.

Coverage at ship: 700 SP / 403 SC / 79 BC across 1863 artists,
~63% rendered before initials.

### 4f.1.1 og:image direct scrape (LLM hallucination repair) — **shipped**

Post-4f.1 a stale-avatar bug surfaced (DBBD on the Sirens event).
Root cause: Firecrawl's LLM extract had been returning
hallucinated/stale URLs in the deprecated SoundCloud numeric format
(`avatars-000NNNNNNN-…`); the current CDN format is base64-style.
Of 410 backfilled SC URLs, 273 (~67%) were dead.

Fix: a private `scrapeOgImage()` helper in `firecrawl.ts` that does
a direct GET on the profile page, regexes
`<meta property="og:image">`, validates against a CDN allow-list,
and HEAD-checks before persistence. The og:image scrape and LLM
extract now run in parallel via `Promise.all`. Repair script
`repair-sc-images.ts` re-scraped all 410 URLs (403 replaced, 7
nulled, 0 errors). Forward-looking: future enrichment, monthly
refresh, and `backfill-avatars.ts` all auto-correct now without
further changes.

---

## Phase iOS — Native shell + TestFlight v0.1.1 — **shipped (2026-04-27)**

The web build is now wrapped as a Capacitor 8 iOS app and distributed
to internal testers via TestFlight. The unblocking change was switching
Google Sign-In from the web OAuth redirect (which Google blocks in
embedded WebViews with a `disallowed_useragent` 403) to the native
iOS account picker via `@capgo/capacitor-social-login` plus
Supabase's `signInWithIdToken`.

**Stack additions:**
- `@capacitor/core`, `@capacitor/ios`, `@capacitor/cli` ^8.3.x
- `@capgo/capacitor-social-login` ^8.3.20 (Capacitor 8 compatible;
  the obvious-named `@capacitor-community/social-login` package
  doesn't exist — false flag on the first install attempt)
- Capacitor companions: `@capacitor/app`, `@capacitor/browser`,
  `@capacitor/haptics`, `@capacitor/splash-screen`, `@capacitor/status-bar`

**Key files:**
- `apps/web/src/lib/auth/use-google-sign-in.ts` — platform-branching
  hook. Web → existing server action. iOS → native ID-token →
  `signInWithIdToken`.
- `apps/web/src/components/init-social-login.tsx` — boot-time
  `SocialLogin.initialize` with the iOS Client ID. Mounted in root
  layout, `Capacitor.isNativePlatform()`-guarded so it's a noop in
  the browser.
- `apps/web/src/app/login/login-google-button.tsx` — client wrapper
  for the (otherwise RSC) `/login` page.
- `apps/web/src/components/onboarding/signin-step.tsx` — uses the
  same hook with `redirectTo: '/onboarding'`.
- `apps/web/ios/App/App/Info.plist` — reversed iOS Client ID under
  `CFBundleURLTypes` / `CFBundleURLSchemes` so the OAuth callback
  routes back into the app.

**Supabase config (one-time, completed):** the iOS Client ID is
appended (comma-separated) to the existing Google provider's
"Authorized Client IDs", with "Skip nonce checks" enabled. Web OAuth
client unchanged. **Don't replace** that field — append to it.

**Open work for v0.1.2+:**
- Track the iOS Capacitor scaffold in git — see "Active follow-ups".
- Smoke-test sign-out → sign back in, force-quit cold start, and
  the deferred sign-in (skip onboarding → sign in later) path on
  device.
- Submit for App Store review once internal testers confirm the
  flows hold up over a few days.
- Apple Sign-In (`SignInWithApple`) — App Store guideline 4.8 may
  require it as a sibling option to Google for any app that offers
  third-party sign-in. The same `@capgo/capacitor-social-login`
  plugin handles it; the same Supabase pattern (provider config +
  `signInWithIdToken`) applies.

---

## Phase 7 — Audio previews

Medium-to-high lift. Real user value-add but requires integration
surface area.

### 7.1 Per-artist quick-play widget — **shipped (basic)**

Ahmed shipped this early (commit `8d847d9`,
`apps/web/src/components/lineup-list.tsx`): an inline play button
on each lineup row that expands a Spotify embed iframe (when
`spotify_url` exists) or a SoundCloud player fallback. Single
preview open at a time — tapping a second collapses the first.
Cyan accent on the play button matches brand.

Open work in 7.1:
- Track tap-to-play events to feed a future recommendation signal
  (the original 7.1 spec called for this; not yet wired).
- Decide whether the Spotify iframe (which requires user Spotify
  auth for full-track) is the right fallback vs. just the 30s
  preview audio via the Web API.

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
  `0023_*`. Recent additions: 0015 dedup function, 0016 venue.image_url,
  0017 events.setting, 0018 genre cleanup + remap, 0019 user_prefs
  preferred_setting split, 0020 artist external images (SC/BC),
  0021 search_suggestions (Phase 6.3 v2 pg_trgm + RPC),
  0022 soundcloud_follows (Phase 5.6.3 — user_soundcloud_follows table,
  user_prefs/artists.soundcloud_username columns + index + backfill).
  Migrations don't get rewritten; if a change is wrong, it's
  superseded by the next numbered migration.
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
- **4f.10 — Holistic phantom-pattern expansion + dead-gate fix — done
  (2026-04-28).** PR #2 squash-merged as `3f65ceb`. Added ~25 new
  `EVENT_WORD_PATTERNS` (after-/day-/warehouse-party shapes,
  double-`party` titles, singular-weekday + genre bigrams,
  drag/silent-disco/bingo, decade-throwback, locality fragments,
  airline/customer-service spam tells), `parr?ty` typo tolerance
  throughout, `ACT_NAME_SUFFIXES` + `recoverFromActName` so RA-style
  "Ellen Allien All Night Long" recovers the artist instead of
  dropping the row, and a loosened `SERIES_PREFIX` strip for
  single-act tails. Replaced the dead `spotify_popularity ≥ 20`
  rescue gate in `audit.ts` with an enrichment-signal gate
  (`spotify_url` OR `mb_tags`) since Spotify's Nov 2024 API change
  made popularity universally null. Post-merge audit (1896 rows):
  15 → `non_artist_names` (delete), 75 → `spotify_protected`
  (manual review), down from 56 phantoms under the old patterns.
  Cleanup applied via `audit:cleanup --category=non_artist_names
  --apply`.

  **Follow-up review item:** the 75 `spotify_protected` rows are
  higher than expected — pre-ship validation against the OLD pattern
  set found 0 rescues, but the expanded patterns naturally catch
  more rows that do have enrichment signal. Need to scan the JSON
  `categories.spotify_protected.rows` list and decide whether (a)
  most are real artists (rescue gate is doing its job, ship as-is),
  (b) some are phantoms with fuzzy MB matches (tighten gate to
  `spotify_url AND mb_tags`, or hand-curate), or (c) the patterns
  themselves need narrowing for specific phrases. Defer until
  Phase 5.6 prep so we don't churn on this mid-flight.

### Phase 4f.1 + 4f.1.1 — both shipped

- **4f.1 — SC/BC avatar fallback — done (2026-04-25).** See dedicated
  section above.
- **4f.1.1 — og:image LLM-hallucination repair — done (2026-04-25).**
  Repair script ran in 25.8s; 403/410 SC URLs replaced. firecrawl.ts
  now uses direct GET + regex for og:image and the LLM extract is
  no longer asked for image URLs at all.

### Track the iOS Capacitor scaffold in git (Phase iOS tail)

The iOS shell that ships v0.1.1 to TestFlight lives only on Christian's
local machine as of 2026-04-27. Untracked paths:

- `apps/web/ios/` (the native Xcode project)
- `apps/web/capacitor.config.ts`
- `apps/web/public/capacitor-shell/`

What's needed:
1. A proper iOS `.gitignore` for `Pods/`, `xcuserdata/`,
   `*.xcuserstate`, `build/`, `DerivedData/`, `.DS_Store`.
2. Commit the source tree (Info.plist with the URL-scheme block,
   `App.xcodeproj`, etc.).
3. Document the local-only setup steps that aren't captured in the
   tree — the iOS Client ID env, the signing certificate, and the
   first-time `pnpm exec cap sync ios` after a fresh clone.

Risk if left untracked: any rebuild on a fresh clone (or by Ahmed)
requires re-running `npx cap add ios` and re-applying the Info.plist
URL-scheme block, which is easy to miss and would silently break the
native sign-in path. `IOS_TESTFLIGHT_GUIDE.md` (already at repo root)
covers the build/upload steps; this follow-up is just about source
control hygiene.

### MUSICBRAINZ_USER_AGENT env required (post-Ahmed cleanup)

Ahmed's `f4d5b81` removed the `MUSICBRAINZ_USER_AGENT` default in
`packages/ingestion/src/env.ts` — the var is now required. Verify
the var is set in Railway env before the next nightly cron, or the
ingestion run will throw at startup. Local dev: `.env.example`
points to `Curi/0.1 (your-contact@example.com)` as a placeholder,
override per-developer.

### RLS `auth_rls_initplan` optimization — deferred (post-0022 hygiene pass)

Supabase's performance linter flags every `auth.uid() = user_id`
predicate in our RLS policies as suboptimal: at scale, Postgres
re-evaluates `auth.uid()` per row instead of once per query. The
fix is wrapping in a subquery — `(select auth.uid()) = user_id` —
which the planner caches as an InitPlan.

Migration `0022_soundcloud_follows` introduced four new policies
on `user_soundcloud_follows` that hit this warning. The same
warning fires on the existing 12 policies across `user_prefs`,
`profiles`, and `user_saves`, so this is an inherited project-wide
pattern, not a regression from 0022.

Deferred — not blocking 5.6 or anything user-visible. Currently at
MVP scale where per-row re-evaluation is invisible. Fold into a
0023 `optimize_rls_initplan` migration when scale starts mattering
or when next touching auth-gated tables; rewrite all 16 policies
in the same pass so the project converges on the optimized form.
Reference: [Supabase docs](https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select).

### Cross-collaborator coordination note

As of 2026-04-25 the repo has two direct-to-main contributors
(Christian + Ahmed). No branch protection or PR-required gates yet.
Practical implications:

- Always `git fetch origin main` before assuming the local tree is
  the deployed state — Ahmed pushed six commits in one afternoon
  while Christian was working on Phase 4f.1.
- The date-picker rewrite in `fab72f8` removed the inline rationale
  comments + WAI-ARIA dialog-pattern keyboard nav from
  `components/date-picker.tsx`. If accessibility regression
  matters, that's the file to spot-check.

If the contributor count grows, consider adding GitHub branch
protection on `main` requiring at least one approving review.
