'use server';

// Phase 5.7.1 — server action backing the iOS WKWebView Spotify
// connect flow.
//
// Replaces the Phase 5.7 URL-paste / pathfinder-scrape implementation.
// The native iOS plugin (SpotifyConnectPlugin) opens a webview, the
// injected script captures the user's followed-artists from the
// /user-profile-view/v3/profile/{userId}/following endpoint, returns
// the URI list to JS via Capacitor's bridge, and the JS calls this
// action. We validate format, intersect with the artists table
// (informational), and replace-not-merge into user_spotify_follows.
//
// Trust boundary: IDs come from a user-controlled device session.
// Worst-case spoofing is "user lies about who they follow on Spotify,
// their own feed ranks accordingly." No cross-user impact, no
// escalation, no exfiltration. Format validation guards the DB write
// against injection-style attacks.
//
// Bot-account modules (@/lib/spotify-follows) are dormant in this
// flow — see phase-5.7.1-wkwebview-spotify-spec.md § 8.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type SyncResult =
  | {
      ok: true;
      /** Number of valid IDs written. */
      count: number;
      /** How many of those IDs match a Curi-known artist (Phase 4
       *  enrichment). Drives the success-toast copy: "N artists
       *  imported, M of whom play in NYC." */
      matchedArtists: number;
    }
  | {
      ok: false;
      error: 'unauth' | 'invalid_payload' | 'db_failed';
    };

// Spotify artist IDs are 22-char base62 strings (e.g.
// "06HL4z0CvFAxyc27GXpf02"). Anything else is rejected.
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

// Defensive caps. A real user has typically 50–1000 follows; 10k is
// 10x Spotify's soft cap, so anything above that is automation /
// malformed input.
const MAX_IDS_PER_SYNC = 10_000;

/**
 * Sync the signed-in Curi user's Spotify follow graph from a list of
 * artist IDs captured by the iOS WKWebView plugin (or future browser
 * extension).
 *
 * Replace-not-merge semantics: clears the user's existing
 * user_spotify_follows rows, inserts the new set. Same contract as
 * Phase 5.6 SoundCloud sync.
 */
export async function syncSpotifyFollows(
  ids: string[],
): Promise<SyncResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauth' };

  // Validate input shape defensively. The native bridge already
  // filters by the same regex, but server-side is the trust boundary.
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_IDS_PER_SYNC
  ) {
    return { ok: false, error: 'invalid_payload' };
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && SPOTIFY_ID_RE.test(id)) {
      seen.add(id);
    }
  }
  const validIds = Array.from(seen);
  if (validIds.length === 0) {
    return { ok: false, error: 'invalid_payload' };
  }

  let matchedArtists = 0;
  try {
    // Replace-not-merge. Same contract as Phase 5.6 SC sync.
    const del = await supabase
      .from('user_spotify_follows')
      .delete()
      .eq('user_id', user.id);
    if (del.error) throw del.error;

    const rows = validIds.map((id) => ({
      user_id: user.id,
      spotify_artist_id: id,
    }));
    const ins = await supabase
      .from('user_spotify_follows')
      .insert(rows as never);
    if (ins.error) throw ins.error;

    // Stamp the sync timestamp. user_prefs.spotify_user_id stays null
    // in this flow — we don't capture the Spotify user ID from the
    // /following payload, only the artist IDs. The column is kept on
    // the schema for forward-compat with future profile-display
    // features.
    const upd = await supabase
      .from('user_prefs')
      .update({
        spotify_last_synced_at: new Date().toISOString(),
      } as never)
      .eq('user_id', user.id);
    if (upd.error) throw upd.error;

    // Count matches against Curi-known artists. Informational only —
    // even unmatched follows are stored, since artists.spotify_id
    // backfill is rolling and a "no match today" might match next week.
    const { count } = await supabase
      .from('artists')
      .select('id', { count: 'exact', head: true })
      .in('spotify_id', validIds);
    matchedArtists = count ?? 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[syncSpotifyFollows] db write failed:', err);
    return { ok: false, error: 'db_failed' };
  }

  // Bust the RSC caches that read user_spotify_follows.
  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');

  return {
    ok: true,
    count: validIds.length,
    matchedArtists,
  };
}

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: 'unauth' | 'db_failed' };

/**
 * Disconnect Spotify: delete every user_spotify_follows row for the
 * signed-in user and clear the sync timestamp. Used by the "Disconnect"
 * button on the profile connect card.
 */
export async function disconnectSpotify(): Promise<DisconnectResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauth' };

  try {
    const del = await supabase
      .from('user_spotify_follows')
      .delete()
      .eq('user_id', user.id);
    if (del.error) throw del.error;

    const upd = await supabase
      .from('user_prefs')
      .update({
        spotify_user_id: null,
        spotify_last_synced_at: null,
      } as never)
      .eq('user_id', user.id);
    if (upd.error) throw upd.error;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[disconnectSpotify] db write failed:', err);
    return { ok: false, error: 'db_failed' };
  }

  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');

  return { ok: true };
}
