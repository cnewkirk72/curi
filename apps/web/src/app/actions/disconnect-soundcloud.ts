'use server';

// Phase 5.8 — server action backing the SoundcloudOAuthCard's
// "Disconnect" button.
//
// Scope: clears the OAuth token columns on user_prefs only. Does NOT
// touch soundcloud_username, soundcloud_last_synced_at, or
// user_soundcloud_follows — those belong to the legacy paste flow
// that remains visible side-by-side during this phase. If a user is
// connected via both flows and disconnects OAuth, their legacy card
// keeps showing "Connected as @username" with the existing scraped
// follow set.
//
// Mirrors disconnectSpotify (sync-spotify-follows.ts) in shape and
// error-code surface so the OAuth card's UX matches Spotify's.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: 'unauth' | 'db_failed' };

export async function disconnectSoundcloud(): Promise<DisconnectResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauth' };

  try {
    const { error } = await supabase
      .from('user_prefs')
      .update({
        soundcloud_access_token: null,
        soundcloud_refresh_token: null,
        soundcloud_token_expires_at: null,
      } as never)
      .eq('user_id', user.id);
    if (error) throw error;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[disconnectSoundcloud] db write failed:', err);
    return { ok: false, error: 'db_failed' };
  }

  // The home + saved feeds don't read OAuth tokens directly, so they
  // don't strictly need invalidation — but revalidating /profile
  // ensures the OAuth card re-renders in its disconnected state on
  // the next navigation.
  revalidatePath('/profile');

  return { ok: true };
}
