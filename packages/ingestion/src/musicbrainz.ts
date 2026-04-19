// MusicBrainz client with a strict 1 req/sec global gate.
//
// MB enforces rate limits aggressively. Their public guidance: 1 req/sec per
// IP, include a contactful User-Agent. Going faster triggers 503s and IP bans.
//
// Usage:
//   const hit = await searchArtist('DJ Python');
//   if (hit) {
//     const tags = await lookupArtistTags(hit.id);
//   }

import { env } from './env.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1050; // a hair over 1s to stay safely under the limit

// Serialize all requests through one promise chain.
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const now = Date.now();
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestAt));
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastRequestAt = Date.now();
    return task();
  };
  const next = queue.then(run, run);
  // Keep the chain going but don't propagate errors into later calls.
  queue = next.catch(() => undefined);
  return next;
}

async function mbFetch<T>(path: string): Promise<T> {
  const url = `${MB_BASE}${path}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': env.musicbrainzUserAgent,
        Accept: 'application/json',
      },
    });
    if (res.ok) {
      return (await res.json()) as T;
    }
    if (res.status === 503 || res.status === 429) {
      // Back off hard and retry.
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`musicbrainz ${res.status} ${res.statusText} on ${path}`);
  }
  throw new Error(`musicbrainz exhausted retries on ${path}`);
}

// ── public API ─────────────────────────────────────────────────────────────────

export interface MbArtistHit {
  id: string;
  name: string;
  score: number;
  disambiguation?: string;
}

export interface MbArtistDetail {
  id: string;
  name: string;
  tags: Array<{ name: string; count: number }>;
  genres: Array<{ name: string; count: number }>;
}

// Strip punctuation + lowercase for name comparison. MB can store "Yaya" or
// "Ya-Ya" or "YAYA" for the same artist, so we normalize both sides before
// comparing.
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Decide whether an MB search hit is a trustworthy match for the input name.
 *
 * History: the loose "score >= 70" threshold caused false-positive matches
 * where short/common DJ aliases ("Yaya", "BIGGIE", "2026") got matched to
 * unrelated hip-hop/rap MB artists. Those wrong-artist MB ids polluted the
 * artists table with wrong genres + wrong disambiguation.
 *
 * Rules:
 *   - Score floor: 95 (MB's score is 0-100; 100 = exact name match)
 *   - Name floor: normalized input must equal normalized hit name
 *   - Pure-numeric or too-short inputs: reject entirely — too ambiguous
 *   - Single-token inputs ("Yaya"): require score 100 (exact match only)
 *   - Multi-token inputs ("DJ Python"): allow score 95+ with normalized name match
 */
function isTrustworthyMatch(input: string, hit: MbArtistHit): boolean {
  const trimmed = input.trim();
  const normInput = normalizeForCompare(trimmed);
  const normHit = normalizeForCompare(hit.name);

  // Require at least 2 alphabetic chars in the input — "2026", "123" are too ambiguous.
  if (!/[a-z].*[a-z]/i.test(normInput)) return false;

  // Names must normalize-match. No fuzzy accepted here.
  if (normInput !== normHit) return false;

  // Single-token input → very strict. "Yaya" / "BIGGIE" matched to unrelated artists at score ~100 already.
  const isSingleToken = !/\s/.test(trimmed);
  const minLen = 4;
  if (isSingleToken && normInput.length < minLen) return false;
  if (isSingleToken) return hit.score >= 100;

  return hit.score >= 95;
}

export function searchArtist(name: string): Promise<MbArtistHit | null> {
  const q = encodeURIComponent(`artist:"${name}"`);
  return throttled(async () => {
    const payload = await mbFetch<{ artists?: MbArtistHit[] }>(
      `/artist?query=${q}&fmt=json&limit=10`,
    );
    const hits = payload.artists ?? [];
    const trimmed = name.trim();
    const normInput = normalizeForCompare(trimmed);
    const isSingleToken = !/\s/.test(trimmed);

    // Ambiguity guard: if there are multiple MB artists with an exact
    // normalized-name match, we can't tell which one is ours. Single-token
    // names ("Yaya") are especially prone to this — MB has many artists named
    // Yaya, Biggie, etc. Abort rather than pick a random one.
    const exactMatches = hits.filter(
      (h) => h.score >= 100 && normalizeForCompare(h.name) === normInput,
    );
    if (isSingleToken && exactMatches.length > 1) return null;

    // Walk in MB's score-desc order and take the first trustworthy hit.
    // Since hits are sorted, we can break early once score drops below our floor.
    for (const hit of hits) {
      if (hit.score < 95) break;
      if (isTrustworthyMatch(name, hit)) return hit;
    }
    return null;
  });
}

export function lookupArtistTags(mbid: string): Promise<MbArtistDetail> {
  return throttled(async () => {
    const payload = await mbFetch<{
      id: string;
      name: string;
      tags?: Array<{ name: string; count: number }>;
      genres?: Array<{ name: string; count: number }>;
    }>(`/artist/${mbid}?inc=tags+genres&fmt=json`);
    return {
      id: payload.id,
      name: payload.name,
      tags: payload.tags ?? [],
      genres: payload.genres ?? [],
    };
  });
}

/**
 * Convenience: search + lookup in one call, with null-safety for misses.
 * Returns null if the artist can't be found or has no useful tags.
 */
export async function enrichArtist(
  name: string,
): Promise<MbArtistDetail | null> {
  const hit = await searchArtist(name);
  if (!hit) return null;
  return lookupArtistTags(hit.id);
}
