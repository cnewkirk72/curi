# Phase 5.7 — Spotify follow-graph personalization

**Status:** Spec drafted 2026-04-29. Awaiting approval before implementation.

**Authors:** Christian (product/UX direction) · Curi engineering

**Replaces** the original Phase 5.7 roadmap entry, which was structured
around two now-rejected auth paths (per-user OAuth and per-user `sp_dc`
cookie). This spec is the canonical version going forward.

---

## 1. Goal

Mirror Phase 5.6 (SoundCloud follow-graph) for Spotify users. The user
connects Spotify on `/profile`, Curi imports their public followed-
artists list via a dedicated bot account, and lineup matches contribute
to the within-day feed sort with the same FOLLOWED_TIER mechanic
shipped in Phase 5.6.6 — extended to a multi-tier system so events
matching on both platforms surface above events matching on only one.

The shipped Phase 5.6.7 SC indicator (orange `#FF5500` dot at the
bottom-right of artist avatars) is the visual model. Spotify gets its
own dot in a Curi-tuned variant of Spotify's brand green; cross-
platform matches stack the two dots on the same avatar.

## 2. Architecture overview

Mirrors the Phase 5.6 SC architecture exactly so the patterns reinforce
each other and the cron/refresh/anon-safety contracts stay symmetric.

For full architectural detail and per-file scope, see the implementation
in commits 1–10 of this PR.

## 3. Auth approach

