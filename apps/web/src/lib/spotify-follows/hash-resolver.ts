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

const SCRIPT_SRC_RE =
  /<script[^>]+src="(https:\/\/[^"]*?(?:open|encore|encore-web)\.spotify[a-z]+\/[^"]+\.js)"/g;

function buildHashRe(operationName: string): RegExp[] {
  const op = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(
      `"sha256Hash"\\s*:\\s*"([a-f0-9]{64})"[^}]{0,100}"operationName"\\s*:\\s*"${op}"`,
    ),
    new RegExp(
      `"operationName"\\s*:\\s*"${op}"[^}]{0,100}"sha256Hash"\\s*:\\s*"([a-f0-9]{64})"`,
    ),
    new RegExp(`"${op}"[\\s\\S]{0,200}?"([a-f0-9]{64})"`),
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
        throw new ScrapeFailedError(
          'No Spotify bundle script tags found in homepage HTML',
        );
      }

      const hashPatterns = buildHashRe(operationName);

      for (const url of scriptUrls) {
        let js: string;
        try {
          js = await fetchText(url);
        } catch {
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
          `${scriptUrls.length} Spotify bundles`,
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
