// Phase 3.18 — genre-slug normalization at every ingestion write boundary.
//
// Migration 0018 cleaned the existing data (dropped junk, renamed typos,
// moved wrong-granularity slugs to subgenres). Without an equivalent
// guard at write time, the next nightly scrape + LLM enrichment run
// would slowly reintroduce the same problems — MusicBrainz keeps
// returning country-code tags, the LLM occasionally hallucinates
// label names like 'brainfeeder', and Spotify genre strings include
// non-canonical spellings.
//
// This module is the single source of truth for that cleanup. Same
// rules as migration 0018, applied as a pure function so it can be
// called from:
//
//   - llm-enrichment.ts → normalize LLM output before the row write
//   - events-reaggregate.ts → normalize the rollup output before
//     comparing against stored events.genres
//   - any future ingestion path that produces genre arrays
//
// If the rules ever drift between SQL and TS, the SQL is authoritative
// for retroactive cleanup, but this TS module is authoritative for
// new data — it runs on every write, the migration only ran once.

/**
 * Junk slugs — strings ingested as "genres" that aren't actually
 * music genres at all. Descriptors, country codes, identity tags,
 * label names, platform names, single-occurrence noise. These are
 * dropped silently (no replacement).
 */
const JUNK_SLUGS = new Set<string>([
  'rave',
  'disc-jockeys',
  'queer',
  'film',
  'poetry',
  'ramp',
  'spoken-word',
  'wonky',
  'albums',
  'alliteration',
  'beats',
  'brainfeeder',
  'actor',
  'tiktok',
  'transgender',
  'tribute',
]);

/**
 * Rename map — known typos and country tags that map cleanly to a
 * canonical slug already in the vocabulary. Both old and new live in
 * the same `genres` namespace; no parent/child semantics change.
 */
const RENAMES: Record<string, string> = {
  synthpop: 'synth-pop',
  electrnica: 'electronic',
  ghettotech: 'ghetto-tech',
  'noise-rock': 'noise',
  arab: 'world',
  tunisia: 'world',
  tunisian: 'world',
};

/**
 * Move-to-subgenre map — strings that ARE real music terms but were
 * ingested at the wrong granularity (parent-genre slot when they're
 * actually subgenres). For each: replace with its canonical parent
 * in `genres`, and surface the renamed subgenre on the side so the
 * caller can add it to artists.subgenres.
 */
const PROMOTIONS: Record<string, { parent: string; subgenre: string }> = {
  hardcore: { parent: 'techno', subgenre: 'hardcore-techno' },
  hardgroove: { parent: 'techno', subgenre: 'hardgroove techno' },
  industrial: { parent: 'techno', subgenre: 'industrial' },
  psychedelic: { parent: 'rock', subgenre: 'psychedelic-rock' },
};

export interface NormalizedGenres {
  /** Cleaned parent genres — junk dropped, typos renamed, wrong-
   *  granularity items promoted to their canonical parent. */
  genres: string[];
  /** Subgenres surfaced by the move-to-subgenre rule. Caller decides
   *  whether to merge these into artists.subgenres (LLM enrichment
   *  does; events.genres doesn't have a subgenre column). Empty when
   *  no input slugs triggered a promotion. */
  subgenresAdded: string[];
}

/**
 * Normalize an array of genre slugs.
 *
 *   ['industrial', 'rave', 'TECHNO', 'electrnica', 'techno']
 *   → { genres: ['techno', 'electronic'], subgenresAdded: ['industrial'] }
 *
 * Behavior:
 *   - Trims and lowercases. Empty strings dropped.
 *   - JUNK slugs dropped silently.
 *   - RENAMES applied in place.
 *   - PROMOTIONS replace input with parent and add subgenre to the
 *     side channel.
 *   - Output is deduped. Order preserved relative to input where
 *     possible (Set insertion order = first-seen).
 *
 * Pure — no I/O, no globals, safe to call repeatedly. Idempotent:
 * `normalizeGenres(normalizeGenres(x).genres).genres` deep-equals
 * `normalizeGenres(x).genres`.
 */
export function normalizeGenres(input: readonly string[]): NormalizedGenres {
  const out = new Set<string>();
  const subgenresAdded = new Set<string>();

  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const slug = raw.trim().toLowerCase();
    if (!slug) continue;

    if (JUNK_SLUGS.has(slug)) continue;

    const renamed = RENAMES[slug];
    if (renamed !== undefined) {
      out.add(renamed);
      continue;
    }

    const promo = PROMOTIONS[slug];
    if (promo !== undefined) {
      out.add(promo.parent);
      subgenresAdded.add(promo.subgenre);
      continue;
    }

    out.add(slug);
  }

  return {
    genres: [...out],
    subgenresAdded: [...subgenresAdded],
  };
}

/**
 * Convenience wrapper — returns just the cleaned genres without the
 * subgenre side-channel. Use when the caller has nowhere to put
 * promoted subgenres (e.g. events.genres write path; events don't
 * carry subgenres directly).
 */
export function normalizeGenresOnly(input: readonly string[]): string[] {
  return normalizeGenres(input).genres;
}

/**
 * Test predicate — does this slug currently get rejected/rewritten
 * by the normalizer? Used by tests + ingestion-time observability
 * (logging when a tag we'd reject was seen). Doesn't expose the
 * internal sets to keep them encapsulated.
 */
export function isNormalizedSlug(slug: string): boolean {
  const s = slug.trim().toLowerCase();
  return (
    !JUNK_SLUGS.has(s) &&
    RENAMES[s] === undefined &&
    PROMOTIONS[s] === undefined
  );
}