Bot service account + pathfinder GraphQL. Curi maintains a dedicated
Spotify "bot" account (NOT Christian's personal). The bot's `sp_dc`
cookie lives in `SPOTIFY_BOT_SP_DC` env. Christian re-pastes the
cookie ~yearly when it expires.

**Key insight:** Spotify's pathfinder GraphQL endpoint serves a target
user's followed-artists list to *any authenticated viewer* — the
cookie identifies the requester, not the target. So one authenticated
session (Curi's bot) is sufficient to read followed-artists for any
user whose profile is set to public.

## 4. Profile URL parsing

User pastes their Spotify profile URL via the connect card overlay.
The `extractSpotifyUserId()` helper accepts:

- `https://open.spotify.com/user/1249423375?si=e560b0ee7d8146f5`
- `https://open.spotify.com/user/bjornblanchard`
- `open.spotify.com/user/1249423375`
- `spotify:user:1249423375`
- bare user IDs (numeric or alphanumeric)

Validation: 1–100 chars matching `[a-zA-Z0-9_.-]`. The `?si=` query
param is Spotify's sharing tracker; stripping it has no effect on
the underlying identity.

## 5. Schema

See `supabase/migrations/0023_spotify_follows.sql`. New table
`user_spotify_follows` with the same RLS shape as
`user_soundcloud_follows`. Indexes on `user_id` and
`spotify_artist_id`. Two new columns added to `user_prefs`:
`spotify_user_id` and `spotify_last_synced_at`.

## 6. Pathfinder client

See `packages/ingestion/src/spotify-follows/`. Full implementation
includes:

- **bot-token.ts** — `sp_dc` cookie → access token via
  `https://open.spotify.com/api/token`. Memoized 55min.
- **hash-resolver.ts** — extract `queryArtistsFollowed` sha256Hash from
  open.spotify.com bundle. Memoized per-process; invalidated on 400.
- **pathfinder.ts** — paginated `queryArtistsFollowed`, offset+limit=100,
  250ms throttle, 50-page cap, 401/400/429 retry semantics.
- **playwright-fallback.ts** — scaffolded but not exported; activate when
  pathfinder breaks systemically.
- **types.ts** — `SpotifyFollowedArtist` + 3 error classes.

Dual-copied to `apps/web/src/lib/spotify-follows/` for the Vercel
server action's use, with `HeadersInit` instead of
`Record<string,string>` and relative imports without `.js`.

## 7. Server action

See `apps/web/src/app/actions/sync-spotify-follows.ts`. Wraps the
pathfinder client with auth check, URL parsing, error mapping, and the
replace-not-merge DB write into `user_spotify_follows` +
`user_prefs.spotify_*` stamping.

```ts
export type SyncResult =
  | { ok: true; count: number; userId: string }
  | {
      ok: false;
      error:
        | 'unauth'
        | 'invalid_url'
        | 'private_profile'
        | 'bot_auth_failed'
        | 'scrape_failed';
    };
```

Revalidates `/`, `/saved`, `/profile` on success.

## 8. UI: ConnectorsSection redesign

Rename the existing standalone SC connect card section to a
`<ConnectorsSection>` wrapper hosting both Spotify (above) and
SoundCloud (below). Each card self-renders its own subheader
("Spotify follows" / "SoundCloud follows"); the wrapper owns the
parent "Connectors" eyebrow.

Visual rhythm + brand-color discipline: only the connect/connected
accent changes between cards (Spotify green vs SC orange). Card
chrome, border, type ramp, padding all identical.

**Color vocabulary** after this PR:

| Color | Meaning |
|---|---|
| Cyan | Primary action, transient success, default focus |
| SC orange | SoundCloud follow signal |
| **Spotify green** | **Spotify follow signal (NEW)** |
| Amber | Warning/error palette |
| Violet | Artist search-pill scope |

## 9. UI: Spotify onboarding overlay

See `apps/web/src/components/profile/spotify-onboarding-overlay.tsx`.
4-page swipeable glass overlay:

1. "Open Spotify and tap your profile picture" — top-left of home tab
2. "Tap *View profile*" — first option in menu
3. "Tap *Share* and *Copy link to profile*" — share-sheet copy
4. "Paste your profile URL" — input field with live validation

Close button top-LEFT (per Christian's spec). Skip/Submit pill
bottom-right. Page dots, swipe gesture, focus trap, Esc to close,
←/→ keyboard nav, `role="dialog" aria-modal="true"`.

State machine: `browsing → submitting → success | error`. Brief 1.5s
success card on `ok: true`, then hard-refresh to `/`.

## 10. UI: Cross-platform badge stacking

See `apps/web/src/components/follow-dot-stack.tsx`.

- SC follow only → single sc-orange dot, bottom-right
- Spotify follow only → single spotify-green dot, bottom-right
- Both → spotify-green dot offset +3px upper-right, sc-orange dot
  on top at bottom-right
- Neither → null

Used by EventCard (`size="sm"` on 6×6 cluster avatars) and LineupList
(`size="md"` on 14×14 headliner, `size="sm"` on 10×10 supporting).

## 11. Sort: 3-tier feedScore

See `apps/web/src/lib/enrichment.ts`. Phase 5.6.6's single tier-floor
is split into three:

| Tier | Condition | Floor |
|---|---|---|
| 0 | BOTH Spotify + SC follow match in lineup | `3_000_000` |
| 1 | Spotify match only | `2_000_000` |
| 2 | SoundCloud match only | `1_000_000` |
| 3 | No follow match | `0` |

1M headroom dwarfs the realistic popSum range (~600), so tier
separation is unambiguous. Within each tier, events sort by summed
popularity. Tier 3 retains the Phase 5.6.6 popSum + genre-pref
formula.

Anon-safe: all three follow-set parameters are optional. Empty/
undefined Sets → Tier 3 sort → pure popularity for un-signed-in users.

## 12. Cron

See `packages/ingestion/src/refresh-spotify-follows.ts` +
`cli-spotify-refresh.ts`. Sunday 05:00 UTC (offset from SC's 04:00),
1.5 req/sec outer throttle, per-user error isolation. Aborts on
bot-auth failure (every subsequent user would fail too); the daily
healthcheck cron (`scripts/healthcheck-spotify-bot.ts`) catches this
before it surfaces in user-driven syncs.

## 13. Bot infra ops

### Setup

1. Create dedicated Spotify account `curi-bot-{random}` (throwaway
   email).
2. Sign in via web; capture `sp_dc` cookie from DevTools.
3. Add `SPOTIFY_BOT_SP_DC` to env on Vercel + Railway.
4. Wire the healthcheck cron at `0 9 * * *` on Railway.

### Cookie expiry alerting

Daily healthcheck cron mints a token via the bot's sp_dc; on 401
exits 1 + writes loud stderr message. Catches expiry within 24h
rather than during a user-driven sync.

### Ban risk mitigations

- Dedicated throwaway account
- 1.5 req/sec outer throttle in cron
- Spread daily re-syncs across 24h window
- If banned: create new bot, re-paste cookie, ~10min downtime

## 14. Verification

- apps/web typecheck clean
- packages/ingestion typecheck clean
- Schema migration applied + advisor sweep clean
- Bot smoke test returns Christian's actual follow list
- Server action smoke: end-to-end overlay flow populates DB
- Sort verification: hand-add tier 0/1/2/3 events; confirm ordering
- Anon path: no badges, no boost, no section visible
- Cross-platform stack: both-followed shows two dots correctly
- Bot cookie expiry: stale env triggers healthcheck within 24h
- Hash rotation: pathfinder retry recovers without manual intervention

## 15. Phased subtasks

Split into 12 commits in this PR:

1. Schema migration 0023 + ingestion package.json scripts
2. ingestion spotify-follows module (pathfinder + bot-token + hash-resolver)
3. ingestion CLI: cron + smoke + healthcheck
4. apps/web spotify-follows dual-copy + sync action + connection getter
5. 3-tier feedScore + saves projection + Tailwind/CSS Spotify-green tokens
6. FollowDotStack + EventCard/LineupList swap
7. ConnectorsSection wrapper + SpotifyConnectCard
8. SpotifyOnboardingOverlay + InfiniteFeed wiring
9. page wiring (home / saved / profile / event-detail)
10. types regen (apps/web supabase types + packages/ingestion db-types) + events.ts spotify_id
11. spec doc (this file)
12. roadmap update

---

*Spec authored 2026-04-29 — implementation lands in this PR.*
