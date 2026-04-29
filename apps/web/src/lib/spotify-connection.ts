// Phase 5.7 — read-side fetcher for the signed-in user's Spotify
// connection state.
//
// Mirrors lib/soundcloud-connection.ts (Phase 5.6.1) — kept narrow
// rather than folded into getUserPrefs() so the PreferencesForm
// doesn't have to know about Spotify columns. The Spotify connect
// card is the only consumer.
//
// RLS on user_prefs gates this to the signed-in user; anon viewers
// see `{ userId: null, lastSyncedAt: null }`. The connect card on
// /profile is itself behind a sign-in redirect, so anon shouldn't
// ever reach here in practice — defensive default included anyway.

import { createClient } from '@/lib/supabase/server';

export type SpotifyConnection = {
  /** Spotify user ID extracted from the user-pasted profile URL.
   *  Used both as the prefilled state in the connect card AND as
   *  the canonical "are we connected?" predicate. Numeric (legacy
   *  `1249423375`-style) or alphanumeric (newer `bjornblanchard`-
   *  style) — both are valid Spotify IDs. */
  userId: string | null;
  /** ISO timestamp of last successful sync, or null. Drives the
   *  "Last synced X ago" label and the lazy-invalidation threshold
   *  check (deferred — same shape as SC connection state). */
  lastSyncedAt: string | null;
};

const DISCONNECTED: SpotifyConnection = {
  userId: null,
  lastSyncedAt: null,
};

export async function getSpotifyConnection(): Promise<SpotifyConnection> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_prefs')
    .select('spotify_user_id, spotify_last_synced_at')
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[spotify-connection] getSpotifyConnection failed:', error.message);
    return DISCONNECTED;
  }
  if (!data) return DISCONNECTED;

  // Same @supabase/ssr 0.5.1 inference quirk as saves.ts /
  // soundcloud-connection.ts — generated row type resolves as
  // `never`-ish; cast via unknown to a minimal explicit shape.
  const row = data as unknown as {
    spotify_user_id: string | null;
    spotify_last_synced_at: string | null;
  };
  return {
    userId: row.spotify_user_id,
    lastSyncedAt: row.spotify_last_synced_at,
  };
}
