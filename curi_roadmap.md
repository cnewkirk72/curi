# Curi Roadmap

Forward plan, phased by lift (lowest → highest). Items sourced from
Christian's consolidated idea list + notes flagged during Phase 4.

**Currently shipped:** Phases 1–4 in full; Phase 4f.1 + 4f.1.1
(SC/BC avatar fallback + og:image LLM-hallucination repair); Phase 5
partial (5.1 / 5.2 / 5.4 + onboarding redirect gate); Phase 5.6
(SoundCloud follow-graph) + 5.6.6 (3-tier feedScore + candidate-pool
fix) + 5.6.7 (SC brand-orange indicator); **Phase 5.7 (Spotify
follow-graph, 2026-04-29)**; Phase 6 partial (6.1 desktop responsive
+ 6.2 date selector + 6.3 basic title-only search by Ahmed); Phase 7
partial (7.1 basic iframe player by Ahmed); Phase 3 polish 3.15–3.18
(NYC-wide expansion, pre-insert dedup, hero fallback chain, filter
vocabulary rebuild); **Phase iOS** (Capacitor 8 shell + native Google
Sign-In + TestFlight v0.1.1, 2026-04-27). See `CURI_CONTEXT.md` for
status detail.

**Actively in progress (2026-04-29):**
- **Phase 5.7 ops follow-up** — provision Spotify bot account, paste
  `SPOTIFY_BOT_SP_DC` cookie on Vercel + Railway, wire the two new
  Railway cron services (refresh @ Sunday 05:00 UTC + healthcheck
  daily). Code shipped, infra paste outstanding.
- **Phase 6.3 v2** — smart search with live previews + entity detection
  (purple artist pill / amber venue pill). Completes Ahmed's basic
  ship.

**Queued next:**
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

### 5.4 Dynamic subgenre pills — **shipped**

Shared `<SubgenrePicker>` component used by both the filter sheet
and the onboarding genres step.

### 5.5 Onboarding redirect gate — **shipped**

Middleware-level check (`lib/supabase/middleware.ts`) bounces any
signed-in user with `onboarding_completed_at IS NULL` to
`/onboarding` from any non-exempt route.

### 5.6 SoundCloud-following personalized sort — **shipped (2026-04-28)**

User connects their SoundCloud account by entering their username on
`/profile`; Curi imports their public follow graph and uses it as a
personalization signal in the within-day event re-sort. Events whose
lineup contains followed artists float to the top of each day's bucket
via the `feedScore` tier-floor mechanic. Migration 0022 introduced
`user_soundcloud_follows` + RLS + `user_prefs.soundcloud_username` +
`artists.soundcloud_username` index + backfill.

**Subtasks shipped:**

- 5.6.1 Profile UI: SC username card, dynamic Save button, glass
  confirmation toast, status bar, success toast → page-refresh flow.
- 5.6.2 Scraper: SC api-v2 client + client_id resolver + Playwright
  fallback path scaffolded but not deployed unless needed.
- 5.6.3 Schema migration 0022.
- 5.6.4 Sort integration: `enrichmentScore` boost +
  `<EventCard>` follow-dot indicator.
- 5.6.5 Background refresh: Sunday 04:00 UTC Railway cron + lazy
  invalidation hook on app open.
- 5.6.6 Feed-sort overhaul + candidate-pool fix — `enrichmentScore` →
  `feedScore` (FOLLOWED_TIER_FLOOR + popSum within tier; popSum +
  genre-pref outside). New `getFollowedEventsInWindow` helper
  augments the SSR'd candidate pool with followed events past the
  chronological page cap. Initial page size bumped 40 → 100.
- 5.6.7 SC brand-orange indicator: dedicated `--sc-orange` (`#FF5500`)
  token, swapped from the original cyan/amber on the EventCard avatar
  dot, ConnectedSummary on /profile, and LineupList headliner +
  supporting avatars on the event-detail page.

### 5.7 Spotify-following personalized sort — **shipped (2026-04-29)**

Code-shipped. Pending bot account provisioning by Christian (one-
time `SPOTIFY_BOT_SP_DC` env-var paste on Vercel + Railway) before
the user-driven flow lights up — see § 13 of the
[finalized spec](phase-5.7-spotify-follows-spec.md) for the
procedure.

**What landed:**

- Migration 0023 — `user_spotify_follows` table + RLS policies +
  `user_prefs.spotify_user_id` / `spotify_last_synced_at`. Schema
  mirrors 0022 (SoundCloud). Advisor sweep clean (no new warnings
  beyond the inherited `auth_rls_initplan` note).
