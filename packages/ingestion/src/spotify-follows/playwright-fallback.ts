// Phase 5.7 — Playwright-based fallback for the Spotify follow-graph
// pathfinder client.
//
// SCAFFOLDED, NOT EXPORTED. Activate only when the pathfinder path
// in pathfinder.ts starts failing systemically (e.g. Spotify gates
// `queryArtistsFollowed` behind a CAPTCHA, removes anonymous viewer
// access for cross-profile reads, or otherwise blocks the bot
// account at the application layer).
//
// Why not wire it now: every additional code path is more rope to
// debug. The pathfinder path has been stable across Spotify's web
// releases for years (it's the same endpoint open.spotify.com uses
// internally), and the cost of bringing Playwright into the bundle
// (~250 MB of headless Chromium) is significant. This file exists as
// a documented sketch so the next person doesn't have to start from
// zero — not as a deployed runtime.
//
// To activate:
//   1. `pnpm --filter @curi/ingestion add playwright` (already a dep
//      from the SC fallback)
//   2. Replace the `throw` below with a real Playwright session that:
//        a. launches headless Chromium with viewport 1920x1080
//        b. attaches the bot's sp_dc cookie via context.addCookies()
//        c. navigates to https://open.spotify.com/user/{userId}/following
//        d. clicks the "Artists" filter pill (matches the manual user
//           flow Christian described in Phase 5.7 spec § 1)
//        e. scrolls to bottom in a loop until the list count plateaus
//        f. parses each row: href → spotify_artist_id, .name text →
//           display_name, image_url from the avatar img.src
//        g. closes the browser
//        h. returns SpotifyFollowedArtist[]
//   3. Re-export from ./index.ts: `export * from './playwright-fallback.js';`
//   4. Edit pathfinder.ts to fall through to this on persistent
//      pathfinder failure (gate on a try/catch around fetchPage that
//      catches SpotifyAuthFailedError + ScrapeFailedError and re-tries
//      via Playwright).
//
// The Playwright path will be much slower per user (15-45s vs 2-5s
// for pathfinder) and uses substantially more memory. Use only as a
// fallback, not as a primary path. Also note: the per-account ban
// risk is HIGHER under Playwright because the bot account is
// generating UI-level clicks at automation cadence rather than
// API-level requests.

import { ScrapeFailedError, type SpotifyFollowedArtist } from './types.js';

/**
 * NOT IMPLEMENTED. See header comment above for the activation
 * checklist when pathfinder breaks. Throws so any accidental import +
 * call fails loudly rather than returning silent empty results.
 */
export async function fetchUserFollowedArtistsViaPlaywright(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userId: string,
): Promise<SpotifyFollowedArtist[]> {
  throw new ScrapeFailedError(
    'Playwright fallback is scaffolded but not wired up — see ' +
      'packages/ingestion/src/spotify-follows/playwright-fallback.ts ' +
      'header for the activation checklist.',
  );
}
