// Smart-genre inference.
//
// For each raw MusicBrainz tag we resolve it to one of five outcomes:
//
//   1. Direct hit in taxonomy_map        → use its genres[]/flavors[]
//   2. Direct hit in taxonomy_subgenres  → use its stored genres[]/flavors[]
//   3. Similarity match to taxonomy_map  → insert new taxonomy_subgenres row
//      under that parent (above confidence floor), inherit parent's genres[]/flavors[]
//   4. No close parent, tag looks genre-like → auto-create new taxonomy_map
//      row (top-level parent) with the tag itself as the genre. Next similar
//      tag ("cuban bolero" after "bolero") will then match as subgenre at #3.
//   5. Tag is junk/metadata (blocklist)  → append to unmapped_artists.log, skipped
//
// Similarity = Jaccard on normalized word tokens. It's deterministic, dependency-free,
// and surprisingly good for short genre strings like "liquid dnb" vs "liquid funk".
// Upgrade to embeddings later if Jaccard misses too much.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from './supabase.js';

const CONFIDENCE_FLOOR = 0.3; // minimum Jaccard score to auto-create a subgenre

const __filename = fileURLToPath(import.meta.url);
const UNMAPPED_LOG = path.resolve(__filename, '../../unmapped_artists.log');

// ── normalization + similarity ────────────────────────────────────────────────

const SYNONYMS: Record<string, string> = {
  '&': 'and',
  dnb: 'drum and bass',
  'd&b': 'drum and bass',
  idm: 'intelligent dance music',
  edm: 'electronic',
};

function tokenize(tag: string): string[] {
  const lower = tag.toLowerCase().trim();
  const expanded = SYNONYMS[lower] ?? lower;
  return expanded
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1); // drop single-letter fragments
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── table snapshots (per-run cache, loaded once per process) ─────────────────

interface TaxMapRow {
  id: string;
  input_tag: string;
  genres: string[];
  flavors: string[];
}

interface TaxSubRow {
  id: string;
  input_tag: string;
  parent_tag_id: string;
  genres: string[];
  flavors: string[];
  confidence: number;
}

let cache: {
  map: TaxMapRow[];
  mapByTag: Map<string, TaxMapRow>;
  subgenreByTag: Map<string, TaxSubRow>;
} | null = null;

async function loadCache(): Promise<NonNullable<typeof cache>> {
  if (cache) return cache;
  const client = supabase();
  const [mapRes, subRes] = await Promise.all([
    client.from('taxonomy_map').select('id, input_tag, genres, flavors'),
    client
      .from('taxonomy_subgenres')
      .select('id, input_tag, parent_tag_id, genres, flavors, confidence'),
  ]);
  if (mapRes.error) throw mapRes.error;
  if (subRes.error) throw subRes.error;

  const map = mapRes.data ?? [];
  const mapByTag = new Map<string, TaxMapRow>();
  for (const row of map) mapByTag.set(row.input_tag.toLowerCase(), row);

  const subgenreByTag = new Map<string, TaxSubRow>();
  for (const row of subRes.data ?? []) {
    subgenreByTag.set(row.input_tag.toLowerCase(), row);
  }

  cache = { map, mapByTag, subgenreByTag };
  return cache;
}

/** Clear the in-memory cache. Exposed for tests; not needed in normal runs. */
export function _resetTaxonomyCache(): void {
  cache = null;
}

// ── resolution ───────────────────────────────────────────────────────────────────

export type TagSource =
  | 'taxonomy_map'
  | 'taxonomy_subgenre'
  | 'auto_created'
  | 'unmapped';

export interface ResolvedTag {
  inputTag: string;
  source: TagSource;
  genres: string[];
  flavors: string[];
  confidence: number; // 1.0 for direct hits
  weight: number; // from MB tag count
}

export interface EnrichmentAggregate {
  genres: string[];
  flavors: string[];
  subgenres: string[];
  resolved: ResolvedTag[];
}

async function logUnmapped(line: string): Promise<void> {
  try {
    await fs.appendFile(UNMAPPED_LOG, line + '\n', 'utf8');
  } catch {
    // swallow; logging is best-effort
  }
}

