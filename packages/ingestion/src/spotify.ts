// Spotify Web API client for artist enrichment.
//
// Auth: Client Credentials flow. We only read public catalog data (artist
// search + artist info), so no user authorization is needed — Spotify's
// "Development mode" 25-user cap does NOT apply to this flow. Tokens are
// valid for ~1h; we cache in-process and refresh ~1 minute before expiry.
//
// Two-call flow per artist:
//   1. GET /v1/search?q=<name>&type=artist  — find candidate by name
//   2. GET /v1/artists/{id}                  — fetch full artist object
//
// Why two calls: Spotify's Search response returns a SIMPLIFIED artist
// payload that omits `genres`, `popularity`, and `followers` entirely
// (observed in the Phase 3.18 eval run — every successful match came back
// pop=0, genres=(none) regardless of how famous the artist was). The
// per-id artist endpoint returns the full object. Future optimization:
// batch up to 50 ids via /v1/artists?ids=… during the backfill.
//
// Usage:
//   import { searchArtistOnSpotify } from './spotify.js';
//   const hit = await searchArtistOnSpotify('Honey Dijon');
//   if (hit && hit.confidence !== 'low') {
//     // hit.genres[], hit.popularity, hit.spotifyId, hit.followers
//   }
//
// Rate limits: Spotify uses a rolling 30s window with generous headroom for
// Client Credentials. We throttle to ~10 req/s locally just to be polite on
// a 1,600-artist backfill. 429 responses are honored via Retry-After.
//
// The caller is expected to run returned genre strings through resolveTags()
// (taxonomy.ts) — Spotify's genre names ("deep house", "tech house", "nu
// disco") don't line up 1:1 with ours but our taxonomy_map + smart-subgenre
// layer handles the translation + auto-creation.

import { env } from './env.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

// Refresh a minute before the stated TTL to avoid mid-request expirations.
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

// Light throttle: 10 req/s is well under anything Spotify flags, but keeps
// the backfill well-behaved if we ever paralleize across workers.
const MIN_INTERVAL_MS = 100;

// ── internal types ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number; // 0–100; derived from recent listener activity
  followers: { total: number };
  images: SpotifyImage[];
  external_urls: { spotify: string };
}

interface SearchResponse {
  artists?: { items?: SpotifyArtist[] };
}