- Pathfinder GraphQL client (`packages/ingestion/src/spotify-follows/*`
  + dual-copy at `apps/web/src/lib/spotify-follows/*`) — bot token
  mint, persisted-query hash resolver with rotation recovery,
  paginated `queryArtistsFollowed` with 401/400/429 retry semantics.
  Playwright fallback scaffolded but not wired.
- Server action `syncSpotifyFollows(rawUrl)` — strips
  `?si=`/`open.spotify.com/user/`/`spotify:user:` from input;
  `extractSpotifyUserId` accepts URL + URI + bare-ID forms; standard
  replace-not-merge into `user_spotify_follows`. Discriminated
  `SyncResult` covers `unauth | invalid_url | private_profile |
  bot_auth_failed | scrape_failed`.
- 3-tier `feedScore` rewrite — `BOTH (3M) > Spotify (2M) > SC (1M)
  > none`. Cross-platform match (one artist on both, OR two
  different artists each followed on one platform) qualifies for
  the BOTH floor. `enrichmentScore` deprecated alias preserved.
- Candidate-pool augmentation — new
  `getFollowedSpotifyEventsInWindow` mirrors the SC injector. Home
  page parallel-fetches both extras streams; `<InfiniteFeed>` merges
  with id-dedup; cursor stays anchored to chrono tail (keyset
  invariant preserved).
- `<FollowDotStack />` shared component — single-platform → single
  dot; cross-platform → spotify-green offset behind sc-orange in
  front, both visible. Spotify-green token `#1ED760` (Spotify's
  brand) added to globals.css + tailwind.config.ts with matching
  `shadow-glow-spotify-sm` / `shadow-glow-spotify` utilities.
  EventCard + LineupList both swapped to use the shared component.
- `<ConnectorsSection />` profile redesign — "CONNECTORS" parent
  eyebrow with both platform cards stacked (Spotify above SC). Each
  card self-renders its own subheader. SoundCloud card retains its
  inline-input flow; Spotify card uses a 4-page swipeable
  `<SpotifyOnboardingOverlay />` (Connect → onboarding cards → URL
  paste → Submit) that walks the user through extracting their
  profile URL from the Spotify mobile app. Overlay is `role=dialog`
  + focus-trapped + Esc-to-close + arrow-key + swipe nav.
- Weekly Sunday 05:00 UTC refresh cron
  (`packages/ingestion/src/refresh-spotify-follows.ts`) at 1.5 req/sec
  outer throttle. Per-user error isolation; `SpotifyAuthFailedError`
  aborts the whole run (every subsequent user would fail too) and
  exits 1 so Railway flags the cron as broken. Daily healthcheck
  cron `healthcheck:spotify-bot` mints a token and exits 1 on 401
  so Christian gets paged within 24h of cookie expiry.

**Deferred to ops follow-up (Christian-managed):**

- Provision the dedicated Spotify bot account.
- Paste `SPOTIFY_BOT_SP_DC` cookie into Vercel + Railway env.
- Wire the two new Railway services (refresh cron @ Sunday 05:00 UTC
  + healthcheck cron daily). Same Dockerfile as existing services;
  only the `startCommand` + `cronSchedule` differ.
- Smoke-test end-to-end with Christian's actual Spotify profile URL
  via the connect-card flow on `/profile`.

**Deferred to future phases:**

- SC connect-card parity overlay (replace inline-input with the
  same swipeable onboarding pattern). Fine to leave asymmetric for
  now per § 16.4 of the spec — SC's inline input is still the
  fastest path for users who already know their handle.
- Spotify extended-quota OAuth application (parallel track). If
  approved later, layer OAuth as a *secondary* auth path so users
  can opt into a more compliant connection.

### 5.8 Ingestion source expansion — **planned (Ticketmaster + Eventbrite)**

Two new sources to broaden NYC event coverage beyond the current set
(Public Records, Nowadays, Elsewhere, RA-NYC). Both run inside the
existing daily 10:00 UTC Railway cron via the same `Scraper`
interface as the rest of `packages/ingestion/src/scrapers/*`.

**5.8.1 Ticketmaster Discovery API — `tm-nyc`** — free tier (5000
calls/day), Ahmed prototyped locally; wire into cron + dedup.
`classificationName=music&dmaId=345` (NYC DMA). Source slug `tm-nyc`.

