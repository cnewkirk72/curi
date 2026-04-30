// Phase 5.7.1 — read-side fetcher for the signed-in user's Spotify
// connection state.
//
// Returns: spotify_user_id (legacy URL-paste flow), last sync
// timestamp, AND a boolean indicating whether the user has any
// user_spotify_follows rows (the canonical "connected via WKWebView?"
// signal since the new flow doesn't capture spotify_user_id).
//
// RLS on user_prefs + user_spotify_follows gates this to the signed-
// in user; anon viewers see `{ userId: null, lastSyncedAt: null,
// hasFollows: false }`. The connect card on /profile is itself behind
// a sign-in redirect, so anon shouldn't reach here in practice.

import { createClient } from '@/lib/supabase/server';

export type SpotifyConnection = {
  /** Spotify user ID from the legacy URL-paste flow. May be null even
   *  when connected via WKWebView (that flow doesn't capture this). */
  userId: string | null;
  /** ISO timestamp of last successful sync, or null. */
  lastSyncedAt: string | null;
  /** Whether the user has any user_spotify_follows rows — canonical
   *  connected-state predicate for the WKWebView flow. */
  hasFollows: boolean;
};

const DISCONNECTED: SpotifyConnection = {
  userId: null,
  lastSyncedAt: null,
  hasFollows: false,
};

export async function getSpotifyConnection(): Promise<SpotifyConnection> {
  const supabase = createClient();

  const [prefsResult, followsResult] = await Promise.all([
    supabase
      .from('user_prefs')
      .select('spotify_user_id, spotify_last_synced_at')
      .maybeSingle(),
    supabase
      .from('user_spotify_follows')
      .select('spotify_artist_id', { count: 'exact', head: true }),
  ]);

  if (prefsResult.error) {
    // eslint-disable-next-line no-console
    console.error(
      '[spotify-connection] getSpotifyConnection prefs failed:',
      prefsResult.error.message,
    );
    return DISCONNECTED;
  }

  // followsResult.error is non-fatal — if the count fails we just
  // treat as no follows. The user can always retry the connect flow.
  const hasFollows =
    !followsResult.error && (followsResult.count ?? 0) > 0;

  if (!prefsResult.data) {
    return { userId: null, lastSyncedAt: null, hasFollows };
  }

  // Same @supabase/ssr 0.5.1 inference quirk as elsewhere; cast via
  // unknown to a minimal explicit shape.
  const row = prefsResult.data as unknown as {
    spotify_user_id: string | null;
    spotify_last_synced_at: string | null;
  };

  return {
    userId: row.spotify_user_id,
    lastSyncedAt: row.spotify_last_synced_at,
    hasFollows,
  };
}
