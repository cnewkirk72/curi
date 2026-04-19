// Unit tests for taxonomy-fuzzy.ts.
//
// Zero-dep: uses node:test + node:assert so it can run via
//   npx tsx --test src/taxonomy-fuzzy.test.ts
// without pulling a new test framework into the monorepo. If/when we
// adopt vitest or similar at the workspace level, this file will port
// over with a find-and-replace on the imports.
//
// Covers the edge cases called out in PHASE_4_PLAN.md under 4a:
//   - house/horse false-positive rejection       (both len 5, excluded)
//   - hard trance / hardtrance merge              (tier-1 after strip)
//   - peaktime / peak time whitespace collapse    (tier-1 after strip)
//   - plus: punctuation stripping, empty inputs, Lev threshold edges.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForTaxonomy,
  findNearMatch,
  levenshtein,
} from './taxonomy-fuzzy.js';

describe('normalizeForTaxonomy', () => {
  it('lowercases', () => {
    assert.equal(normalizeForTaxonomy('HOUSE'), 'house');
    assert.equal(normalizeForTaxonomy('Deep House'), 'deephouse');
  });

  it('strips all whitespace (tier-1 spacing collapse)', () => {
    // Both canonicalize identically, so the tier-1 exact-match check
    // catches them without any fuzzy machinery.
    assert.equal(normalizeForTaxonomy('Peak Time'), 'peaktime');
    assert.equal(normalizeForTaxonomy('peaktime'), 'peaktime');
    assert.equal(normalizeForTaxonomy('peak time'), 'peaktime');
    assert.equal(normalizeForTaxonomy('peak  time'), 'peaktime');
    assert.equal(normalizeForTaxonomy('  peak time  '), 'peaktime');
  });

  it('strips punctuation', () => {
    assert.equal(normalizeForTaxonomy('drum & bass'), 'drumbass');
    assert.equal(normalizeForTaxonomy('drum-and-bass'), 'drumandbass');
    assert.equal(normalizeForTaxonomy("d'n'b"), 'dnb');
    assert.equal(normalizeForTaxonomy('hip/hop'), 'hiphop');
  });

  it('handles hard trance / hardtrance variants', () => {
    assert.equal(normalizeForTaxonomy('Hard Trance'), 'hardtrance');
    assert.equal(normalizeForTaxonomy('hardtrance'), 'hardtrance');
    assert.equal(normalizeForTaxonomy('hard-trance'), 'hardtrance');
  });

  it('handles deep house variants', () => {
    assert.equal(normalizeForTaxonomy('Deep House'), 'deephouse');
    assert.equal(normalizeForTaxonomy('deep-house'), 'deephouse');
    assert.equal(normalizeForTaxonomy('deephouse'), 'deephouse');
  });

  it('returns empty string for empty/whitespace-only inputs', () => {
    assert.equal(normalizeForTaxonomy(''), '');
    assert.equal(normalizeForTaxonomy('   '), '');
    assert.equal(normalizeForTaxonomy('!!! ??? '), '');
  });

  it('survives non-string input defensively', () => {
    // JS callers can pass null/undefined through loose typing.
    assert.equal(normalizeForTaxonomy(null as unknown as string), '');
    assert.equal(normalizeForTaxonomy(undefined as unknown as string), '');
    assert.equal(normalizeForTaxonomy(42 as unknown as string), '');
  });

  it('preserves digits', () => {
    assert.equal(normalizeForTaxonomy('2 Step'), '2step');
    assert.equal(normalizeForTaxonomy('Y2K'), 'y2k');
  });
});

describe('levenshtein', () => {
  it('zero for identical strings', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('house', 'house'), 0);
  });

  it('handles empty strings', () => {
    assert.equal(levenshtein('', 'house'), 5);
    assert.equal(levenshtein('house', ''), 5);
  });

  it('computes classic examples correctly', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('house', 'horse'), 1);
    assert.equal(levenshtein('hardtrance', 'hardtranse'), 1);
    assert.equal(levenshtein('hardtrance', 'hardtranc'), 1);
    assert.equal(levenshtein('hardtrance', 'hadrtrance'), 2);
  });
});