**5.8.2 Eventbrite — scoping spike required first.** Public search
endpoint may have been deprecated in 2019/2020. Test
`eventbriteapi.com/v3/events/search/?location.address=brooklyn` — if
works, ship as Scraper; if returns 404, scope a public-site HTML
scraper.

Estimate: 2 days for `tm-nyc` + 0.5 day spike + 1–2 days Eventbrite.

---

## Phase 6 — Desktop experience + discovery polish

### 6.1 Desktop responsive refactor — **shipped**

Sticky left filter sidebar at `lg`+ breakpoint, wider event cards in
a 2-col grid, dedicated `DesktopTopNav`.

### 6.2 Date selector — **shipped**

Custom single-date picker inline in the desktop sidebar + collapsed
disclosure on mobile sheet.

### 6.3 Dynamic live search (typeahead) — **partial ship → v2 actively in progress**

Ahmed shipped a basic version (commit `87ced38`); v2 spec calls for
cross-entity search with live previews + entity-aware filter pills.
**v2 is the active workstream.**

See earlier roadmap revisions for the full v2 spec.

---

## Phase 3 polish + maintenance — shipped phases

### 3.15 NYC-wide expansion — **shipped**
### 3.16 Pre-insert dedup — **shipped**
### 3.17 Hero fallback chain — **shipped**
### 3.18 Filter vocabulary rebuild — **shipped**

See earlier roadmap revisions for full per-phase detail.

---

## Phase 4f.1 — SoundCloud + Bandcamp avatar fallback — **shipped**
### 4f.1.1 og:image direct scrape (LLM hallucination repair) — **shipped**

---

## Phase iOS — Native shell + TestFlight v0.1.1 — **shipped (2026-04-27)**

The web build is now wrapped as a Capacitor 8 iOS app and distributed
to internal testers via TestFlight. The unblocking change was switching
Google Sign-In from the web OAuth redirect to the native iOS account
picker via `@capgo/capacitor-social-login` plus Supabase's
`signInWithIdToken`.

Key files: `use-google-sign-in.ts`, `init-social-login.tsx`,
`login-google-button.tsx`, `signin-step.tsx`, `Info.plist`.
Supabase config: iOS Client ID appended (comma-separated) to the
Google provider's "Authorized Client IDs", "Skip nonce checks"
enabled.

**Open work for v0.1.2+:**
- Track the iOS Capacitor scaffold in git — see "Active follow-ups".
- Smoke-test sign-out/sign-back-in, force-quit cold start, deferred
  sign-in path on device.
- App Store review submission once internal testers confirm.
- Apple Sign-In (App Store guideline 4.8 may require it).

---

## Phase 7 — Audio previews

### 7.1 Per-artist quick-play widget — **shipped (basic)**

Ahmed shipped this early (commit `8d847d9`): inline play button on
each lineup row that expands a Spotify embed iframe (when `spotify_url`
exists) or a SoundCloud player fallback.

### 7.2 Lineup-aggregate playlist — **planned**

Single "play the lineup" button on event detail.

---

## Phase 8 — Coverage expansion

### 8.1 Label/record-group scrapers — **planned**
### 8.2 Monthly popularity refresh — **queued (task #64)**

Re-hit Spotify + Firecrawl on all artists monthly. Catches rising
acts whose popularity has grown since their last enrichment.

---

## Phase 9 — Social layer

High lift. Don't start before Phases 5–8 have enough runway.

### 9.1 Friends attending
### 9.2 Venue feedback

---

## Phase 10 — Advanced visualization

### 10.1 Artist vector graph
### 10.2 Event mixed-genre visual plot
### 10.3 Artist 4D timecapsule (R&D)

---

## Cross-cutting notes

- **Every phase ships to the same infrastructure** — Vercel for web,
  Railway cron for any new enrichment passes, Supabase for storage.
  No new hosts.
- **Schema migrations get numbered sequentially.** Through 0023 as
  of Phase 5.7. Recent additions: 0017 events.setting, 0018 genre
  cleanup + remap, 0019 user_prefs preferred_setting split, 0020
  artist external images (SC/BC), 0021 search_suggestions, 0022
  user_soundcloud_follows + user_prefs/artists.soundcloud_username,
  0023 user_spotify_follows + user_prefs.spotify_*. Migrations don't
  get rewritten; if a change is wrong, it's superseded by the next
  numbered migration.
- **User-facing ML stays simple.** Tag-overlap scoring, exponential
  moving averages, weighted popularity — no model training, no vector
  DB, until the taxonomy-based approach obviously saturates.

