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

// ── public API ───────────────────────────────────────────────────────────────

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

export function searchArtist(name: string): Promise<MbArtistHit | null> {
  const q = encodeURIComponent(`artist:"${name}"`);
  return throttled(async () => {
    const payload = await mbFetch<{ artists?: MbArtistHit[] }>(
      `/artist?query=${q}&fmt=json&limit=3`,
    );
    const hits = payload.artists ?? [];
    if (hits.length === 0) return null;
    // MB sorts by score desc; take the top hit if it's a strong match.
    const top = hits[0];
    if (!top || top.score < 70) return null;
    return top;
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
