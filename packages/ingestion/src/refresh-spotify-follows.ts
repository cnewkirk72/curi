// Phase 5.7 — weekly background refresh of every connected user's
// Spotify follow graph.
//
// Mirrors refresh-soundcloud-follows.ts (Phase 5.6.5). Same
// replace-not-merge contract, same per-user error isolation, same
// summary shape — different platform.
//
// Scheduling: intended to run via a separate Railway cron service at
// `0 5 * * 0` (Sunday 05:00 UTC) — offset from the SC refresh's
// 04:00 slot so the two crons don't overlap. The SC cron uses 1 req/
// sec outer throttle; the Spotify cron uses 1.5 req/sec because
// pathfinder counts toward the bot's per-account rate budget (no
// per-user mitigation possible on a single shared bot).
//
// Failure tolerance: per-user errors are logged and skipped — a
// user with a private profile or a network blip doesn't abort the
// remaining N-1 syncs. SpotifyAuthFailedError is special-cased: if
// the bot's sp_dc cookie has expired, EVERY user sync would fail, so
// we abort the run after the first auth-failed and rely on the daily
// healthcheck cron to have already paged Christian.

import { supabase } from './supabase.js';
import {
  fetchUserFollowedArtists,
  ScrapeFailedError,
  SpotifyAuthFailedError,
  UserNotFoundError,
} from './spotify-follows/index.js';

const THROTTLE_MS = 1500; // 1.5 req/sec outer throttle

type ConnectedUser = {
  user_id: string;
  spotify_user_id: string;
};

export type RefreshSummary = {
  attempted: number;
  succeeded: number;
  notFound: number;
  failed: number;
  durationMs: number;
  abortedReason?: 'bot_auth_failed';
};

/**
 * Iterate every user with a populated `user_prefs.spotify_user_id`,
 * re-fetch their public follow graph, and replace the rows in
 * `user_spotify_follows`. Stamps `spotify_last_synced_at` after each
 * successful sync so the connect-card UI's "Last synced X ago" label
 * reflects reality.
 *
 * Uses the service-role Supabase client (RLS bypass) — only safe to
 * run inside the Railway worker, never in user-facing code.
 */
export async function refreshAllSpotifyFollows(): Promise<RefreshSummary> {
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
    .select('user_id, spotify_user_id')
    .not('spotify_user_id', 'is', null);

  if (error) {
    console.error(
      '[refresh-spotify-follows] failed to enumerate connected users:',
      error.message,
    );
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Same @supabase/ssr / generated-type quirk as the rest of the
  // codebase — cast the row shape via unknown.
  const users = (data ?? []) as unknown as ConnectedUser[];
  console.log(
    `[refresh-spotify-follows] starting: ${users.length} connected users`,
  );

  for (const user of users) {
    if (!user.spotify_user_id) continue;
    summary.attempted += 1;

    try {
      const artists = await fetchUserFollowedArtists(user.spotify_user_id);

      // Same replace-not-merge contract as the user-driven server
      // action in apps/web — clean delete + insert keeps "user
      // unfollowed someone on Spotify" propagating without diff logic.
      const del = await supabase()
        .from('user_spotify_follows')
        .delete()
        .eq('user_id', user.user_id);
      if (del.error) throw del.error;

      if (artists.length > 0) {
        const rows = artists.map((a) => ({
          user_id: user.user_id,
          spotify_artist_id: a.spotifyId,
          display_name: a.name,
          followed_at: a.followedAt,
        }));
        const ins = await supabase()
          .from('user_spotify_follows')
          .insert(rows);
        if (ins.error) throw ins.error;
      }

      const upd = await supabase()
        .from('user_prefs')
        .update({
          spotify_last_synced_at: new Date().toISOString(),
        })
        .eq('user_id', user.user_id);
      if (upd.error) throw upd.error;

      summary.succeeded += 1;
      console.log(
        `[refresh-spotify-follows] user:${user.spotify_user_id}: ` +
          `${artists.length} artists`,
      );
    } catch (err) {
      // Per-user failures are isolated — log and continue. EXCEPT
      // bot-auth failures, which mean every subsequent sync would
      // fail too — abort the run early.
      if (err instanceof SpotifyAuthFailedError) {
        summary.failed += 1;
        summary.abortedReason = 'bot_auth_failed';
        console.error(
          `[refresh-spotify-follows] FATAL bot auth failure — aborting run.`,
          'Re-paste SPOTIFY_BOT_SP_DC and re-trigger the cron.',
          err.message,
        );
        break;
      }
      if (err instanceof UserNotFoundError) {
        summary.notFound += 1;
        console.warn(
          `[refresh-spotify-follows] user:${user.spotify_user_id}: ` +
            'not found (private or deleted)',
        );
      } else if (err instanceof ScrapeFailedError) {
        summary.failed += 1;
        console.warn(
          `[refresh-spotify-follows] user:${user.spotify_user_id}: ` +
            `scrape failed — ${err.message}`,
        );
      } else {
        summary.failed += 1;
        console.error(
          `[refresh-spotify-follows] user:${user.spotify_user_id}: ` +
            'unexpected error',
          err,
        );
      }
    }

    // Throttle between users. The pathfinder client itself has its
    // own internal throttle between paginated calls; this outer
    // throttle smooths the cron's overall request rate so the bot
    // account doesn't trip Spotify's behavioral classifier.
    await sleep(THROTTLE_MS);
  }

  summary.durationMs = Date.now() - start;
  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
