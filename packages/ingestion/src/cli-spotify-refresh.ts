#!/usr/bin/env node
// Phase 5.7 — CLI entrypoint for the weekly Spotify follow refresh
// cron. Standalone so Railway can wire a third service against this
// command without affecting the existing daily ingest cron or the
// SC follow-refresh cron.
//
// Usage (locally or via Railway cron service):
//   pnpm --filter @curi/ingestion refresh:spotify-follows
//
// Railway dashboard wiring (one-time, manual — see roadmap follow-up):
//   - Add a new service in the Curi Railway project
//   - Same Dockerfile as the existing ingest + SC services
//   - Set `startCommand`: `node packages/ingestion/dist/cli-spotify-refresh.js`
//   - Set `cronSchedule`: `0 5 * * 0` (Sunday 05:00 UTC)
//   - Inherit the existing SUPABASE_* env vars
//   - Add SPOTIFY_BOT_SP_DC env var (the bot account's sp_dc cookie)
//
// Exits 0 on attempted-and-completed runs (per-user failures are
// expected and don't fail the cron — see refresh-spotify-follows.ts
// for the failure-isolation contract). Exits 1 only when the run
// itself can't start OR the bot's sp_dc cookie has expired (since
// every user's sync would fail and we want Railway to flag the run
// as broken).

import 'dotenv/config';

import { refreshAllSpotifyFollows } from './refresh-spotify-follows.js';

async function main(): Promise<void> {
  try {
    const summary = await refreshAllSpotifyFollows();
    console.log(
      `[refresh-spotify-follows] done: ` +
        `attempted=${summary.attempted}, ` +
        `succeeded=${summary.succeeded}, ` +
        `not-found=${summary.notFound}, ` +
        `failed=${summary.failed}, ` +
        `${(summary.durationMs / 1000).toFixed(0)}s` +
        (summary.abortedReason ? ` (aborted: ${summary.abortedReason})` : ''),
    );
    // If the run aborted because of bot-auth failure, exit 1 so
    // Railway flags the run. Otherwise exit 0 (per-user failures are
    // expected and shouldn't mark the cron as broken).
    process.exit(summary.abortedReason === 'bot_auth_failed' ? 1 : 0);
  } catch (err) {
    console.error('[refresh-spotify-follows] fatal', err);
    process.exit(1);
  }
}

main();