// MB returns a mess of metadata-style tags mixed in with real genres. Reject
// anything that clearly isn't a music style before seeding it into the
// taxonomy. Samples from real MB responses: "seen live", "american",
// "british", "death by drug overdose", "personal: a favorite of mine",
// "male", "female", years like "2019", "rip", etc.
const JUNK_TAG_PATTERN = new RegExp(
  [
    '\\b(seen live|live|american|british|english|irish|german|french|japanese|canadian|australian|italian|spanish|mexican|brazilian)\\b',
    '\\b(male|female|group|band|duo|solo|ensemble|singer|guitarist|producer|composer|rapper|drummer|vocalist|songwriter)\\b',
    '\\b(deceased|dead|alive|rip|died|died young|born|death by|suicide|overdose)\\b',
    '\\b(favorite|favourite|personal|mine|great|best|awesome|bad|love|hate)\\b',
    '\\b(recorded|released|album|single|ep|lp|record)\\b',
    '\\b(family|sibling|brother|sister|husband|wife|father|mother)\\b',
  ].join('|'),
  'i',
);

const YEAR_PATTERN = /^(19|20)\d{2}s?$/;
const MAX_TAG_LEN = 60;
const MIN_TAG_LEN = 3;

function isGenreLike(rawTag: string): boolean {
  const t = rawTag.toLowerCase().trim();
  if (t.length < MIN_TAG_LEN || t.length > MAX_TAG_LEN) return false;
  if (!/[a-z]/.test(t)) return false;
  if (YEAR_PATTERN.test(t)) return false;
  if (JUNK_TAG_PATTERN.test(t)) return false;
  // Tokens should be mostly word-like. "1990s house" is fine; "a :) b" is not.
  const tokens = tokenize(rawTag);
  if (tokens.length === 0) return false;
  return true;
}

