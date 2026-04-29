#!/usr/bin/env tsx
// Phase 5.7 — Spotify bot account healthcheck.
//
// Runs daily on Railway (separate cron service or a `0 9 * * *`
// piggyback inside an existing service). Mints a token via the bot's
// sp_dc cookie; on 401 exits 1 + writes a loud message to stderr so
// Railway's alerting catches it and Christian can re-paste before
// the next user-driven sync hits the failure.
//
// Without this, a stale sp_dc would silently make every user's
// connect-card flow return `bot_auth_failed` for an indeterminate
// number of days until someone noticed.
//
// Usage:
//   SPOTIFY_BOT_SP_DC=<cookie> \
//     pnpm --filter @curi/ingestion healthcheck:spotify-bot
//
// Exit codes:
//   0  bot is healthy (token minted successfully)
//   1  bot auth failed (sp_dc missing/expired/anonymous)
//   2  unexpected error (network, etc — possibly transient, alert
//                        less aggressively)

import 'dotenv/config';

import {
  getBotAccessToken,
  invalidateBotToken,
  SpotifyAuthFailedError,
} from '../src/spotify-follows/index.js';

async function main(): Promise<void> {
  // Always invalidate first so we exercise the live token-mint path
  // (otherwise a memoized token from an earlier process call would
  // make the check a no-op).
  invalidateBotToken();

  const start = Date.now();
  try {
    const token = await getBotAccessToken();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    // Don't log the full token (it's a sensitive credential even if
    // short-lived); just confirm length + prefix as a sanity check.
    console.log(
      `[healthcheck:spotify-bot] OK: token minted (${token.length} chars, ` +
        `prefix ${token.slice(0, 6)}...) in ${elapsed}s`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof SpotifyAuthFailedError) {
      console.error(
        '[healthcheck:spotify-bot] FAILED — bot auth is broken:',
        err.message,
        '\n\nACTION: Re-paste SPOTIFY_BOT_SP_DC env var on Railway + Vercel ' +
          'before the next user sync. See OPS.md or Phase 5.7 spec § 13.1 ' +
          'for the cookie-extraction procedure.',
      );
      process.exit(1);
    }
    console.error('[healthcheck:spotify-bot] unexpected error:', err);
    process.exit(2);
  }
}

main();
