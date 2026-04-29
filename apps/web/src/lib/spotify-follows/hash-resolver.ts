// Phase 5.7 — pathfinder persisted-query hash resolver.
//
// NOTE: Dual-copy of packages/ingestion/src/spotify-follows/hash-resolver.ts.
// See ./types.ts for the dual-copy rationale.

import { ScrapeFailedError } from './types';

const HASHES = {
  queryArtistsFollowed: null as string | null,
} as const;

type HashName = keyof typeof HASHES;
const _cached: Record<HashName, string | null> = { ...HASHES };
const _inflight: Partial<Record<HashName, Promise<string>>> = {};

const SPOTIFY_HOMEPAGE = 'https://open.spotify.com/';

// Match any <script src="..."> whose URL contains a Spotify-controlled
// substring (`spotify`, `scdn`, or `encore`) before the .js extension.
//
// The previous regex `(?:open|encore|encore-web)\.spotify[a-z]+\/` was
// too tight — it required a literal letter run between `.spotify` and
// the next `/`, but Spotify's primary CDN domain is
// `open.spotifycdn.com` where there's a `.com` after `cdn`, so the
// regex would backtrack and fail to match. Result: zero bundle URLs,
// scrape failed before ever hitting pathfinder.
//
// `i` flag added so any case variation (rare but possible across
// edge servers) still matches. The case-insensitive walk costs
// nothing on the small amount of homepage HTML we fetch.
const SCRIPT_SRC_RE =
  /<script[^>]+src="(https:\/\/[^"]*?(?:spotify|scdn|encore)[^"]*\.js)"/gi;

// Hash-extraction patterns. Spotify's webpack bundle ships the
// persisted-query metadata in a few different shapes depending on
// release / minification level:
//
//   { sha256Hash: "abc...", operationName: "queryArtistsFollowed" }     ← unquoted keys (minified)
//   {"sha256Hash":"abc...","operationName":"queryArtistsFollowed"}      ← quoted keys (devtool/sourcemap)
//   { operationName: "queryArtistsFollowed", ..., sha256Hash: "abc..." } ← reverse order
//
// Try strict quoted JSON first (lowest false-positive risk), then
// unquoted-key minified, then a relaxed fallback that just grabs any
// 64-hex literal within ~200 chars of the operation name.
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

const FETCH_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

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
        // eslint-disable-next-line no-console
        console.error(
          '[spotify hash-resolver] No bundle script tags found on ' +
            `${SPOTIFY_HOMEPAGE} — homepage HTML length: ${html.length} chars`,
        );
        throw new ScrapeFailedError(
          'No Spotify bundle script tags found in homepage HTML — ' +
            'CDN structure may have changed; update SCRIPT_SRC_RE in hash-resolver.ts',
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
          js = await fetchText(url);
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
                `${url} (after scanning ${bundlesScanned} bundle(s))`,
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
          'Bundle reformat or operation renamed — update buildHashRe patterns.',
      );
      throw new ScrapeFailedError(
        `Persisted-query hash not found for "${operationName}" in any of ` +
          `${scriptUrls.length} Spotify bundles — bundle reformatted ` +
          'or operation renamed',
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
  SCRIPT_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_SRC_RE.exec(html)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  return Array.from(new Set(urls));
}
