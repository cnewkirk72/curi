#!/usr/bin/env tsx
// Phase 5.6.2 smoke script — fetch a SoundCloud user's public follow
// list and print it. Used during dev to verify the scraper works
// against real SC data without spinning up the whole connect-card UI.
//
// Usage:
//   pnpm --filter @curi/ingestion smoke:sc-follows <username>
//
// Example:
//   pnpm --filter @curi/ingestion smoke:sc-follows flux-pavilion
//
// Exits 0 on success (printing JSON), 1 on any error.

import {
  scrapeUserFollows,
  UserNotFoundError,
  ScrapeFailedError,
} from '../src/soundcloud/index.js';

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    console.error(
      'Usage: pnpm --filter @curi/ingestion smoke:sc-follows <username>',
    );
    process.exit(1);
  }

  const start = Date.now();
  try {
    const follows = await scrapeUserFollows(username);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // Print summary first so it's readable at a glance.
    console.error(
      `[smoke:sc-follows] @${username}: ${follows.length} follows in ${elapsed}s`,
    );

    // JSON to stdout so the output can be piped (e.g. `| jq .`).
    console.log(JSON.stringify(follows, null, 2));
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      console.error(`[smoke:sc-follows] not found: @${err.username}`);
      process.exit(1);
    }
    if (err instanceof ScrapeFailedError) {
      console.error(`[smoke:sc-follows] scrape failed: ${err.message}`);
      if (err.cause) console.error(err.cause);
      process.exit(1);
    }
    console.error('[smoke:sc-follows] unexpected error:', err);
    process.exit(1);
  }
}

main();
