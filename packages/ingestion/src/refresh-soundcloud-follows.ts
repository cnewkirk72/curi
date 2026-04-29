// Phase 5.6.5 — weekly background refresh of every connected user's
// SoundCloud follow graph.
//
// Purpose: SC users follow new artists between syncs. Without this
// periodic refresh, a user who connected on day 1 keeps the same
// follow set forever (until they manually hit Refresh on /profile).
// Running once a week catches new follows without burning api-v2
// rate budget unnecessarily.
//
// Scheduling: intended to run via a separate Railway cron service at
// `0 4 * * 0` (Sunday 04:00 UTC) — see roadmap follow-up for the
// dashboard wiring step. The existing daily ingest cron runs at
// 10:00 UTC; the SC refresh's 04:00 slot is far enough offset to
// avoid contention on Supabase.
//
// Throttling: 1 req/sec across the full user list. SC's api-v2 has
// no published rate limit but bursting can trigger 429s; spacing each
// user's scrape (which is itself paginated, ~3 internal req/sec via
// the scraper's PAGE_THROTTLE_MS) means the cron's outer rate is
// well below anything that would draw attention.
//
// Failure tolerance: per-user errors are logged and skipped — one
// user with a private profile or a network blip doesn't abort the
// remaining N-1 syncs. Final summary printed to stdout for cron-log
// review.

import { supabase } from './supabase.js';
import {
  scrapeUserFollows,
  ScrapeFailedError,
  UserNotFoundError,
} from './soundcloud/index.js';

const THROTTLE_MS = 1000;

type ConnectedUser = {
  user_id: string;
  soundcloud_username: string;
};

export type RefreshSummary = {
  attempted: number;
  succeeded: number;
  notFound: number;
  failed: number;
  durationMs: number;
};

/**
 * Iterate every user with a populated `user_prefs.soundcloud_username`,
 * re-scrape their public follow graph, and replace the rows in
 * `user_soundcloud_follows`. Stamps `soundcloud_last_synced_at` after
 * each successful sync so the connect-card UI's "Last synced X ago"
 * label reflects reality.
 *
 * Uses the service-role Supabase client (RLS bypass) — only safe to
 * run inside the Railway worker, never in user-facing code.
 */
export async function refreshAllSoundcloudFollows(): Promise<RefreshSummary> {
  const start = Date.now();
  const summary: RefreshSummary = {
    attempted: 0,
    succeeded: 0,
    notFound: 0,
    failed: 0,
    durationMs: 0,
  };

  const { data, error } = await supabase()
    .from('user_prefs')
    .select('user_id, soundcloud_username')
    .not('soundcloud_username', 'is', null);

  if (error) {
    console.error(
      '[refresh-sc-follows] failed to enumerate connected users:',
      error.message,
    );
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Same @supabase/ssr / generated-type quirk as the rest of the
  // codebase — cast the row shape via unknown.
  const users = (data ?? []) as unknown as ConnectedUser[];
  console.log(`[refresh-sc-follows] starting: ${users.length} connected users`);

  for (const user of users) {
    if (!user.soundcloud_username) continue;
    summary.attempted += 1;

    try {
      const follows = await scrapeUserFollows(user.soundcloud_username);

      // Same replace-not-merge contract as the user-driven server
      // action in apps/web — clean delete + insert keeps "user
      // unfollowed someone on SC" propagating without diff logic.
      const del = await supabase()
        .from('user_soundcloud_follows')
        .delete()
        .eq('user_id', user.user_id);
      if (del.error) throw del.error;

      if (follows.length > 0) {
        const rows = follows.map((f) => ({
          user_id: user.user_id,
          soundcloud_username: f.username,
          display_name: f.displayName,
          followed_at: f.followedAt,
        }));
        const ins = await supabase().from('user_soundcloud_follows').insert(rows);
        if (ins.error) throw ins.error;
      }

      const upd = await supabase()
        .from('user_prefs')
        .update({
          soundcloud_last_synced_at: new Date().toISOString(),
        })
        .eq('user_id', user.user_id);
      if (upd.error) throw upd.error;

      summary.succeeded += 1;
      console.log(
        `[refresh-sc-follows] @${user.soundcloud_username}: ${follows.length} follows`,
      );
    } catch (err) {
      // Per-user failures are isolated — log and continue. The cron
      // logs are how Christian notices systematic breakage; if a
      // single sync fails it'll get retried next Sunday or via the
      // user's manual Refresh button on /profile in between.
      if (err instanceof UserNotFoundError) {
        summary.notFound += 1;
        console.warn(
          `[refresh-sc-follows] @${user.soundcloud_username}: not found (private or deleted)`,
        );
      } else if (err instanceof ScrapeFailedError) {
        summary.failed += 1;
        console.warn(
          `[refresh-sc-follows] @${user.soundcloud_username}: scrape failed — ${err.message}`,
        );
      } else {
        summary.failed += 1;
        console.error(
          `[refresh-sc-follows] @${user.soundcloud_username}: unexpected error`,
          err,
        );
      }
    }

    // Throttle between users. The scraper itself has its own internal
    // throttle between paginated calls; this outer throttle smooths
    // the cron's overall request rate so SC doesn't see a spike at
    // the start of the run.
    await sleep(THROTTLE_MS);
  }

  summary.durationMs = Date.now() - start;
  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
