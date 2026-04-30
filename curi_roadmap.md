# Curi Roadmap

Forward plan, phased by lift (lowest → highest). Items sourced from
Christian's consolidated idea list + notes flagged during Phase 4.

**Currently shipped:** Phases 1–4 in full; Phase 4f.1 + 4f.1.1
(SC/BC avatar fallback + og:image LLM-hallucination repair); Phase 5
partial (5.1 / 5.2 / 5.4 + onboarding redirect gate); Phase 5.6
(SoundCloud follow-graph) + 5.6.6 (3-tier feedScore + candidate-pool
fix) + 5.6.7 (SC brand-orange indicator); **Phase 5.7 (Spotify
schema + sort + UI, 2026-04-29)**; Phase 6 partial (6.1 desktop
responsive + 6.2 date selector + 6.3 basic title-only search by
Ahmed); Phase 7 partial (7.1 basic iframe player by Ahmed); Phase 3
polish 3.15–3.18 (NYC-wide expansion, pre-insert dedup, hero
fallback chain, filter vocabulary rebuild); **Phase iOS** (Capacitor
8 shell + native Google Sign-In + TestFlight v0.1.1, 2026-04-27).
See `CURI_CONTEXT.md` for status detail.

**Actively in progress (2026-04-29):**
- **Phase 5.7.1** — Spotify connect via WKWebView + native iOS
  Capacitor plugin (replaces the Phase 5.7 bot-account flow that
  hit Spotify's Fastly cloud-IP edge block). See
  `phase-5.7.1-wkwebview-spotify-spec.md` for the full spec.
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

Five-step `/onboarding` flow.

### 5.3 Sorting options — **deferred / superseded by 5.6**

### 5.4 Dynamic subgenre pills — **shipped**

### 5.5 Onboarding redirect gate — **shipped**

### 5.6 SoundCloud-following personalized sort — **shipped (2026-04-28)**

User connects their SoundCloud account by entering their username on
`/profile`; Curi imports their public follow graph and uses it as a
personalization signal in the within-day event re-sort. Migration
0022 introduced `user_soundcloud_follows` + RLS +
`user_prefs.soundcloud_username` + `artists.soundcloud_username` +
backfill.

Subtasks 5.6.1 – 5.6.7 all shipped (see `CURI_CONTEXT.md` for full
detail).

### 5.7 Spotify-following personalized sort — **partial (schema + sort + UI shipped 2026-04-29; connect mechanism re-spec'd as 5.7.1)**

**What landed in 5.7:**

- Migration 0023 — `user_spotify_follows` + RLS + `user_prefs.spotify_user_id` /
  `spotify_last_synced_at`. Schema mirrors 0022. Advisor sweep clean.
- 3-tier `feedScore` (BOTH > Spotify > SC > none) with cross-platform
  match boost. `enrichmentScore` deprecated alias preserved.
- Candidate-pool augmentation — `getFollowedSpotifyEventsInWindow`
  mirrors the SC injector. Home + saved feed re-rank correctly when
  Spotify follow rows are present.
- `<FollowDotStack />` shared component — single-platform single dot;
  cross-platform spotify-green offset behind sc-orange.
- Spotify-green token (`#1ED760`) + `shadow-glow-spotify-sm` /
  `shadow-glow-spotify` utilities in tailwind.config.ts + globals.css.
- `<ConnectorsSection />` profile redesign with Spotify above SC.
- All page wiring (home / saved / profile / event-detail).

**What FAILED in the original 5.7 connect mechanism:**

The original 5.7 connect path used a server-side bot account with
`sp_dc` cookie auth + pathfinder GraphQL scraping. Spotify's Fastly
edge layer blocks ALL cloud-provider IP ranges (Vercel, Railway, AWS)
from the `/api/token` and `/get_access_token` endpoints. Confirmed via
production Vercel logs: `403 URL Blocked` from `cache-iad-...-IAD`
Fastly node. No amount of cookie / header / TOTP work bypasses this
from a cloud IP.

Mitigations attempted before pivot:
- Switched endpoint from legacy `/api/token` to current `/get_access_token`
  with `?reason=transport&productType=web-player` query params — still 403
- Added Origin / Referer / App-Platform browser-shape headers — still 403
- Added `SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH` env override + improved
  bundle-scrape regex — helped past hash extraction but bot-token
  still 403

Decision (2026-04-29): pivot to Phase 5.7.1 (WKWebView in Capacitor
iOS app). The Phase 5.7 schema + sort + UI all stay; only the
populator changes.

**Bot-account modules now dormant** — see Phase 5.7.1 spec §8.

### 5.7.1 Spotify connect via WKWebView — **in progress (2026-04-29)**

Native iOS Capacitor plugin opens a `WKWebView` to `open.spotify.com`
in an isolated `WKContentWorld`, the user signs into Spotify directly
(Curi never sees credentials), an injected script observes the
`/user-profile-view/v3/profile/{userId}/following` endpoint via
`PerformanceObserver`, extracts the artist URIs from the protobuf via
regex, and posts the ID list back to native via
`webkit.messageHandlers.curiSpotify`. Native dismisses the webview
(ephemeral cookies destroyed), forwards to the main Curi WebView via
Capacitor plugin event, which calls `syncSpotifyFollows` server
action with the user's existing Curi session. Replace-not-merge
into `user_spotify_follows`.

Key design decisions documented in
`phase-5.7.1-wkwebview-spotify-spec.md`:

- **`WKWebsiteDataStore.nonPersistent()`** — Spotify cookies
  destroyed on dismiss. No persistent Spotify session in the app.
- **`WKContentWorld("curi-spotify-bridge")`** — injected script
  isolated from Spotify's bundle. Stronger isolation than
  monkey-patching the page's fetch.
- **Strict navigation allowlist** — only `*.spotify.com` /
  `*.spotifycdn.com` / `*.scdn.co` URLs permitted in the webview.
- **Native SwiftUI consent sheet** shown BEFORE the webview opens,
  itemizing exactly what Curi reads / doesn't read.
- **`PerformanceObserver`** for response detection (cross-world
  safe), not page-script monkey-patch (Meta's pattern).

**Risk posture vs. Meta WKWebView crackdown:**

Felix Krause's August 2022 Meta disclosure documented Instagram /
Facebook in-app browsers automatically injecting tracking JS into
ALL third-party sites. Curi's flow is structurally different: single
user-initiated trigger, single endpoint observed, single data type
captured, explicit pre-flight consent screen, ephemeral cookies, no
form / keystroke / DOM-event tracking. Pattern is closer to
1Password autofill or Pocket article extraction — App Store-precedented
categories.

**Status:**

- iOS Capacitor plugin (Swift + JS) — written, lives in
  `apps/web/ios/App/App/Plugins/SpotifyConnect/`
- TS native-bridge wrapper — `apps/web/src/lib/spotify/native-bridge.ts`
- `syncSpotifyFollows` server action rewritten to accept ID list
- `disconnectSpotify` server action added
- `<SpotifyConnectCard />` branched on `Capacitor.isNativePlatform()`:
  native triggers plugin, web shows "Get Curi for iOS" prompt
- Phase 5.7 `<SpotifyOnboardingOverlay />` removed
- `getSpotifyConnection()` extended with `hasFollows` boolean as the
  canonical "connected?" predicate (since the WKWebView flow doesn't
  capture `spotify_user_id`)
- `PrivacyInfo.xcprivacy` declares music-data collection type

**Deferred to App Store ship:**

- App Store Connect privacy nutrition labels updated to match the
  manifest
- Demo video recording (60s walkthrough) for review notes
- Privacy policy update (Spotify Integration section per spec §7.2)
- Test account credentials provisioned for App Store reviewer
- App Store Connect review notes template populated per spec §8.2

**Deferred to future phases:**

- Browser extension for desktop web (Chrome / Firefox) — spec §9
- Android Capacitor port of the plugin — same pattern
- Persistent-session toggle ("Stay signed into Spotify in Curi") as
  optional profile setting (Option B in spec §3.2)

**Bot-account modules (`apps/web/src/lib/spotify-follows/*`,
`packages/ingestion/src/spotify-follows/*`, refresh + healthcheck
cron) now dormant.** Kept in tree as documented Plan B for future
residential-proxy + Playwright activation. The two paused Railway
cron services stay paused.

### 5.8 Ingestion source expansion — **planned (Ticketmaster + Eventbrite)**

See earlier roadmap revisions for full per-source detail.

---

## Phase 6 — Desktop experience + discovery polish

### 6.1 Desktop responsive refactor — **shipped**
### 6.2 Date selector — **shipped**
### 6.3 Dynamic live search (typeahead) — **partial ship → v2 actively in progress**

---

## Phase 3 polish + maintenance — shipped phases

### 3.15 NYC-wide expansion — **shipped**
### 3.16 Pre-insert dedup — **shipped**
### 3.17 Hero fallback chain — **shipped**
### 3.18 Filter vocabulary rebuild — **shipped**

---

## Phase 4f.1 — SoundCloud + Bandcamp avatar fallback — **shipped**
### 4f.1.1 og:image direct scrape — **shipped**

---

## Phase iOS — Native shell + TestFlight v0.1.1 — **shipped (2026-04-27)**

Capacitor 8 wrap of the apps/web Next.js build. Native Google Sign-In
via `@capgo/capacitor-social-login` + Supabase `signInWithIdToken`.

---

## Phase 7 — Audio previews

### 7.1 Per-artist quick-play widget — **shipped (basic)**
### 7.2 Lineup-aggregate playlist — **planned**

---

## Phase 8 — Coverage expansion

### 8.1 Label/record-group scrapers — **planned**
### 8.2 Monthly popularity refresh — **queued (task #64)**

---

## Phase 9 — Social layer

### 9.1 Friends attending
### 9.2 Venue feedback

---

## Phase 10 — Advanced visualization

### 10.1 Artist vector graph
### 10.2 Event mixed-genre visual plot
### 10.3 Artist 4D timecapsule (R&D)

---

## Cross-cutting notes

- **Schema migrations** — through 0023 as of Phase 5.7.

---

## Active follow-ups

### Phase 5.7.1 App Store submission (NEW 2026-04-29)

The WKWebView Spotify connect plugin is implemented but needs the
full App Store submission package before going live in production:

1. **Demo video** — 60s screen-recording walkthrough of the connect
   flow, attached to App Store Connect review notes
2. **Privacy policy update** — add the Spotify Integration section
   per `phase-5.7.1-wkwebview-spotify-spec.md` §7.2
3. **App Store Connect privacy labels** — mirror the
   `PrivacyInfo.xcprivacy` declaration in App Store Connect's App
   Privacy section
4. **Review notes** — populate per spec §8.2 with explicit
   walkthrough + intent statement
5. **Test account credentials** — provision a Spotify test account
   the reviewer can use; share via App Store Connect's secure notes
6. **Reviewer test plan** — verify the connect flow works on a fresh
   App Store Connect-sandbox device before submission

If rejected, appeal plan in spec §8.3.

### Phase 5.7.1 plugin integration in Xcode

The Capacitor plugin Swift files land in
`apps/web/ios/App/App/Plugins/SpotifyConnect/`. If `apps/web/ios/`
is still untracked locally (per the existing iOS-tracking follow-up),
these files are committed at the canonical path — they integrate when
the Xcode project is reconciled with main. Otherwise, drag them into
the App target via Xcode's File Navigator. The `.m` file must be
added as Compile Sources alongside `.swift` files; the
`spotify-bridge-script.js` resource must be added as a Bundle
Resource (not compile source).

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

Phase 5.7.1 added new files at `apps/web/ios/App/App/Plugins/SpotifyConnect/`
and `apps/web/ios/App/App/PrivacyInfo.xcprivacy`. These commit
cleanly even if the rest of `apps/web/ios/` is untracked, since git
only cares about the specific paths in the commit. They'll integrate
into Xcode when the iOS scaffold is reconciled.

### MUSICBRAINZ_USER_AGENT env required (post-Ahmed cleanup)

Ahmed's `f4d5b81` removed the `MUSICBRAINZ_USER_AGENT` default in
`packages/ingestion/src/env.ts`. Verify the var is set in Railway env
before the next nightly cron.

### RLS `auth_rls_initplan` optimization — deferred (post-0023 hygiene pass)

Supabase's performance linter flags every `auth.uid() = user_id`
predicate as suboptimal. Migration 0023 introduced four new policies
on `user_spotify_follows` that hit this warning. Inherited project-
wide pattern, not a regression. Deferred until scale starts mattering.

### curi.events OAuth verification + diagnostic-log strip (PR #5 tail)

PR #5 (`b0298f6d`) hardened `signInWithGoogle` origin derivation. Two
follow-ups still owed: verify the fix on curi.events post-deploy,
and strip the diagnostic `console.log`.

### SC follow-graph cron scaling re-evaluation (Phase 5.6.5 follow-up)

Revisit when connected-user count crosses ~500.

### Cross-collaborator coordination note

As of 2026-04-25 the repo has two direct-to-main contributors
(Christian + Ahmed). No branch protection or PR-required gates yet.
Always `git fetch origin main` before assuming the local tree is the
deployed state.
