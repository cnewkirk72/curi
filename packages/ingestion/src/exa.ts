// Exa neural-search REST client. Direct fetch rather than exa-js so
// we're insulated from SDK churn and so the retry/throttle envelope
// stays uniform with musicbrainz.ts and firecrawl.ts.
//
// Two usage modes:
//   1. Web search — Claude calls this when training knowledge is thin
//      on an artist and it wants recent bio/press/RA context.
//   2. Domain-scoped profile search — `findProfileUrl` restricts
//      results to soundcloud.com or bandcamp.com so the tier-3
//      self-tag fetch has a concrete URL to hand to Firecrawl.

import { env } from './env.js';

const EXA_BASE = 'https://api.exa.ai';
const MIN_INTERVAL_MS = 200; // well under Exa's free-tier 10 req/s ceiling
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const now = Date.now();
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestAt));
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    lastRequestAt = Date.now();
    return task();
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

async function exaFetch<T>(path: string, body: unknown): Promise<T> {
  const key = env.exaApiKey;
  if (!key) {
    throw new Error('EXA_API_KEY is not set — Phase 4 enrichment is disabled.');
  }
  const url = `${EXA_BASE}${path}`;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return (await res.json()) as T;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${res.statusText}`;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `exa ${res.status} ${res.statusText} on ${path}: ${bodyText.slice(0, 300)}`,
    );
  }
  throw new Error(`exa exhausted retries on ${path}: ${lastErr}`);
}

// ── public API ──────────────────────────────────────────────────────

export interface ExaResult {
  title: string | null;
  url: string;
  publishedDate: string | null;
  snippet: string | null;
  text: string | null;
}

export interface ExaSearchOptions {
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeContents?: boolean;
  /** Max chars of text per result when includeContents is true. */
  maxCharsPerResult?: number;
  /** Exa search type. Default `neural` — best recall on underground tail. */
  type?: 'neural' | 'keyword' | 'auto';
}

interface ExaSearchResponse {
  results: Array<{
    title?: string | null;
    url: string;
    publishedDate?: string | null;
    snippet?: string | null;
    text?: string | null;
  }>;
}

/**
 * Neural search. When `includeContents=true` we request excerpted
 * page text inline (saves a follow-up /contents call).
 */
export async function searchExa(
  query: string,
  opts: ExaSearchOptions = {},
): Promise<ExaResult[]> {
  const body: Record<string, unknown> = {
    query,
    numResults: opts.numResults ?? 8,
    type: opts.type ?? 'neural',
  };
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
  if (opts.includeContents) {
    body.contents = {
      text: { maxCharacters: opts.maxCharsPerResult ?? 2000 },
    };
  }

  return throttled(async () => {
    const payload = await exaFetch<ExaSearchResponse>('/search', body);
    return (payload.results ?? []).map((r) => ({
      title: r.title ?? null,
      url: r.url,
      publishedDate: r.publishedDate ?? null,
      snippet: r.snippet ?? null,
      text: r.text ?? null,
    }));
  });
}

/**
 * Top-1 domain-scoped lookup. Returns null when nothing comes back.
 * Callers verify the profile (bio/city/genre cross-check vs event
 * context) before trusting it — generic names produce look-alike
 * profile hits and we don't want Firecrawl scraping the wrong artist.
 */
export async function findProfileUrl(
  artistName: string,
  platform: 'soundcloud' | 'bandcamp',
): Promise<ExaResult | null> {
  const domain = platform === 'soundcloud' ? 'soundcloud.com' : 'bandcamp.com';
  const results = await searchExa(`${artistName} ${platform} profile`, {
    numResults: 3,
    includeDomains: [domain],
    includeContents: false,
  });
  return results[0] ?? null;
}
