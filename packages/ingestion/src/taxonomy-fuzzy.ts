// Fuzzy taxonomy matcher for the Phase 4 LLM enrichment pipeline.
//
// Lives between canonical exact-match (tier 1) and genuine-novel-tag
// auto-creation (tier 3) in the three-tier subgenre/vibe merge flow:
//
//   1. Canonical exact match  — tier 1, cheap, deterministic
//   2. Fuzzy near-match       — tier 2, Lev distance 1–2 on canonical form
//   3. Novel                  — tier 3, genuinely new, auto-create
//
// Tier 2 is where we catch typos / minor variants ("hardtranse" vs
// "hard trance") without merging real-but-similar tags ("house" vs
// "horse"). Candidates surfaced by tier 2 are routed to Sonnet during
// the same enrichment call for yes/no confirmation — we never
// auto-merge on Lev distance alone, because the collision risk on
// short canonical forms is too high.
//
// ## Canonical normalization
//
// `normalizeForTaxonomy` lowercases, strips punctuation, and removes
// all whitespace. The whitespace-removal choice is deliberate: it
// collapses "Peak Time" / "peak-time" / "peaktime" to a single
// canonical form ("peaktime") so tier 1 catches the spacing/hyphen
// variants without needing fuzzy-match machinery.
//
// ## Length gate on near-match
//
// `findNearMatch` requires the shorter of the two canonical strings
// to be at least 6 characters. At 5 or fewer, a single substitution
// already produces a real-but-different word (house ↔ horse; house
// ↔ mouse; techno ↔ tekno would squeak past only because length = 6).
// Pushing the floor to 6 keeps short-word false positives out of
// Sonnet's review queue without sacrificing the typo cases we care
// about on longer tags (hard-trance / hardcore / psytrance / etc.).

/**
 * Normalize a tag string to its canonical form for taxonomy matching.
 *
 * Steps:
 *   1. Lowercase (so "House" / "house" / "HOUSE" collapse).
 *   2. Replace anything not a-z0-9 with "" (strips punctuation AND
 *      whitespace in one pass — deliberate, see module header).
 *
 * Examples:
 *   "Deep House"   → "deephouse"
 *   "Peak Time"    → "peaktime"
 *   "Drum & Bass"  → "drumbass"
 *   "hard-trance"  → "hardtrance"
 *   "  house  "    → "house"
 *   ""             → ""
 */
export function normalizeForTaxonomy(s: string): string {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Minimum canonical length for `findNearMatch` to consider a fuzzy
 * candidate. At length 5, edit distance 1 already flips house↔horse /
 * house↔mouse. At length 6, the minimum-distinguishing character
 * count makes false positives much rarer. Tags shorter than this
 * threshold can only be merged via tier 1 (exact canonical match).
 */
const MIN_CANONICAL_LENGTH = 6;

/**
 * Maximum Levenshtein distance on canonical forms to be considered a
 * near-match. Beyond 2, differences are more likely to be semantic
 * than typographic.
 */
const MAX_EDIT_DISTANCE = 2;

/**
 * Result of a near-match lookup. `distance` is the Levenshtein
 * distance on canonical forms — 0 means the canonicals are identical
 * (caller can treat that as a tier-1 hit even though tier 1 was
 * supposed to catch it); 1–2 are the tier-2 candidates Sonnet should
 * confirm.
 */
export interface NearMatch {
  /** The matching entry from `existing[]`, returned verbatim (not the
   *  canonical form) so the caller can use it in UI or DB writes. */
  match: string;
  /** Levenshtein distance between the two canonical forms. */
  distance: number;
  /** Canonical form of the input candidate, for debugging/logging. */
  candidateCanonical: string;
  /** Canonical form of the matched entry, for debugging/logging. */
  matchCanonical: string;
}

/**
 * Find the closest existing-entry match for `candidate` using
 * normalized Levenshtein distance.
 *
 * Returns:
 *   - the single closest match with distance 0..MAX_EDIT_DISTANCE, OR
 *   - null when no entry is close enough (or the length gate excludes
 *     all candidates)
 *
 * Ties go to the first-seen entry in `existing[]` (stable).
 */
export function findNearMatch(
  candidate: string,
  existing: string[],
): NearMatch | null {
  const candCanon = normalizeForTaxonomy(candidate);
  if (candCanon.length === 0) return null;

  let best: NearMatch | null = null;

  for (const entry of existing) {
    const entryCanon = normalizeForTaxonomy(entry);
    if (entryCanon.length === 0) continue;

    // Length gate: the SHORTER of the two must clear MIN_CANONICAL_LENGTH.
    // This excludes short-word collisions (house/horse) while still
    // letting typos on longer tags (hard-trance / hardtranse) through.
    const shorter = Math.min(candCanon.length, entryCanon.length);
    if (shorter < MIN_CANONICAL_LENGTH) continue;

    // Quick reject: if length delta already exceeds MAX_EDIT_DISTANCE,
    // Levenshtein distance can't be less than that delta — skip the
    // O(n*m) DP matrix.
    const lenDelta = Math.abs(candCanon.length - entryCanon.length);
    if (lenDelta > MAX_EDIT_DISTANCE) continue;

    const d = levenshtein(candCanon, entryCanon);
    if (d > MAX_EDIT_DISTANCE) continue;

    if (!best || d < best.distance) {
      best = {
        match: entry,
        distance: d,
        candidateCanonical: candCanon,
        matchCanonical: entryCanon,
      };
      // Early exit on exact canonical match — can't do better than 0.
      if (d === 0) break;
    }
  }

  return best;
}

/**
 * Classic Levenshtein distance via row-by-row DP. O(n*m) time, O(min)
 * space. Handles the empty-string edge cases naturally.
 *
 * We stop the caller from passing unreasonably long strings by design
 * (canonical taxonomy entries are a handful of characters), so the
 * quadratic cost is not a concern here.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter string — saves memory on the row buffer.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      // deletion, insertion, substitution
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    // Swap rows for next iteration.
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[b.length]!;
}
