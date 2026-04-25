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

/** Allowed values for the `default_when` column (migration 0014).
 *  Intentionally narrower than the URL-level DateFilter in filters.ts:
 *  'all' doesn't persist (it's the fallback) and 'tomorrow' is too
 *  transient to set as a default home window. */
export type DefaultWhen = 'weekend' | 'tonight' | 'week' | null;

export type UserPrefs = {
  preferred_genres: string[];
  preferred_vibes: string[];
  /** Phase 3.18 — selected event-context settings (warehouse, basement,
   *  daytime, peak-time, late-night, outdoor, underground). Distinct
   *  from preferred_vibes (artist-mood). Backed by user_prefs.preferred_setting
   *  added in migration 0019. */
  preferred_setting: string[];
  preferred_subgenres: string[];
  digest_email: boolean;
  default_when: DefaultWhen;
  notify_artist_drops: boolean;
  location_opt_in: boolean;
  calendar_opt_in: boolean;
  /** Null until the user finishes /onboarding. Set once by
   *  completeOnboarding in onboarding/actions.ts. Read by the
   *  middleware gate in Phase 5.6 / Task #6. */
  onboarding_completed_at: string | null;
};

/** Shape used when the viewer hasn't saved prefs yet, or is
 * signed out. Kept separate so callers can render the form
 * without branching on "row exists". */
export const DEFAULT_PREFS: UserPrefs = {
  preferred_genres: [],
  preferred_vibes: [],
  preferred_setting: [],
  preferred_subgenres: [],
  digest_email: false,
  default_when: null,
  notify_artist_drops: false,
  location_opt_in: false,
  calendar_opt_in: false,
  onboarding_completed_at: null,
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
    .select(
      'preferred_genres, preferred_vibes, preferred_setting, preferred_subgenres, digest_email, default_when, notify_artist_drops, location_opt_in, calendar_opt_in, onboarding_completed_at',
    )
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
    preferred_vibes: row.preferred_vibes ?? [],
    preferred_setting: row.preferred_setting ?? [],
    preferred_subgenres: row.preferred_subgenres ?? [],
    digest_email: !!row.digest_email,
    default_when:
      row.default_when === 'weekend' ||
      row.default_when === 'tonight' ||
      row.default_when === 'week'
        ? row.default_when
        : null,
    notify_artist_drops: !!row.notify_artist_drops,
    location_opt_in: !!row.location_opt_in,
    calendar_opt_in: !!row.calendar_opt_in,
    onboarding_completed_at: row.onboarding_completed_at ?? null,
  };
}
