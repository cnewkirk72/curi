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
   *  yet. The connect card uses this both as the prefilled input value
   *  AND as the canonical "are we connected?" predicate. */
  username: string | null;
  /** ISO timestamp of the last successful sync, or null. Drives the
   *  "Last synced X ago" label and the lazy-invalidation threshold
   *  check (deferred — see roadmap). */
  lastSyncedAt: string | null;
};

const DISCONNECTED: SoundcloudConnection = {
  username: null,
  lastSyncedAt: null,
};

export async function getSoundcloudConnection(): Promise<SoundcloudConnection> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_prefs')
    .select('soundcloud_username, soundcloud_last_synced_at')
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[sc-connection] getSoundcloudConnection failed:', error.message);
    return DISCONNECTED;
  }
  if (!data) return DISCONNECTED;

  // Same @supabase/ssr 0.5.1 inference quirk as saves.ts / preferences.ts —
  // generated row type resolves to `never`-ish; cast via unknown to a
  // minimal explicit shape.
  const row = data as unknown as {
    soundcloud_username: string | null;
    soundcloud_last_synced_at: string | null;
  };
  return {
    username: row.soundcloud_username,
    lastSyncedAt: row.soundcloud_last_synced_at,
  };
}