// ── auth ─────────────────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (
    cachedToken &&
    Date.now() < cachedToken.expiresAt - TOKEN_EXPIRY_SAFETY_MS
  ) {
    return cachedToken.token;
  }
  if (!env.spotifyClientId || !env.spotifyClientSecret) {
    throw new Error(
      'Spotify client not configured — set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET',
    );
  }
  const basic = Buffer.from(
    `${env.spotifyClientId}:${env.spotifyClientSecret}`,
  ).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `spotify token ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
    );
  }
  const json = (await res.json()) as TokenResponse;
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

// ── throttle ─────────────────────────────────────────────────────────────────

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    lastRequestAt = Date.now();
    return task();
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

// ── fetch with auth + retry ─────────────────────────────────────────────────

async function spotifyFetch<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401) {
      // Token rejected (expired early, or revoked). Force-refresh and retry.
      cachedToken = null;
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number.parseInt(
        res.headers.get('retry-after') ?? '5',
        10,
      );
      // Cap at 30s — if Spotify wants longer (sometimes 20+ hours when
      // Client Credentials quota is burned), abort this artist with a
      // surfaced error rather than freezing the orchestrator per row.
      if (retryAfter > 30) {
        throw new Error(
          `spotify rate-limited with retry-after=${retryAfter}s on ${path} — aborting artist`,
        );
      }
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    throw new Error(`spotify ${res.status} ${res.statusText} on ${path}`);
  }
  throw new Error(`spotify exhausted retries on ${path}`);
}

// ── public API ───────────────────────────────────────────────────────────────

// Strip punctuation + lowercase for name comparison. Mirrors the approach in
// musicbrainz.ts — Spotify can return "DJ Python" or "DJ PYTHON" or similar.
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Decision about a Spotify search match. Callers should treat 'low' as
 * "couldn't confirm" and NOT use its genres for classification.
 *
 *   high   — exact normalized-name match + popularity ≥ 10 (we have real
 *            listener signal confirming this is the intended artist)
 *   medium — exact normalized-name match, popularity < 10 (niche / new
 *            act — probably right, but no listener-graph backup)
 *   low    — no exact-name candidate; best fuzzy hit returned for
 *            caller review (NOT recommended for automated tagging)
 */
export type SpotifyMatchConfidence = 'high' | 'medium' | 'low';

export interface SpotifyArtistMatch {
  spotifyId: string;
  name: string;
  genres: string[];
  popularity: number;
  followers: number;
  imageUrl: string | null;
  spotifyUrl: string;
  confidence: SpotifyMatchConfidence;
}

// Non-artist strings we'd rather not spend a request on. Expand as needed.
const LITERAL_NON_ARTISTS = new Set([
  'tba',
  'tbd',
  'various',
  'variousartists',
  'varioushosts',
  'unknown',
]);

/**
 * Search Spotify for an artist by name. Returns the best exact-name match,
 * or null if no acceptable match exists. Does NOT return fuzzy matches —
 * callers that want those can pass through to the LLM layer.
 */
export function searchArtistOnSpotify(
  name: string,
): Promise<SpotifyArtistMatch | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return Promise.resolve(null);

  const normInput = normalizeForCompare(trimmed);
  // Pure numeric or single-char — too ambiguous, don't burn a request.
  if (normInput.length < 2) return Promise.resolve(null);
  if (LITERAL_NON_ARTISTS.has(normInput)) return Promise.resolve(null);

  const query = encodeURIComponent(trimmed);
  return throttled(async () => {
    const payload = await spotifyFetch<SearchResponse>(
      `/search?q=${query}&type=artist&limit=5`,
    );
    const items = payload.artists?.items ?? [];
    if (items.length === 0) return null;

    // Exact-normalized-name candidates first. Among those, pick the highest
    // popularity — Spotify often returns multiple artists sharing a name
    // (e.g. "Jupiter") and popularity is the most reliable disambiguator.
    // NB: coerce popularity to 0 before subtraction — Spotify has been seen
    // to omit the field on some simplified payloads, which would make the
    // comparator produce NaN and leave the list effectively unsorted.
    const exactMatches = items
      .filter((a) => normalizeForCompare(a.name) === normInput)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

    const best = exactMatches[0];
    if (!best) {
      // No exact-name candidate. We deliberately don't return fuzzy results
      // here — letting the automated pipeline use a fuzzy match is how you
      // get "Yaya" (underground DJ) tagged as reggaeton because Spotify
      // matched to a different Yaya. Caller can fall through to LLM layer.
      return null;
    }

    // Second call: /v1/artists/{id} returns the FULL artist object. The
    // Search response's simplified payload omits genres/popularity/followers,
    // so without this hop every match comes back pop=0, genres=(none). Worth
    // the extra ~100ms per artist to actually get the data we're after.
    const full = await spotifyFetch<SpotifyArtist>(`/artists/${best.id}`);
    const confidence: SpotifyMatchConfidence =
      (full.popularity ?? 0) >= 10 ? 'high' : 'medium';
    return toMatch(full, confidence);
  });
}

function toMatch(
  a: SpotifyArtist,
  confidence: SpotifyMatchConfidence,
): SpotifyArtistMatch {
  // Defensive defaults. Spotify's Search response has been observed to OMIT
  // `genres` entirely on artists that have no genre tags (not return `[]`).
  // Same for `popularity` on some simplified payloads. Normalize here so
  // callers always get well-typed, array/number-safe fields.
  return {
    spotifyId: a.id,
    name: a.name,
    genres: a.genres ?? [],
    popularity: a.popularity ?? 0,
    followers: a.followers?.total ?? 0,
    imageUrl: a.images?.[0]?.url ?? null,
    spotifyUrl: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
    confidence,
  };
}