describe('findNearMatch', () => {
  it('rejects house/horse collision (length gate excludes short words)', () => {
    // Both canonicalize to length 5. Levenshtein would return 1, but
    // the MIN_CANONICAL_LENGTH gate (6) keeps the pair out of the
    // near-match queue. This is the canonical false-positive test.
    assert.equal(findNearMatch('horse', ['house']), null);
    assert.equal(findNearMatch('house', ['horse']), null);
    assert.equal(findNearMatch('mouse', ['house']), null);
  });

  it('finds single-typo match on longer tags (hardtranse → hard trance)', () => {
    // "hardtranse" canonicalizes to "hardtranse" (10 chars).
    // "hard trance" canonicalizes to "hardtrance" (10 chars).
    // Lev distance = 1, min length = 10 ≥ 6, ✓ in range.
    const hit = findNearMatch('hardtranse', ['hard trance']);
    assert.ok(hit !== null, 'expected a near-match');
    assert.equal(hit!.match, 'hard trance');
    assert.equal(hit!.distance, 1);
    assert.equal(hit!.candidateCanonical, 'hardtranse');
    assert.equal(hit!.matchCanonical, 'hardtrance');
  });

  it('returns distance-0 hit when canonicals are identical (tier-1 overlap)', () => {
    // Peak Time / peaktime canonicalize identically — tier 1 normally
    // catches this, but findNearMatch should still report it rather
    // than silently miss the overlap.
    const hit = findNearMatch('Peak Time', ['peaktime']);
    assert.ok(hit !== null);
    assert.equal(hit!.distance, 0);
    assert.equal(hit!.match, 'peaktime');
  });

  it('returns distance-0 hit for hard-trance / Hard Trance', () => {
    const hit = findNearMatch('Hard Trance', ['hard-trance']);
    assert.ok(hit !== null);
    assert.equal(hit!.distance, 0);
    assert.equal(hit!.match, 'hard-trance');
  });

  it('returns distance-0 hit for deep house / deephouse', () => {
    const hit = findNearMatch('deephouse', ['Deep House']);
    assert.ok(hit !== null);
    assert.equal(hit!.distance, 0);
    assert.equal(hit!.match, 'Deep House');
  });

  it('picks the closest match when multiple candidates are in range', () => {
    // "psytranse" is distance 1 from "psytrance" (len 9, ✓)
    // and distance 2 from "goatrance" (len 9, ✓). Closest wins.
    const hit = findNearMatch('psytranse', ['goatrance', 'psytrance']);
    assert.ok(hit !== null);
    assert.equal(hit!.match, 'psytrance');
    assert.equal(hit!.distance, 1);
  });

  it('rejects matches beyond Lev distance 2', () => {
    // "hardcore" vs "hardstyle" — both long enough, but distance = 4.
    assert.equal(findNearMatch('hardcore', ['hardstyle']), null);
  });

  it('rejects matches when length delta alone exceeds threshold', () => {
    // "ambient" (7) vs "progressiveambient" (18) — length delta is 11,
    // which beats MAX_EDIT_DISTANCE on its own. Should short-circuit.
    assert.equal(findNearMatch('ambient', ['progressiveambient']), null);
  });

  it('returns null for empty candidate', () => {
    assert.equal(findNearMatch('', ['house', 'techno']), null);
    assert.equal(findNearMatch('  ', ['hardtrance']), null);
  });

  it('returns null when existing list is empty', () => {
    assert.equal(findNearMatch('hardtrance', []), null);
  });

  it('skips empty entries in the existing list', () => {
    const hit = findNearMatch('hardtranse', ['', '  ', 'hard trance']);
    assert.ok(hit !== null);
    assert.equal(hit!.match, 'hard trance');
  });

  it('finds a match at the length-6 boundary (techno ↔ tekhno)', () => {
    // canonical "techno" = 6, canonical "tekhno" = 6. Lev = 2. Both
    // clear the gate. This is intentional: at length 6 the gate
    // admits the pair and Sonnet confirms. We want typos on short
    // real-genre names to reach Sonnet review — just not pass through
    // as auto-merges on distance alone.
    const hit = findNearMatch('tekhno', ['techno']);
    assert.ok(hit !== null);
    assert.equal(hit!.distance, 2);
    assert.equal(hit!.match, 'techno');
  });
});
