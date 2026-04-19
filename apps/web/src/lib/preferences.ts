// Viewer preference fetcher. Server-only.
//
// Mirrors the saves.ts pattern: RLS on user_prefs is owner-only
// (migration 0005), so a select here silently returns [] for
// signed-out viewers and a single row for the owner.
//
// There's at most one row per user, and the row is created lazily
// on first write (see preferences-actions.ts) — so a missing row
// is the normal "hasn't configured yet" state, not an error. We
// paper over that by returning DEFAULT_PREFS whenever the select
// comes back empty.

import { createClient } from '@/lib/supabase/server';

export type UserPrefs = {
  preferred_genres: string[];
  preferred_flavors: string[];
  digest_email: boolean;
};

/** Shape used when the viewer hasn't saved prefs yet, or is
 * signed out. Kept separate so callers can render the form
 * without branching on "row exists". */
export const DEFAULT_PREFS: UserPrefs = {
  preferred_genres: [],
  preferred_flavors: [],
  digest_email: false,
};

/**
 * Fetch the viewer's preferences, falling back to DEFAULT_PREFS
 * when no row exists yet (first visit to /profile before any
 * toggles have been persisted).
 *
 * Returns DEFAULT_PREFS for unauthenticated viewers — RLS filters
 * them out before we'd see the row. Callers that care about auth
 * should check the session separately (same pattern as saves.ts).
 */
export async function getUserPrefs(): Promise<UserPrefs> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_prefs')
    .select('preferred_genres, preferred_flavors, digest_email')
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[prefs] getUserPrefs failed:', error.message);
    return DEFAULT_PREFS;
  }

  if (!data) return DEFAULT_PREFS;

  // Same @supabase/ssr 0.5.1 inference quirk as saves.ts: `data`
  // comes back as `never`-ish despite the generated Database type
  // being correct. Cast via unknown to the explicit row shape.
  const row = data as unknown as UserPrefs;
  return {
    preferred_genres: row.preferred_genres ?? [],
    preferred_flavors: row.preferred_flavors ?? [],
    digest_email: !!row.digest_email,
  };
}
