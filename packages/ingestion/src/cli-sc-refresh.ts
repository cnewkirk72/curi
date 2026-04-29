#!/usr/bin/env node
// Phase 5.6.5 — CLI entrypoint for the weekly SoundCloud follow refresh
// cron. Standalone so Railway can wire a second service against this
// command without affecting the existing daily ingest cron.
//
// Usage (locally or via Railway cron service):
//   pnpm --filter @curi/ingestion refresh:sc-follows
//
// Railway dashboard wiring (one-time, manual — see roadmap follow-up):
//   - Add a new service in the Curi Railway project
//   - Same Dockerfile as the existing service
//   - Set `startCommand`: `node packages/ingestion/dist/cli-sc-refresh.js`
//   - Set `cronSchedule`: `0 4 * * 0` (Sunday 04:00 UTC)
//   - Inherit the same SUPABASE_* env vars as the daily ingest service
//
// Exits 0 on attempted-and-completed runs (per-user failures are
// expected and don't fail the cron — see refresh-soundcloud-follows.ts
// for the failure-isolation contract). Exits 1 only when the run
// itself can't start (e.g. unreachable Supabase, missing env vars).

import 'dotenv/config';

import { refreshAllSoundcloudFollows } from './refresh-soundcloud-follows.js';

async function main(): Promise<void> {
  try {
    const summary = await refreshAllSoundcloudFollows();
    console.log(
      `[refresh-sc-follows] done: attempted=${summary.attempted}, ` +
        `succeeded=${summary.succeeded}, not-found=${summary.notFound}, ` +
        `failed=${summary.failed}, ${(summary.durationMs / 1000).toFixed(0)}s`,
    );
    process.exit(0);
  } catch (err) {
    console.error('[refresh-sc-follows] fatal', err);
    process.exit(1);
  }
}

main();
