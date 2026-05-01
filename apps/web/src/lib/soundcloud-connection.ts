// Phase 5.6.1 — read-side fetcher for the signed-in user's SoundCloud
// connection state.
//
// Kept small + separate from `lib/preferences.ts` rather than folded into
// the existing `getUserPrefs()` because:
//   - PreferencesForm is unaware of these fields and spreading a wider
//     UserPrefs into its draft state would force a typecheck refactor
//     across upsertUserPrefs + the form.
//   - The connect card is the only consumer; the dedicated function
//     mirrors the lib/follows.ts pattern from PR #4 and keeps each
//     server-side fetcher narrowly scoped.
//
// RLS on user_prefs gates this to the signed-in user; anon viewers see
// `{ username: null, lastSyncedAt: null }`. The connect card on /profile
// is itself behind a sign-in redirect, so anon shouldn't ever reach
// here in practice — defensive default included anyway.

import { createClient } from '@/lib/supabase/server';

export type SoundcloudConnection = {
  /** Lowercased SC profile slug, or null when the user hasn't connected
   *  yet. Populated either by the legacy paste flow OR by the Phase 5.8
   *  OAuth callback (from SC's /me response). The connect card uses this
   *  as the display handle ("Connected as @username"). */
  username: string | null;
  /** ISO timestamp of the last successful follows-sync, or null. Drives
   *  the connected card's "Last synced X ago" label. Set by either the
   *  legacy paste sync OR the Phase 5.9 OAuth sync. */
  lastSyncedAt: string | null;
  /** True iff the user has completed the Phase 5.8 OAuth flow and an
   *  access token is currently persisted. Drives the OAuth card's
   *  connected/disconnected state. Independent of `username` — a user
   *  could legacy-paste their handle without an OAuth token, OR have an
   *  OAuth token without a populated username (transient — the callback
   *  always writes both, but disconnect leaves username intact). */
  oauthConnected: boolean;
  /** Phase 5.9 — number of rows in user_soundcloud_follows for this
   *  user. Surfaced in the connected card as "247 artists" so the user
   *  has feedback that the integration is alive. Reads as 0 if no
   *  rows exist (either because they've never synced or because they
   *  follow no artists on SC). */
  followsCount: number;
};

const DISCONNECTED: SoundcloudConnection = {
  username: null,
  lastSyncedAt: null,
  oauthConnected: false,
  followsCount: 0,
};

export async function getSoundcloudConnection(): Promise<SoundcloudConnection> {
  const supabase = createClient();

  // Two parallel reads — the user_prefs row and the follows count.
  // Both are tiny and indexed; the round-trip win from doing them
  // concurrently outweighs the negligible overhead.
  const [prefsRes, countRes] = await Promise.all([
    supabase
      .from('user_prefs')
      .select(
        'soundcloud_username, soundcloud_last_synced_at, soundcloud_access_token',
      )
      .maybeSingle(),
    supabase
      .from('user_soundcloud_follows')
      .select('soundcloud_username', { count: 'exact', head: true }),
  ]);

  if (prefsRes.error) {
    // eslint-disable-next-line no-console
    console.error(
      '[sc-connection] getSoundcloudConnection failed:',
      prefsRes.error.message,
    );
    return DISCONNECTED;
  }
  if (!prefsRes.data) return DISCONNECTED;

  // Same @supabase/ssr 0.5.1 inference quirk as saves.ts / preferences.ts —
  // generated row type resolves to `never`-ish; cast via unknown to a
  // minimal explicit shape.
  const row = prefsRes.data as unknown as {
    soundcloud_username: string | null;
    soundcloud_last_synced_at: string | null;
    soundcloud_access_token: string | null;
  };

  // The count query may fail (e.g. transient Supabase error); fall
  // back to 0 rather than failing the whole connection read. UI
  // shows "Connected as @user" without the count in that case.
  const followsCount = countRes.error ? 0 : (countRes.count ?? 0);

  return {
    username: row.soundcloud_username,
    lastSyncedAt: row.soundcloud_last_synced_at,
    oauthConnected: !!row.soundcloud_access_token,
    followsCount,
  };
}