---

## Active follow-ups

### Phase 5.7 ops paste (Phase 5.7 tail — NEW 2026-04-29)

Code shipped, infra paste outstanding:

1. **Provision the Spotify bot account.** Create dedicated Spotify
   account `curi-bot-{random}` with a throwaway email Curi controls.
   Sign in via web; capture `sp_dc` cookie from DevTools →
   Application → Cookies → `https://open.spotify.com`.
2. **Paste cookie env var:**
   - Vercel: `SPOTIFY_BOT_SP_DC=<cookie>` on the apps/web project.
   - Railway: same var on the existing ingest service AND on the two
     new cron services below.
3. **Wire two new Railway cron services:**
   - `refresh-spotify-follows` — `node packages/ingestion/dist/cli-spotify-refresh.js`
     at `0 5 * * 0` (Sunday 05:00 UTC).
   - `healthcheck-spotify-bot` — `node packages/ingestion/dist/scripts/healthcheck-spotify-bot.js`
     at `0 9 * * *` (daily 09:00 UTC).
   Same Dockerfile as the existing ingest + SC services; only the
   `startCommand` + `cronSchedule` differ. Inherit `SUPABASE_*` env.
4. **Smoke test end-to-end.** With `SPOTIFY_BOT_SP_DC` set, run
   `pnpm --filter @curi/ingestion smoke:spotify-follows 1249423375`
   and confirm Christian's actual followed-artists list comes back.
   Then go to `/profile` on prod, tap **Connect** on the Spotify card,
   walk the 4-page overlay, paste your URL, and verify
   `user_spotify_follows` is populated and the home feed re-ranks
   with Spotify-tier events at the top.

### Venue image_url backfill (Phase 3.17 tail)

Top NYC venues still rendering the gradient placeholder. Public
Records (16), Apollo Studio (6), Outer Heaven (5), Jupiter Disco (3),
Bossa Nova Civic Club (2). Two viable paths: Google Places Photos
API (paid, reliable) or manual curation. Destination column is
`venues.image_url` from migration 0016.

### Spotify followers backfill (Phase 3.18 tail)

The Phase 3.18 underground rule omits Spotify follower count because
~1000 artists have empty `spotify_followers`. Backfill from existing
Spotify enrichment context.

### Track the iOS Capacitor scaffold in git (Phase iOS tail)

The iOS shell that ships v0.1.1 to TestFlight lives only on Christian's
local machine as of 2026-04-27. Untracked: `apps/web/ios/`,
`apps/web/capacitor.config.ts`, `apps/web/public/capacitor-shell/`.
Need iOS `.gitignore` + commit the source tree.

### MUSICBRAINZ_USER_AGENT env required (post-Ahmed cleanup)

Ahmed's `f4d5b81` removed the `MUSICBRAINZ_USER_AGENT` default in
`packages/ingestion/src/env.ts`. Verify the var is set in Railway env
before the next nightly cron.

### RLS `auth_rls_initplan` optimization — deferred (post-0023 hygiene pass)

Supabase's performance linter flags every `auth.uid() = user_id`
predicate as suboptimal. Migration 0023 introduced four new policies
on `user_spotify_follows` that hit this warning. The same warning
fires on the existing 16 policies (now 20 with 0023) across
`user_prefs`, `profiles`, `user_saves`, `user_soundcloud_follows`,
and `user_spotify_follows`. Inherited project-wide pattern, not a
regression. Deferred until scale starts mattering.

### curi.events OAuth verification + diagnostic-log strip (PR #5 tail)

PR #5 (`b0298f6d`) hardened `signInWithGoogle` origin derivation. Two
follow-ups still owed: verify the fix on curi.events post-deploy,
and strip the diagnostic `console.log` in
`apps/web/src/lib/supabase/actions.ts` once confirmed resolved.

### SC follow-graph cron scaling re-evaluation (Phase 5.6.5 follow-up)

Revisit when connected-user count crosses ~500. Options to evaluate:
jittered batching across the week, per-user lazy invalidation as
primary signal, monitor 429 rate and back off adaptively, or shard
by user_id modulo across N Railway services in parallel. Same
guidance applies to the 5.7 Spotify cron at scale.

### Cross-collaborator coordination note

As of 2026-04-25 the repo has two direct-to-main contributors
(Christian + Ahmed). No branch protection or PR-required gates yet.
Always `git fetch origin main` before assuming the local tree is the
deployed state.
