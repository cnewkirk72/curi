'use server';

// Phase 5.7 — server action backing the /profile Spotify connect
// card flow (via the SpotifyOnboardingOverlay's URL-paste step).
// Validates the user-supplied Spotify profile URL, resolves to a
// canonical user ID, fetches the public follow graph via pathfinder,
// replaces (not merges) the rows in user_spotify_follows, and stamps
// user_prefs with the connection state + sync timestamp.
//
// "Replace, don't merge" mirrors the SC sync action — Spotify also
// has no delta API for user-followed-artists, so we'd be re-fetching
// the whole list anyway, and a clean replace makes "I unfollowed
// someone on Spotify" propagate to Curi without a separate cleanup
// pass. Row counts per user are typically 50–500, capped at 5000 by
// the pathfinder client's pagination guard.
//
// Bot infra dependency: requires SPOTIFY_BOT_SP_DC env var. If the
// bot's cookie is missing or expired, the action returns
// `bot_auth_failed` and the connect card surfaces the appropriate
// "we're having trouble" copy. The daily healthcheck cron should
// have already paged Christian by the time a user hits this.
//
// Note: every export from a 'use server' module must be an async
// function — Next.js rejects the build otherwise. `SyncResult` is a
// type-only export which TS erases at compile time, so it slips past
// the rule. `extractSpotifyUserId` is intentionally NOT exported even
// though it's logically reusable; the smoke script at
// packages/ingestion/scripts/test-spotify-follows.ts keeps an inline
// copy, and any future consumer should also inline (or live in a
// non-'use server' module that re-exports both).

import { revalidatePath } from 'next/cache';
import {
  fetchUserFollowedArtists,
  SpotifyAuthFailedError,
  UserNotFoundError,
} from '@/lib/spotify-follows';
import { createClient } from '@/lib/supabase/server';

/**
 * Result returned to the connect card. Discriminated on `ok` so the
 * UI can branch the toast/status-bar copy without inspecting strings.
 *
 * `error` codes:
 *   - `unauth`            → user signed out mid-flow; route to /login
 *   - `invalid_url`       → couldn't extract a Spotify user ID from
 *                            the input; render targeted helper text
 *   - `private_profile`   → pathfinder returned no result for the
 *                            user (404 or strict-private privacy
 *                            setting); render the "make sure your
 *                            profile is public" copy
 *   - `bot_auth_failed`   → SPOTIFY_BOT_SP_DC missing or expired;
 *                            generic "lookup service is down" + the
 *                            healthcheck has paged Christian
 *   - `scrape_failed`     → transient pathfinder failure or DB write
 *                            error; generic "try again" + retry
 */
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

// Spotify user ID format: numeric (legacy `1249423375`-style) or
// alphanumeric (newer `bjornblanchard`-style) with optional dots,
// underscores, dashes. 1–100 chars.
const SPOTIFY_USER_ID_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Sync the signed-in user's Spotify follow graph from a profile URL.
 *
 * @param rawInput The user's Spotify profile URL (or bare user ID,
 *                 or `spotify:user:{id}` URI). The connect-card
 *                 overlay's URL-paste step passes whatever the user
 *                 typed; we extract the canonical ID server-side as
 *                 the security boundary.
 */
