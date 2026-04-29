// Phase 5.6.2 — SoundCloud `client_id` resolver.
//
// NOTE: This is a copy of packages/ingestion/src/soundcloud/client-id.ts.
// Both copies must stay in sync — see apps/web/src/lib/soundcloud/types.ts
// for the dual-copy rationale.
//
// SC's api-v2 endpoints (the JSON ones backing the modern web app) all
// require a `client_id` query param. SC has never published a developer
// program for api-v2; the `client_id` is the same anonymous one their
// own front-end uses, and they rotate it occasionally. Canonical way
// to obtain it: scrape SC's homepage HTML, find a script bundle from
// `a-v2.sndcdn.com`, fetch it, regex out the literal `client_id`.
//
// Caching: module-global memo. Hot in the same Node process — Vercel
// server-action warm starts share the cache across user clicks. On
// 401/403 from any api-v2 call, the caller invalidates via
// `invalidateClientId()` and retries. Self-healing rotation recovery.

import { ScrapeFailedError } from './types';

let _cached: string | null = null;
let _inflight: Promise<string> | null = null;

const SC_HOMEPAGE = 'https://soundcloud.com/';
const SCRIPT_SRC_RE =
  /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
const CLIENT_ID_RE = /client_id\s*[:=]\s*"([a-zA-Z0-9_-]{20,})"/;

const FETCH_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function getClientId(): Promise<string> {
  if (_cached) return _cached;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const html = await fetchText(SC_HOMEPAGE);
      const scriptUrls = extractScriptUrls(html);

      if (scriptUrls.length === 0) {
        throw new ScrapeFailedError(
          'No SC bundle script tags found in homepage HTML',
        );
      }

      for (const url of scriptUrls) {
        const js = await fetchText(url);
        const m = js.match(CLIENT_ID_RE);
        if (m && m[1]) {
          _cached = m[1];
          return _cached;
        }
      }

      throw new ScrapeFailedError(
        `client_id not found in any of ${scriptUrls.length} SC bundles`,
      );
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

export function invalidateClientId(): void {
  _cached = null;
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
