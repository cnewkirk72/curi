// Phase 5.7 — pathfinder persisted-query hash resolver.
//
// Spotify's pathfinder GraphQL pins each operation behind a
// `sha256Hash` that rotates with their bundle releases (~weekly to
// monthly). The hash is publicly visible in the open.spotify.com
// JS bundle at runtime; we extract it on cold start and memoize.
//
// Caching strategy: module-global memo. Hot for the lifetime of the
// Node process (Vercel server-action warm starts; the Railway cron's
// single run). On 400 with `errors[0].extensions.code ===
// 'PERSISTED_QUERY_NOT_FOUND'` the caller invalidates via
// `invalidateHash()` and retries — same rotation-recovery path SC's
// client_id resolver uses.
//
// Why not env-var: rotates more frequently than SC's client_id and
// without warning. Pulling fresh on cold-start is ~500ms (one HTML
// fetch + one JS fetch, sometimes a fallback to a second JS fetch)
// and self-healing.

import { ScrapeFailedError } from './types.js';

const HASHES = {
  queryArtistsFollowed: null as string | null,
} as const;

type HashName = keyof typeof HASHES;
const _cached: Record<HashName, string | null> = { ...HASHES };
const _inflight: Partial<Record<HashName, Promise<string>>> = {};

const SPOTIFY_HOMEPAGE = 'https://open.spotify.com/';

// Match all script tags pointing at Spotify's CDN. Same pattern as
// SC's SCRIPT_SRC_RE — there are typically 5-15 chunks; we walk them
// in document order until we find the one carrying the hash literal.
const SCRIPT_SRC_RE =
  /<script[^>]+src="(https:\/\/[^"]*?(?:open|encore|encore-web)\.spotify[a-z]+\/[^"]+\.js)"/g;

// Spotify's bundler emits the persisted-query metadata as a literal
// string inside a registry call. Both shapes have been observed
// across releases:
//
//   {"sha256Hash":"abc...","operationName":"queryArtistsFollowed"}
//   queryArtistsFollowed:{...,sha256Hash:"abc..."}
//
// We try the strict bidirectional pattern first, then a relaxed
// "hash-near-operation-name" fallback.
function buildHashRe(operationName: string): RegExp[] {
  const op = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // Tight: sha256Hash followed by operationName, JSON-style
    new RegExp(
      `"sha256Hash"\\s*:\\s*"([a-f0-9]{64})"[^}]{0,100}"operationName"\\s*:\\s*"${op}"`,
    ),
    // Tight: operationName followed by sha256Hash, JSON-style
    new RegExp(
      `"operationName"\\s*:\\s*"${op}"[^}]{0,100}"sha256Hash"\\s*:\\s*"([a-f0-9]{64})"`,
    ),
    // Relaxed: just any 64-hex literal within ~200 chars of the
    // operationName string. Used as a last resort across bundle
    // reformats.
    new RegExp(`"${op}"[\\s\\S]{0,200}?"([a-f0-9]{64})"`),
  ];
}

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Resolve the persisted-query sha256 hash for a known pathfinder
 * operation. Cached for the lifetime of the Node process. Concurrent
 * callers during the first miss share a single in-flight promise.
 */
export async function getPersistedQueryHash(
  operationName: HashName,
): Promise<string> {
  const cached = _cached[operationName];
  if (cached) return cached;
  const inflight = _inflight[operationName];
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const html = await fetchText(SPOTIFY_HOMEPAGE);
      const scriptUrls = extractScriptUrls(html);

      if (scriptUrls.length === 0) {
        throw new ScrapeFailedError(
          'No Spotify bundle script tags found in homepage HTML — ' +
            'bundle structure may have changed',
        );
      }

      const hashPatterns = buildHashRe(operationName);

      // Walk bundles in document order, short-circuit on first hit.
      // The hash is usually in the first or second app chunk; the
      // long tail is rare but worth covering for resilience.
      for (const url of scriptUrls) {
        let js: string;
        try {
          js = await fetchText(url);
        } catch {
          // Single bundle failed to fetch — keep walking. CDN
          // hiccups are surprisingly common here.
          continue;
        }
        for (const re of hashPatterns) {
          const m = js.match(re);
          if (m && m[1]) {
            _cached[operationName] = m[1];
            return m[1];
          }
        }
      }

      throw new ScrapeFailedError(
        `Persisted-query hash not found for "${operationName}" in any of ` +
          `${scriptUrls.length} Spotify bundles — bundle reformatted or ` +
          'operation renamed',
      );
    } finally {
      delete _inflight[operationName];
    }
  })();

  _inflight[operationName] = promise;
  return promise;
}

/**
 * Drop the cached hash for a given operation. Call when pathfinder
 * returns 400 with PERSISTED_QUERY_NOT_FOUND — Spotify rotated the
 * bundle and our memoized hash is stale. Caller refetches via
 * `getPersistedQueryHash()` and retries the original request once.
 */
export function invalidateHash(operationName: HashName): void {
  _cached[operationName] = null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new ScrapeFailedError(
      `${url} → ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}

function extractScriptUrls(html: string): string[] {
  const urls: string[] = [];
  // Reset regex lastIndex defensively (module-level /g state can
  // leak between calls).
  SCRIPT_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_SRC_RE.exec(html)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  // De-dupe while preserving order — same bundle can appear twice
  // across <link rel="preload"> + <script>.
  return Array.from(new Set(urls));
}
