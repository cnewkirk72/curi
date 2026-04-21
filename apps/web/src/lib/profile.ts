// Viewer profile fetcher. Server-only.
//
// Profiles are public-read (migration 0013 RLS), so a select here
// returns a row for any profile that exists — but callers on
// /profile typically scope to the signed-in user anyway. The
// handle_new_user trigger seeds a profile on auth.users insert,
// so by the time a signed-in user hits this page, their row
// always exists. A missing row here means something is genuinely
// broken (trigger failed, row deleted manually) — we return null
// and let the caller render a recoverable empty state.

import { createClient } from '@/lib/supabase/server';

export type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

/** Fetch the current viewer's profile. Returns null for signed-out
 * viewers (RLS filters them out) or when the row is missing. */
export async function getMyProfile(): Promise<Profile | null> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, created_at, updated_at')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[profile] getMyProfile failed:', error.message);
    return null;
  }
  if (!data) return null;

  // Same @supabase/ssr 0.5.1 type-inference dance as saves.ts —
  // cast via unknown to the explicit row shape.
  return data as unknown as Profile;
}

/** Fetch a profile by username (case-insensitive via citext).
 * Used by the future @mention lookup and friend search. */
export async function getProfileByUsername(
  username: string,
): Promise<Profile | null> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, created_at, updated_at')
    .eq('username', username)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[profile] getProfileByUsername failed:', error.message);
    return null;
  }
  if (!data) return null;
  return data as unknown as Profile;
}
