#!/usr/bin/env tsx
// Phase 5.7 smoke script — fetch a Spotify user's public follow list
// and print it. Used during dev to verify the pathfinder client works
// against real Spotify data (with the bot's sp_dc cookie set in env)
// without spinning up the whole connect-card + overlay UI.
//
// Usage:
//   SPOTIFY_BOT_SP_DC=<cookie> \
//     pnpm --filter @curi/ingestion smoke:spotify-follows <userId>
//
// Example:
//   pnpm --filter @curi/ingestion smoke:spotify-follows 1249423375
//
// Accepts either:
//   - bare user ID (numeric or alphanumeric)
//   - full URL like https://open.spotify.com/user/1249423375?si=...
//
// Exits 0 on success (printing JSON), 1 on any error.

import 'dotenv/config';

import {
  fetchUserFollowedArtists,
  ScrapeFailedError,
  SpotifyAuthFailedError,
  UserNotFoundError,
} from '../src/spotify-follows/index.js';

// Inline copy of the URL stripping logic from the apps/web server
// action so the smoke script accepts the same input shapes Christian
// would paste in the overlay.
function extractSpotifyUserId(raw: string): string | null {
  const trimmed = raw.trim();
  const uriMatch = trimmed.match(/^spotify:user:([a-zA-Z0-9_.-]+)$/i);
  if (uriMatch) return uriMatch[1] ?? null;
  const cleaned = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?open\.spotify\.com\//i, '')
    .replace(/^\/+/, '')
    .split(/[?#]/)[0]
    ?.split('/');
  if (!cleaned) return null;
  if (cleaned[0] === 'user' && cleaned[1]) return cleaned[1];
  // Bare ID fallthrough
  if (cleaned.length === 1 && /^[a-zA-Z0-9_.-]+$/.test(cleaned[0]!)) {
    return cleaned[0]!;
  }
  return null;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error(
      'Usage: pnpm --filter @curi/ingestion smoke:spotify-follows <userId or URL>',
    );
    process.exit(1);
  }

  const userId = extractSpotifyUserId(input);
  if (!userId) {
    console.error(
      `[smoke:spotify-follows] could not extract user ID from "${input}"`,
    );
    process.exit(1);
  }

  const start = Date.now();
  try {
    const artists = await fetchUserFollowedArtists(userId);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.error(
      `[smoke:spotify-follows] user:${userId}: ${artists.length} artists in ${elapsed}s`,
    );

    // JSON to stdout so the output can be piped (e.g. `| jq .`).
    console.log(JSON.stringify(artists, null, 2));
  } catch (err) {
    if (err instanceof SpotifyAuthFailedError) {
      console.error(
        `[smoke:spotify-follows] BOT AUTH FAILED — re-paste SPOTIFY_BOT_SP_DC: ${err.message}`,
      );
      process.exit(1);
    }
    if (err instanceof UserNotFoundError) {
      console.error(
        `[smoke:spotify-follows] not found or private: user:${err.userId}`,
      );
      process.exit(1);
    }
    if (err instanceof ScrapeFailedError) {
      console.error(`[smoke:spotify-follows] scrape failed: ${err.message}`);
      if (err.cause) console.error(err.cause);
      process.exit(1);
    }
    console.error('[smoke:spotify-follows] unexpected error:', err);
    process.exit(1);
  }
}

main();
