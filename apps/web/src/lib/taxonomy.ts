// Taxonomy facade for the UI layer.
//
// The filter sheet and onboarding both need "give me the subgenres
// for a set of parent genres" logic. We keep this in one place so
// a future switch to DB-driven subgenres (read from
// `public.taxonomy_subgenres` via a server query) is a one-file
// change — all callers just consume the returned Map.
//
// Today the source is the curated `SUBGENRES_BY_PARENT` map in
// `lib/filters.ts`. That's pragmatic, not principled: every curated
// slug matches a real `artists.subgenres[]` string so overlap
// queries keep hitting rows. See the long comment in filters.ts
// for the curation rationale.

import {
  GENRE_OPTIONS,
  SUBGENRES_BY_PARENT,
  parentHasSubgenres,
  subgenresForParent,
  type FilterOption,
} from '@/lib/filters';

/** Canonical parent-genre list. Alias for GENRE_OPTIONS, exported
 * here so callers that don't care about the filter-URL shape can
 * stay on this taxonomy module. */
export function getParentGenres(): FilterOption[] {
  return GENRE_OPTIONS;
}

/**
 * Map from parent-genre slug → list of curated subgenre options.
 *
 * Returns a Map rather than a plain object so callers can use
 * `.get()` / `.has()` without tripping TS narrowing on index access.
 * Parents with no curated subgenres are still present in the map
 * with an empty array — the component layer uses `parentHasSubgenres`
 * to decide whether to render a sub-row.
 */
export function getSubgenresByParent(): Map<string, FilterOption[]> {
  const out = new Map<string, FilterOption[]>();
  for (const parent of GENRE_OPTIONS) {
    out.set(parent.slug, SUBGENRES_BY_PARENT[parent.slug] ?? []);
  }
  return out;
}

/** Subset of getSubgenresByParent filtered to the given parent list,
 * keyed the same way. Used by onboarding where we only want entries
 * the user has actually toggled a parent for. */
export function getSubgenresForSelectedParents(
  parentSlugs: readonly string[],
): Map<string, FilterOption[]> {
  const out = new Map<string, FilterOption[]>();
  for (const slug of parentSlugs) {
    if (parentHasSubgenres(slug)) {
      out.set(slug, subgenresForParent(slug));
    }
  }
  return out;
}
