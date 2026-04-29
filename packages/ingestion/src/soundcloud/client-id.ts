// Phase 5.6.2 — SoundCloud `client_id` resolver.
//
// SC's api-v2 endpoints (the JSON ones backing the modern web app) all
// require a `client_id` query param. SC has never published a developer
// program for api-v2; the `client_id` is the same anonymous one their
// own front-end uses, and they rotate it occasionally. The canonical
// way to obtain it: scrape SC's homepage HTML, find a script bundle
// from `a-v2.sndcdn.com`, fetch it, regex out the literal `client_id`.
//
// Caching strategy: module-global memo. Hot in the same Node process
// (Vercel server-action warm starts; the Railway cron's single run).
// On 401/403 from any api-v2 call, the caller invalidates via
// `invalidateClientId()` and retries — this is the rotation recovery
// path the spec required.
//
// Why not env-var: rotates every ~1-3 months without warning. Hardcoding
// would mean a deploy each time. Pulling fresh on cold-start is cheap
// (one HTML fetch + one JS fetch, < 500ms typical) and self-healing.

import { ScrapeFailedError } from './types.js';

let _cached: string | null = null;
let _inflight: Promise<string> | null = null;

const SC_HOMEPAGE = 'https://soundcloud.com/';
// Match all script tags pointing at SC's CDN — there are ~5-10 in the
// homepage HTML; only one or two contain the literal we need, so we
// fetch in document order and short-circuit on first hit.
const SCRIPT_SRC_RE =
  /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
// SC's bundler emits this exact shape. Looks fragile because it is —
// if SC reformats, the regex update goes here. We've verified the
// pattern as of 2026-04 against multiple bundle versions.
const CLIENT_ID_RE = /client_id\s*[:=]\s*"([a-zA-Z0-9_-]{20,})"/;

// Plain Record because packages/ingestion's tsconfig doesn't pull in
// DOM lib types — the apps/web copy uses `HeadersInit`. Functionally
// identical at the fetch() boundary; the type just narrows to a
// shape every fetch implementation accepts.
const FETCH_HEADERS: Record<string, string> = {
  // Mimic a real browser. SC's homepage gates a bare-curl request with
  // a Cloudflare interstitial. UA + Accept covers > 99% of cases.
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Resolve a usable `client_id`. Cached for the lifetime of the Node
 * process. Concurrent callers during the first miss share a single
 * in-flight promise (no thundering-herd of homepage fetches).
 */
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

      // Try each script in document order. The `client_id` is usually
      // in the first or second bundle (SC's main vendor chunk), but
      // their split-points shift across releases — fall through.
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

/**
 * Drop the cached `client_id`. Call when an api-v2 request returns
 * 401/403 — the cached id has likely been rotated. Caller should refetch
 * via `getClientId()` and retry the original request once.
 */
export function invalidateClientId(): void {
  _cached = null;
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
  // Reset regex lastIndex defensively; module-level regex objects with
  // /g state can leak between calls.
  SCRIPT_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_SRC_RE.exec(html)) !== null) {
    if (m[1]) urls.push(m[1]);
  }
  // De-dupe while preserving order — same bundle can appear twice
  // across <link rel="preload"> + <script>, etc.
  return Array.from(new Set(urls));
}
