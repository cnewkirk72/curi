// Phase 5.7 — pathfinder persisted-query hash resolver.
//
// NOTE: Dual-copy of packages/ingestion/src/spotify-follows/hash-resolver.ts.
// See ./types.ts for the dual-copy rationale.
//
// Two-tier resolution:
//
//   1. SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH env var (primary). Captured
//      once from DevTools → Network → any pathfinder POST → request
//      body `extensions.persistedQuery.sha256Hash`. Stable for months
//      until Spotify rotates the bundle. Setting this env var skips
//      bundle scraping entirely on the warm path.
//
//   2. Bundle scraping fallback. Hits open.spotify.com with the bot's
//      sp_dc cookie attached, walks the script tags + modulepreload
//      links for any Spotify CDN URL, fetches each .js file, regexes
//      for the hash literal near the operation name. Used both on
//      cold start when no env override is set, AND when pathfinder
//      returns 400 PERSISTED_QUERY_NOT_FOUND (env hash went stale).
//
// The cookie matters: anonymous requests to open.spotify.com get a
// marketing landing page that has zero app bundles in it. Sending
// sp_dc gets the authenticated SPA HTML which carries every bundle
// URL we need.

import { ScrapeFailedError } from './types';

const HASHES = {
  queryArtistsFollowed: null as string | null,
} as const;

type HashName = keyof typeof HASHES;
const _cached: Record<HashName, string | null> = { ...HASHES };
const _inflight: Partial<Record<HashName, Promise<string>>> = {};

// Operator-supplied hash overrides keyed by operation name. Read
// lazily inside `getPersistedQueryHash` so a missing env var on cold
// start doesn't throw at module-import time. New operations added
// here as the spotify-follows surface grows.
function envHashFor(operationName: HashName): string | undefined {
  switch (operationName) {
    case 'queryArtistsFollowed':
      return process.env.SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH;
    default:
      return undefined;
  }
}

const SPOTIFY_HOMEPAGE = 'https://open.spotify.com/';

