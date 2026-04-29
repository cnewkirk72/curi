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

import { revalidatePath } from 'next/cache';
import {
  fetchUserFollowedArtists,
  SpotifyAuthFailedError,
  UserNotFoundError,
} from '@/lib/spotify-follows';
import { createClient } from '@/lib/supabase/server';

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

const SPOTIFY_USER_ID_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

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
    // eslint-disable-next-line no-console
    console.error('[syncSpotifyFollows] scrape failed:', err);
    return { ok: false, error: 'scrape_failed' };
  }

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

  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');

  return { ok: true, count: artists.length, userId };
}

/**
 * Strip whitespace and the `open.spotify.com/user/` prefix from user
 * input; surface the canonical user ID. Accepts URL/URI/bare-ID forms.
 */
export function extractSpotifyUserId(raw: string): string | null {
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

  if (cleaned[0] === 'user' && cleaned[1]) {
    return cleaned[1];
  }

  if (cleaned.length === 1 && cleaned[0] && /^[a-zA-Z0-9_.-]+$/.test(cleaned[0])) {
    return cleaned[0];
  }

  return null;
}