export async function syncSpotifyFollows(
  rawInput: string,
): Promise<SyncResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauth' };

  const userId = extractSpotifyUserId(rawInput);
  if (!userId || !SPOTIFY_USER_ID_RE.test(userId)) {
    return { ok: false, error: 'invalid_url' };
  }

  let artists;
  try {
    artists = await fetchUserFollowedArtists(userId);
  } catch (err) {
    if (err instanceof SpotifyAuthFailedError) {
      // eslint-disable-next-line no-console
      console.error(
        '[syncSpotifyFollows] BOT AUTH FAILED — re-paste SPOTIFY_BOT_SP_DC:',
        err,
      );
      return { ok: false, error: 'bot_auth_failed' };
    }
    if (err instanceof UserNotFoundError) {
      return { ok: false, error: 'private_profile' };
    }
    // Treat ScrapeFailedError + any other throw as transient.
    // eslint-disable-next-line no-console
    console.error('[syncSpotifyFollows] scrape failed:', err);
    return { ok: false, error: 'scrape_failed' };
  }

  // Replace-not-merge: clear the user's old Spotify-follow set, then
  // insert the freshly-fetched rows. Both writes go through RLS (the
  // user can only touch their own rows); the FK in migration 0023
  // cascades any orphan cleanup automatically.
  //
  // The `as never` casts on insert/update payloads are the same
  // @supabase/ssr 0.5.1 inference workaround used by saves.ts /
  // sync-soundcloud-follows.ts.
  try {
    const del = await supabase
      .from('user_spotify_follows')
      .delete()
      .eq('user_id', user.id);
    if (del.error) throw del.error;

    if (artists.length > 0) {
      const rows = artists.map((a) => ({
        user_id: user.id,
        spotify_artist_id: a.spotifyId,
        display_name: a.name,
        followed_at: a.followedAt,
      }));
      const ins = await supabase
        .from('user_spotify_follows')
        .insert(rows as never);
      if (ins.error) throw ins.error;
    }

    const upd = await supabase
      .from('user_prefs')
      .update({
        spotify_user_id: userId,
        spotify_last_synced_at: new Date().toISOString(),
      } as never)
      .eq('user_id', user.id);
    if (upd.error) throw upd.error;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[syncSpotifyFollows] db write failed:', err);
    return { ok: false, error: 'scrape_failed' };
  }

  // Bust the RSC caches that read user_spotify_follows or the sync
  // timestamp. The connect-card flow hard-refreshes after success so
  // most clients won't actually use these cached values, but server
  // actions should be honest about what they invalidate.
  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');

  return { ok: true, count: artists.length, userId };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Strip whitespace and the `open.spotify.com/user/` prefix from user
 * input; surface the canonical user ID.
 *
 * Accepts:
 *   - https://open.spotify.com/user/1249423375?si=e560b0ee7d8146f5
 *   - https://open.spotify.com/user/bjornblanchard
 *   - open.spotify.com/user/1249423375
 *   - spotify:user:1249423375
 *   - bare user IDs (numeric or alphanumeric)
 *
 * Returns null when nothing recognizable as a Spotify user ID can be
 * extracted. Does NOT validate the ID against SPOTIFY_USER_ID_RE —
 * that's the caller's job.
 *
 * NOT exported — Next.js forbids non-async exports from a 'use server'
 * module. If a future consumer needs this logic, copy it inline (the
 * smoke script does) or extract to a separate non-'use server' helper
 * file.
 */
function extractSpotifyUserId(raw: string): string | null {
  const trimmed = raw.trim();

  // 1. spotify:user:{id} URI form.
  const uriMatch = trimmed.match(/^spotify:user:([a-zA-Z0-9_.-]+)$/i);
  if (uriMatch) return uriMatch[1] ?? null;

  // 2. URL form — strip protocol, www., domain, leading slash, then
  //    split on path / query / fragment.
  const cleaned = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?open\.spotify\.com\//i, '')
    .replace(/^\/+/, '')
    .split(/[?#]/)[0]
    ?.split('/');
  if (!cleaned) return null;

  if (cleaned[0] === 'user' && cleaned[1]) {
    return cleaned[1];
  }

  // 3. Bare user ID fallthrough — accept anything that looks like a
  //    Spotify ID after our prefix-stripping. Friendly to users who
  //    paste just the ID without the URL.
  if (cleaned.length === 1 && cleaned[0] && /^[a-zA-Z0-9_.-]+$/.test(cleaned[0])) {
    return cleaned[0];
  }

  return null;
}