// Match <script src="..."> AND <link rel="modulepreload" href="...">
// pointing at any Spotify-controlled CDN. Spotify shifted some
// bundles to modulepreload hints in 2024–2025; the previous
// script-only regex missed those.
//
// Substring match on `spotify`, `scdn`, or `encore` covers:
//   - open.spotifycdn.com (primary)
//   - encore.scdn.co (Encore design system)
//   - xpui.app.spotify.com (web player chunks)
//   - any future domain move under those brands
const SCRIPT_SRC_RE =
  /<(?:script|link)[^>]+(?:src|href)="(https:\/\/[^"]*?(?:spotify|scdn|encore)[^"]*\.js)"/gi;

// Last-resort fallback when SCRIPT_SRC_RE finds zero matches. Any
// .js URL whose path contains a Spotify-controlled substring — even
// inside other tags. Wider net for tombstoned/unknown bundle hosts.
const ANY_JS_RE =
  /(https:\/\/[^"'\s]*?(?:spotify|scdn|encore)[^"'\s]*\.js)/gi;

// Hash-extraction patterns inside bundle JS. Spotify's webpack
// bundle ships the persisted-query metadata in a few different
// shapes depending on release / minification level:
//
//   { sha256Hash: "abc...", operationName: "queryArtistsFollowed" }     ← unquoted keys (minified)
//   {"sha256Hash":"abc...","operationName":"queryArtistsFollowed"}      ← quoted keys (devtool/sourcemap)
//   { operationName: "queryArtistsFollowed", ..., sha256Hash: "abc..." } ← reverse order
function buildHashRe(operationName: string): RegExp[] {
  const op = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // Quoted keys — hash before name
    new RegExp(
      `"sha256Hash"\\s*:\\s*"([a-f0-9]{64})"[^}]{0,100}"operationName"\\s*:\\s*"${op}"`,
    ),
    // Quoted keys — name before hash
    new RegExp(
      `"operationName"\\s*:\\s*"${op}"[^}]{0,100}"sha256Hash"\\s*:\\s*"([a-f0-9]{64})"`,
    ),
    // Unquoted keys (minified) — hash before name
    new RegExp(
      `sha256Hash\\s*:\\s*"([a-f0-9]{64})"[^}]{0,100}operationName\\s*:\\s*"${op}"`,
    ),
    // Unquoted keys (minified) — name before hash
    new RegExp(
      `operationName\\s*:\\s*"${op}"[^}]{0,100}sha256Hash\\s*:\\s*"([a-f0-9]{64})"`,
    ),
    // Relaxed: any 64-hex literal within 200 chars of the quoted op
    // name. Last-resort across bundle reformats.
    new RegExp(`"${op}"[\\s\\S]{0,200}?"([a-f0-9]{64})"`),
    // Relaxed: any 64-hex within 200 chars of the unquoted op name.
    new RegExp(`${op}[\\s\\S]{0,200}?"([a-f0-9]{64})"`),
  ];
}

const FETCH_HEADERS_HOMEPAGE: () => HeadersInit = () => {
  // Send the bot's sp_dc cookie on the homepage fetch so Spotify
  // serves the authenticated SPA HTML (which has the bundle scripts)
  // instead of the marketing landing page (which doesn't).
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const sp_dc = process.env.SPOTIFY_BOT_SP_DC;
  if (sp_dc) headers.Cookie = `sp_dc=${sp_dc}`;
  return headers;
};

const FETCH_HEADERS_BUNDLE: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
};

export async function getPersistedQueryHash(
  operationName: HashName,
): Promise<string> {
  const cached = _cached[operationName];
  if (cached) return cached;

  // Tier 1 — env override. Treats the env var as authoritative on
  // cold start; the only way to leave it is via `invalidateHash()`,
  // which the pathfinder client calls when 400 PERSISTED_QUERY_NOT_FOUND
  // proves the env hash is stale. After invalidation we fall through
  // to bundle scraping for the live value.
  const envHash = envHashFor(operationName);
  if (envHash && /^[a-f0-9]{64}$/.test(envHash)) {
    _cached[operationName] = envHash;
    // eslint-disable-next-line no-console
    console.log(
      `[spotify hash-resolver] Using env override for "${operationName}" ` +
        `(${envHash.slice(0, 8)}…)`,
    );
    return envHash;
  }

  const inflight = _inflight[operationName];
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const html = await fetchText(SPOTIFY_HOMEPAGE, FETCH_HEADERS_HOMEPAGE());
      let scriptUrls = extractScriptUrls(html, SCRIPT_SRC_RE);

      if (scriptUrls.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          '[spotify hash-resolver] Tag-anchored regex matched zero scripts; ' +
            'falling back to "any Spotify .js URL" loose match.',
        );
        scriptUrls = extractScriptUrls(html, ANY_JS_RE);
      }

      if (scriptUrls.length === 0) {
        // eslint-disable-next-line no-console
        console.error(
          '[spotify hash-resolver] No bundle URLs found on ' +
            `${SPOTIFY_HOMEPAGE} — HTML length: ${html.length} chars. ` +
            `First 200 chars: ${JSON.stringify(html.slice(0, 200))}`,
        );
        throw new ScrapeFailedError(
          'No Spotify bundle URLs found in homepage HTML. ' +
            'Set SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH env var to the value ' +
            'captured from DevTools → Network → any pathfinder request → ' +
            'request body extensions.persistedQuery.sha256Hash, OR check ' +
            'whether SPOTIFY_BOT_SP_DC is valid (we send it on the homepage ' +
            'fetch to get the authenticated SPA HTML).',
        );
      }

      // eslint-disable-next-line no-console
      console.log(
        `[spotify hash-resolver] Walking ${scriptUrls.length} bundle(s) for ` +
          `"${operationName}" hash`,
      );

      const hashPatterns = buildHashRe(operationName);
      let bundlesScanned = 0;
      let bundlesFailedFetch = 0;

      for (const url of scriptUrls) {
        let js: string;
        try {
          js = await fetchText(url, FETCH_HEADERS_BUNDLE);
        } catch {
          bundlesFailedFetch += 1;
          continue;
        }
        bundlesScanned += 1;
        for (const re of hashPatterns) {
          const m = js.match(re);
          if (m && m[1]) {
            // eslint-disable-next-line no-console
            console.log(
              `[spotify hash-resolver] Hash for "${operationName}" found in ` +
                `${url} after scanning ${bundlesScanned} bundle(s)`,
            );
            _cached[operationName] = m[1];
            return m[1];
          }
        }
      }

      // eslint-disable-next-line no-console
      console.error(
        `[spotify hash-resolver] No hash found for "${operationName}" ` +
          `across ${bundlesScanned}/${scriptUrls.length} bundle(s) ` +
          `(${bundlesFailedFetch} failed to fetch). ` +
          'Bundle reformat or operation renamed — set ' +
          'SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH env var as a workaround ' +
          'and update buildHashRe patterns when you have time.',
      );
      throw new ScrapeFailedError(
        `Persisted-query hash not found for "${operationName}" in any of ` +
          `${scriptUrls.length} Spotify bundles. Set ` +
          'SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH env var to the value ' +
          'from DevTools as a workaround.',
      );
    } finally {
      delete _inflight[operationName];
    }
  })();

  _inflight[operationName] = promise;
  return promise;
}

export function invalidateHash(operationName: HashName): void {
  _cached[operationName] = null;
}

async function fetchText(url: string, headers: HeadersInit): Promise<string> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new ScrapeFailedError(
      `${url} → ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}

function extractScriptUrls(html: string, re: RegExp): string[] {
  const urls: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  return Array.from(new Set(urls));
}
