'use server';

// Phase 5.9 — OAuth-driven SoundCloud follow-graph sync.
//
// Walks `/me/followings` using the user's stored access token (auto-
// refreshed if near-expiry), then replaces the user's
// user_soundcloud_follows rows with the freshly-fetched set. Stamps
// soundcloud_last_synced_at on success.
//
// Replace-not-merge: same semantic as the legacy syncSoundcloudFollows
// (Phase 5.6) and syncSpotifyFollows (Phase 5.7.1). SC has no "follows
// changed since X" diff API, so a clean replace is the only correct
// way to propagate unfollows from the user's SC account into Curi.
//
// Trigger surfaces:
//   - SoundcloudOAuthCard's onMount effect when ?sc_connected=1 is
//     present (initial post-connect sync)
//   - The card's Refresh button (manual re-sync)
//
// Returns shape mirrors syncSpotifyFollows so the card's UI patterns
// (count + matchedArtists toast) line up.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import {
  fetchUserFollowings,
  SoundcloudNotConnectedError,
  SoundcloudReauthRequiredError,
  withFreshToken,
} from '@/lib/soundcloud/api';

export type SyncResult =
  | {
      ok: true;
      /** Number of valid (permalink-bearing) follows imported. */
      count: number;
      /** Of `count`, how many match a Curi-known artist on
       *  `artists.soundcloud_username`. Drives the toast copy:
       *  "Imported N artists, M of whom play in NYC." */
      matchedArtists: number;
    }
  | {
      ok: false;
      error: 'unauth' | 'not_connected' | 'reauth_required' | 'fetch_failed' | 'db_failed';
    };

export async function syncSoundcloudFollowsOAuth(): Promise<SyncResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauth' };

  // Fetch the user's followings using a fresh access token. The
  // wrapper handles the refresh-if-near-expiry dance and persists
  // any rotated refresh_token before the call.
  let follows;
  try {
    follows = await withFreshToken((token) => fetchUserFollowings(token));
  } catch (err) {
    if (err instanceof SoundcloudNotConnectedError) {
      return { ok: false, error: 'not_connected' };
    }
    if (err instanceof SoundcloudReauthRequiredError) {
      // Refresh token revoked. Null out the stored tokens so the
      // card flips back to the disconnected (or legacy if username
      // is still set) state on next render.
      await supabase
        .from('user_prefs')
        .update({
          soundcloud_access_token: null,
          soundcloud_refresh_token: null,
          soundcloud_token_expires_at: null,
        } as never)
        .eq('user_id', user.id);
      return { ok: false, error: 'reauth_required' };
    }
    // eslint-disable-next-line no-console
    console.error('[syncSoundcloudFollowsOAuth] fetch failed:', err);
    return { ok: false, error: 'fetch_failed' };
  }

  // Replace-not-merge the rows. Same shape as the legacy paste-flow
  // writes so downstream readers (lib/follows.ts, lib/enrichment.ts)
  // don't know or care which source populated them.
  let matchedArtists = 0;
  try {
    const del = await supabase
      .from('user_soundcloud_follows')
      .delete()
      .eq('user_id', user.id);
    if (del.error) throw del.error;

    if (follows.length > 0) {
      const rows = follows.map((f) => ({
        user_id: user.id,
        soundcloud_username: f.permalink,
        display_name: f.username,
        followed_at: f.followedAt,
      }));
      const ins = await supabase
        .from('user_soundcloud_follows')
        .insert(rows as never);
      if (ins.error) throw ins.error;
    }

    // Stamp the sync timestamp. soundcloud_username is left untouched —
    // it was set by the OAuth callback's /me lookup and shouldn't drift.
    const upd = await supabase
      .from('user_prefs')
      .update({
        soundcloud_last_synced_at: new Date().toISOString(),
      } as never)
      .eq('user_id', user.id);
    if (upd.error) throw upd.error;

    // Count matches against Curi-known artists. Informational only —
    // unmatched follows are still stored, since artists.soundcloud_username
    // backfill is rolling and a "no match today" might match next week.
    if (follows.length > 0) {
      const slugs = follows.map((f) => f.permalink);
      const { count } = await supabase
        .from('artists')
        .select('id', { count: 'exact', head: true })
        .in('soundcloud_username', slugs);
      matchedArtists = count ?? 0;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[syncSoundcloudFollowsOAuth] db write failed:', err);
    return { ok: false, error: 'db_failed' };
  }

  // The home + saved feeds read user_soundcloud_follows for the
  // follow-boost. Bust their RSC caches so the next navigation re-
  // ranks events with the new follow set. /profile re-renders the
  // card with the updated count.
  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');

  return {
    ok: true,
    count: follows.length,
    matchedArtists,
  };
}
