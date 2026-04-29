// Phase 5.6.2 — Playwright-based fallback scraper for SoundCloud follows.
//
// SCAFFOLDED, NOT EXPORTED. Activate only when the api-v2 path in
// follows-scraper.ts starts failing systemically (e.g. SC starts gating
// /resolve or /followings behind a CAPTCHA, or the client_id resolver
// breaks beyond the existing rotation-retry logic).
//
// Why not wire it now: every additional code path is more rope to
// debug. The api-v2 path has been stable across SC's web releases for
// years, and the cost of bringing Playwright into the bundle (~250 MB
// of headless Chromium) is significant. This file exists as a
// documented sketch so the next person doesn't have to start from
// zero — not as a deployed runtime.
//
// To activate:
//   1. `pnpm --filter @curi/ingestion add playwright` (already a dep)
//   2. Replace the `throw` below with a real Playwright session that:
//        a. launches headless Chromium with viewport 1920x1080
//        b. navigates to https://soundcloud.com/{username}/following
//        c. scrolls to bottom in a loop until the row count plateaus
//           (indicates the lazy-load cursor has emptied)
//        d. parses each <li> in the followings list, extracts:
//             - href → permalink/slug for `username` field (lowercase it)
//             - .sc-link-primary text → `displayName`
//             - <time datetime="..."> if present → `followedAt`
//        e. closes the browser
//        f. returns ScrapedFollow[]
//   3. Re-export from ./index.ts: `export * from './playwright-fallback.js';`
//   4. Edit follows-scraper.ts to fall through to this on persistent
//      api-v2 failure (probably gate on a `try/catch` around
//      paginateFollowings that catches ScrapeFailedError and re-tries
//      via Playwright).
//
// The Playwright path will be much slower per user (10-30s vs 2-5s for
// api-v2) and uses substantially more memory. Use only as a fallback,
// not as a primary path.

import { ScrapeFailedError, type ScrapedFollow } from './types.js';

/**
 * NOT IMPLEMENTED. See header comment above for the activation
 * checklist when api-v2 breaks. Throws so any accidental import +
 * call fails loudly rather than returning silent empty results.
 */
export async function scrapeFollowsViaPlaywright(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _username: string,
): Promise<ScrapedFollow[]> {
  throw new ScrapeFailedError(
    'Playwright fallback is scaffolded but not wired up — see ' +
      'packages/ingestion/src/soundcloud/playwright-fallback.ts header ' +
      'for the activation checklist.',
  );
}
