'use server';

// Server action for upserting user_prefs.
//
// One write path (upsert) for the whole form. The preferences form
// is small enough — genre/flavor checkbox grids + a single email
// toggle — that shipping a single "save all" action is cleaner
// than three narrow mutations, and it dodges the dance of
// inventing a partial-update API.
//
// RLS on user_prefs (owner-only per 0005_user_prefs.sql) means
// Postgres will reject any attempt to write a row whose user_id
// doesn't match auth.uid() — but we still gate here so unauth
// viewers get a useful signal rather than a silent RLS rejection.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { TablesInsert } from '@/lib/supabase/types';
import { GENRE_OPTIONS, VIBE_OPTIONS } from '@/lib/filters';

export type PrefsInput = {
  preferred_genres: string[];
  preferred_flavors: string[];
  digest_email: boolean;
};

type Result = { ok: true } | { ok: false; reason: 'unauth' | 'failed' };

// Allowed slug sets — derived from the curated filter lists so the
// form can't smuggle arbitrary strings into the database even if a
// client ships a crafted payload. RLS would allow anything of the
// right type; this is the validation step that ensures our
// "preferred" slugs stay inside the canonical vocabulary.
const GENRE_SLUGS = new Set(GENRE_OPTIONS.map((o) => o.slug));
const VIBE_SLUGS = new Set(VIBE_OPTIONS.map((o) => o.slug));

function sanitize(values: string[], allowed: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (slug && allowed.has(slug) && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/**
 * Save the viewer's preferences. Upserts by user_id so repeated
 * saves produce one stable row instead of a PK violation — the
 * first save creates the row, subsequent ones update in place.
 *
 * Unknown slugs in genres/flavors are dropped silently (see
 * `sanitize`). The trigger from 0001 bumps `updated_at`.
 */
export async function upsertUserPrefs(input: PrefsInput): Promise<Result> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, reason: 'unauth' };

  const cleanGenres = sanitize(input.preferred_genres ?? [], GENRE_SLUGS);
  const cleanFlavors = sanitize(input.preferred_flavors ?? [], VIBE_SLUGS);
  const digest = !!input.digest_email;

  // Same @supabase/ssr 0.5.1 type-inference dance as save-actions.ts:
  // the generated Insert type is correct, but the bundled inference
  // resolves it to `never`. Cast via `as never` so lint doesn't fire
  // on an unconfigured no-explicit-any rule.
  const row: TablesInsert<'user_prefs'> = {
    user_id: user.id,
    preferred_genres: cleanGenres,
    preferred_flavors: cleanFlavors,
    digest_email: digest,
  };

  const { error } = await supabase
    .from('user_prefs')
    .upsert(row as never, { onConflict: 'user_id' });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[prefs] upsertUserPrefs failed:', error.message);
    return { ok: false, reason: 'failed' };
  }

  // Prefs influence the home feed bias and the profile page's
  // current-selection display. Revalidating both keeps the rest
  // of the app in sync with what the user just saved.
  revalidatePath('/');
  revalidatePath('/profile');

  return { ok: true };
}
