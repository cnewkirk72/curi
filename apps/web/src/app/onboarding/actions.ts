'use server';

// Server actions for the /onboarding flow.
//
// Every step advance calls the matching save* action to persist
// progress incrementally — the user can bail at any point and
// their taste data survives to the next session. The flow closer
// (`completeOnboarding`) stamps user_prefs.onboarding_completed_at
// and is what the middleware gate in Task #6 reads to decide
// whether to bounce back to /onboarding.
//
// RLS on user_prefs (owner-only per 0005) rejects cross-user writes
// automatically. We still gate for `unauth` here so signed-out
// callers get a useful result instead of a silent RLS rejection,
// and so the client can tell the difference between "sign in first"
// and "something blew up server-side".
//
// Slug validation mirrors preferences-actions.ts: unknown values
// are dropped silently via a `sanitize()` pass. This matters because
// we don't trust the client not to have added arbitrary strings to
// its local draft — the URL-serialized filter layer is permissive,
// but the persistent taste vocabulary is strict.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { TablesInsert } from '@/lib/supabase/types';
import {
  ALL_SUBGENRE_SLUGS,
  GENRE_OPTIONS,
  VIBE_OPTIONS,
} from '@/lib/filters';

// ── Allowlists ───────────────────────────────────────────────────

const GENRE_SLUGS = new Set(GENRE_OPTIONS.map((o) => o.slug));
const VIBE_SLUGS = new Set(VIBE_OPTIONS.map((o) => o.slug));
const SUBGENRE_SLUGS = new Set(ALL_SUBGENRE_SLUGS);
const DEFAULT_WHEN_VALUES = new Set(['weekend', 'tonight', 'week'] as const);

type Result = { ok: true } | { ok: false; reason: 'unauth' | 'failed' };

function sanitize(values: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    // Subgenre slugs contain spaces / hyphens verbatim (see the
    // curation note in filters.ts), so we trim but don't lowercase
    // — the allowlist key is the exact string from SUBGENRES_BY_PARENT.
    const slug = typeof raw === 'string' ? raw.trim() : '';
    if (slug && allowed.has(slug) && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

// ── Core upsert helper ─────────────────────────────────────────────
//
// Each step-level action ends up calling this with a partial patch.
// Using a single upsert path (rather than per-field UPDATEs) gives us
// first-write row creation for free — the first step's save creates
// the user_prefs row, subsequent steps UPDATE in place.

async function upsertPrefs(
  patch: Partial<TablesInsert<'user_prefs'>>,
): Promise<Result> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauth' };

  const row = { user_id: user.id, ...patch } as TablesInsert<'user_prefs'>;

  const { error } = await supabase
    .from('user_prefs')
    .upsert(row as never, { onConflict: 'user_id' });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[onboarding] upsert failed:', error.message);
    return { ok: false, reason: 'failed' };
  }

  return { ok: true };
}

// ── Step actions ─────────────────────────────────────────────────────

/** Step 3 — genres. Valid slugs persisted; unknowns dropped. */
export async function saveOnboardingGenres(genres: string[]): Promise<Result> {
  return upsertPrefs({
    preferred_genres: sanitize(genres, GENRE_SLUGS),
  });
}

/** Step 3 (inline) — subgenres under the currently-selected parents. */
export async function saveOnboardingSubgenres(
  subgenres: string[],
): Promise<Result> {
  return upsertPrefs({
    preferred_subgenres: sanitize(subgenres, SUBGENRE_SLUGS),
  });
}

/** Step 4 — vibes. */
export async function saveOnboardingVibes(vibes: string[]): Promise<Result> {
  return upsertPrefs({
    preferred_vibes: sanitize(vibes, VIBE_SLUGS),
  });
}

/** Step 5 — default window + three consent flags. The client sends
 * all four in one call so the back-and-forth is a single round-trip. */
export async function saveOnboardingWhen(input: {
  default_when: 'weekend' | 'tonight' | 'week' | null;
  notify_artist_drops: boolean;
  location_opt_in: boolean;
  calendar_opt_in: boolean;
}): Promise<Result> {
  const when =
    input.default_when && DEFAULT_WHEN_VALUES.has(input.default_when)
      ? input.default_when
      : null;
  return upsertPrefs({
    default_when: when,
    notify_artist_drops: !!input.notify_artist_drops,
    location_opt_in: !!input.location_opt_in,
    calendar_opt_in: !!input.calendar_opt_in,
  });
}

/**
 * Final step — stamp onboarding_completed_at = now. This is what the
 * middleware gate reads to decide "already onboarded → don't bounce".
 * We also revalidate `/events` and `/profile` here since the feed
 * biases off preferred_genres/subgenres/vibes and the profile page
 * renders the saved lists. `/` is revalidated for good measure in
 * case the root redirects into the feed.
 */
export async function completeOnboarding(): Promise<Result> {
  const result = await upsertPrefs({
    onboarding_completed_at: new Date().toISOString(),
  });
  if (result.ok) {
    revalidatePath('/');
    revalidatePath('/events');
    revalidatePath('/profile');
  }
  return result;
}