// Convert a raw MB tag into a slug-friendly genre name to use as its mapping.
// "Hip Hop" → "hip-hop". "Drum & Bass" → "drum-and-bass". Matches how existing
// seeded genres are stored (lowercase, hyphen-separated).
function tagToGenreSlug(rawTag: string): string {
  const lower = rawTag.toLowerCase().trim();
  const expanded = SYNONYMS[lower] ?? lower;
  return expanded
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function tryAutoCreateTopLevel(
  rawTag: string,
): Promise<TaxMapRow | null> {
  if (!isGenreLike(rawTag)) return null;

  const c = await loadCache();
  const genreSlug = tagToGenreSlug(rawTag);
  if (!genreSlug) return null;

  const insert = await supabase()
    .from('taxonomy_map')
    .insert({
      input_tag: rawTag,
      genres: [genreSlug],
      flavors: [],
    })
    .select('id, input_tag, genres, flavors')
    .single();

  if (insert.error) {
    // Race / prior-run conflict: refetch and use the existing row.
    if (insert.error.code === '23505') {
      const refetch = await supabase()
        .from('taxonomy_map')
        .select('id, input_tag, genres, flavors')
        .eq('input_tag', rawTag)
        .single();
      if (refetch.data) {
        c.mapByTag.set(rawTag.toLowerCase(), refetch.data);
        c.map.push(refetch.data);
        return refetch.data;
      }
    }
    throw insert.error;
  }

  // Update the in-memory cache so subsequent resolutions in the same run can
  // match this entry directly, AND so later similar tags ("cuban bolero" after
  // "bolero") find it as a candidate parent in tryAutoCreate's Jaccard search.
  c.mapByTag.set(rawTag.toLowerCase(), insert.data);
  c.map.push(insert.data);
  return insert.data;
}

async function tryAutoCreate(
  rawTag: string,
): Promise<{ row: TaxSubRow; confidence: number } | null> {
  const c = await loadCache();
  const rawTokens = tokenize(rawTag);
  if (rawTokens.length === 0) return null;

  let bestParent: TaxMapRow | null = null;
  let bestScore = 0;
  for (const candidate of c.map) {
    const score = jaccard(rawTokens, tokenize(candidate.input_tag));
    if (score > bestScore) {
      bestScore = score;
      bestParent = candidate;
    }
  }

  if (!bestParent || bestScore < CONFIDENCE_FLOOR) {
    return null;
  }

  const confidence = Math.min(1, Math.round(bestScore * 100) / 100);
  const insert = await supabase()
    .from('taxonomy_subgenres')
    .insert({
      input_tag: rawTag,
      parent_tag_id: bestParent.id,
      genres: bestParent.genres,
      flavors: bestParent.flavors,
      confidence,
    })
    .select('id, input_tag, parent_tag_id, genres, flavors, confidence')
    .single();

  if (insert.error) {
    // Unique-violation race: someone else auto-created this between our load + insert.
    // Refetch and treat as a subgenre hit.
    if (insert.error.code === '23505') {
      const refetch = await supabase()
        .from('taxonomy_subgenres')
        .select('id, input_tag, parent_tag_id, genres, flavors, confidence')
        .eq('input_tag', rawTag)
        .single();
      if (refetch.data) {
        c.subgenreByTag.set(rawTag.toLowerCase(), refetch.data);
        return { row: refetch.data, confidence: refetch.data.confidence };
      }
    }
    throw insert.error;
  }

  c.subgenreByTag.set(rawTag.toLowerCase(), insert.data);
  return { row: insert.data, confidence };
}

/**
 * Resolve a list of MB tags to Curi genres + flavors + subgenres,
 * auto-creating taxonomy_subgenres rows as needed.
 *
 * `count` is MB's tag vote count — we use it to weight the rollup so niche
 * tags don't drown out the dominant genre.
 */
export async function resolveTags(
  rawTags: Array<{ name: string; count: number }>,
): Promise<EnrichmentAggregate> {
  const c = await loadCache();
  const resolved: ResolvedTag[] = [];

  const genreWeight = new Map<string, number>();
  const flavorWeight = new Map<string, number>();
  const subgenres = new Set<string>();

  for (const { name, count } of rawTags) {
    const weight = Math.max(1, count || 1);
    const key = name.toLowerCase().trim();
    if (!key) continue;

    // 1. direct taxonomy_map hit
    const directMap = c.mapByTag.get(key);
    if (directMap) {
      resolved.push({
        inputTag: name,
        source: 'taxonomy_map',
        genres: directMap.genres,
        flavors: directMap.flavors,
        confidence: 1,
        weight,
      });
      for (const g of directMap.genres) {
        genreWeight.set(g, (genreWeight.get(g) ?? 0) + weight);
      }
      for (const f of directMap.flavors) {
        flavorWeight.set(f, (flavorWeight.get(f) ?? 0) + weight);
      }
      continue;
    }

    // 2. previously auto-created subgenre
    const directSub = c.subgenreByTag.get(key);
    if (directSub) {
      resolved.push({
        inputTag: name,
        source: 'taxonomy_subgenre',
        genres: directSub.genres,
        flavors: directSub.flavors,
        confidence: directSub.confidence,
        weight,
      });
      for (const g of directSub.genres) {
        genreWeight.set(g, (genreWeight.get(g) ?? 0) + weight);
      }
      for (const f of directSub.flavors) {
        flavorWeight.set(f, (flavorWeight.get(f) ?? 0) + weight);
      }
      subgenres.add(name);
      continue;
    }

    // 3. similarity-match existing taxonomy_map parent and auto-create subgenre
    const created = await tryAutoCreate(name);
    if (created) {
      resolved.push({
        inputTag: name,
        source: 'auto_created',
        genres: created.row.genres,
        flavors: created.row.flavors,
        confidence: created.confidence,
        weight,
      });
      for (const g of created.row.genres) {
        genreWeight.set(g, (genreWeight.get(g) ?? 0) + weight);
      }
      for (const f of created.row.flavors) {
        flavorWeight.set(f, (flavorWeight.get(f) ?? 0) + weight);
      }
      subgenres.add(name);
      continue;
    }

    // 4. no close parent — if the tag looks genre-like, create a new top-level
    //    taxonomy_map entry. Then the NEXT artist that has e.g. "cuban bolero"
    //    will find "bolero" as a close Jaccard parent in step 3.
    const topLevel = await tryAutoCreateTopLevel(name);
    if (topLevel) {
      resolved.push({
        inputTag: name,
        source: 'auto_created',
        genres: topLevel.genres,
        flavors: topLevel.flavors,
        confidence: 1,
        weight,
      });
      for (const g of topLevel.genres) {
        genreWeight.set(g, (genreWeight.get(g) ?? 0) + weight);
      }
      for (const f of topLevel.flavors) {
        flavorWeight.set(f, (flavorWeight.get(f) ?? 0) + weight);
      }
      continue;
    }

    // 5. unmapped — log for human review (junk metadata tags land here)
    resolved.push({
      inputTag: name,
      source: 'unmapped',
      genres: [],
      flavors: [],
      confidence: 0,
      weight,
    });
    await logUnmapped(
      [new Date().toISOString(), name, `count=${count}`].join('\t'),
    );
  }

  const byWeightDesc = (a: [string, number], b: [string, number]) =>
    b[1] - a[1];

  return {
    genres: [...genreWeight.entries()].sort(byWeightDesc).map(([g]) => g),
    flavors: [...flavorWeight.entries()].sort(byWeightDesc).map(([f]) => f),
    subgenres: [...subgenres],
    resolved,
  };
}

// Exposed for ad-hoc debugging / tests.
export const __testing = {
  tokenize,
  jaccard,
  isGenreLike,
  tagToGenreSlug,
  CONFIDENCE_FLOOR,
};
