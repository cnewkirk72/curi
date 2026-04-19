// Firecrawl REST client. Used in Phase 4's tier-3 self-tag fallback
// where the target is a SoundCloud or Bandcamp profile page and we
// want the artist-authored hashtags aggregated into a ranked list.
//
// Firecrawl's /v1/scrape with `extract` format does the heavy lifting
// server-side: we give it a prompt + JSON schema, it scrapes the
// page and runs its own LLM pass to pull structured data. One call
// yields profile-level genre, bio, and aggregated per-track tags.
//
// We prefer this over rolling our own HTML parse because SoundCloud's
// markup shifts and parsing it ourselves (Playwright + selectors) is
// the kind of brittle work Firecrawl was built to absorb.

import { env } from './env.js';

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

async function firecrawlFetch<T>(path: string, body: unknown): Promise<T> {
  const key = env.firecrawlApiKey;
  if (!key) {
    throw new Error(
      'FIRECRAWL_API_KEY is not set — Phase 4 self-tag fallback is disabled.',
    );
  }
  const url = `${FIRECRAWL_BASE}${path}`;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 2) {
        throw new Error(`firecrawl network error on ${path}: ${msg}`);
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    clearTimeout(timeout);
    if (res.ok) {
      return (await res.json()) as T;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${res.statusText}`;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `firecrawl ${res.status} ${res.statusText} on ${path}: ${bodyText.slice(0, 300)}`,
    );
  }
  throw new Error(`firecrawl exhausted retries on ${path}: ${lastErr}`);
}

// ── public API ──────────────────────────────────────────────────────

export interface SelfTagsResult {
  /** Genre-style hashtags aggregated across recent tracks, ranked by frequency. */
  tags: string[];
  /** Artist's bio paragraph, or null when absent. */
  bio: string | null;
  /** The profile-level genre field (SoundCloud exposes this), or null. */
  profileGenre: string | null;
  /** Resolved source URL Firecrawl actually scraped. */
  sourceUrl: string;
}

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    extract?: {
      tags?: string[];
      bio?: string | null;
      profileGenre?: string | null;
    };
    metadata?: {
      sourceURL?: string;
      url?: string;
    };
  };
  error?: string;
}

/**
 * Extract artist-authored tags from a SoundCloud or Bandcamp profile.
 * `limit` caps how many recent tracks the Firecrawl LLM samples for
 * per-track hashtags — keeps the credit cost bounded (≈1 credit per
 * scrape in our plan regardless of limit, but the prompt stays
 * focused and quality goes up with tighter scope).
 */
export async function fetchArtistSelfTags(
  profileUrl: string,
  limit = 10,
): Promise<SelfTagsResult> {
  const body = {
    url: profileUrl,
    formats: ['extract'],
    extract: {
      prompt:
        `From this artist profile, extract (1) the profile-level genre field if one is shown, ` +
        `(2) the artist's bio paragraph if present, and (3) the set of genre-style hashtags ` +
        `appearing on the artist's ${limit} most recent tracks. Aggregate the hashtags across ` +
        `tracks, deduplicate case-insensitively, and return them ranked by frequency (most ` +
        `frequent first). Include only music-genre or subgenre tags — exclude promotional ` +
        `hashtags, mood/emoji tags, or release-type tags.`,
      schema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Genre hashtags ranked by frequency, most frequent first',
          },
          bio: {
            type: 'string',
            description: "The artist's bio paragraph, or empty string if none",
          },
          profileGenre: {
            type: 'string',
            description:
              'The profile-level genre field value, or empty string if none',
          },
        },
        required: ['tags'],
      },
    },
    onlyMainContent: true,
    waitFor: 1500,
  };

  const response = await firecrawlFetch<FirecrawlScrapeResponse>(
    '/scrape',
    body,
  );

  if (!response.success || !response.data) {
    throw new Error(
      `firecrawl scrape failed for ${profileUrl}: ${response.error ?? 'no data'}`,
    );
  }

  const extracted = response.data.extract ?? {};
  const rawTags = Array.isArray(extracted.tags) ? extracted.tags : [];
  // Defensive normalize — Firecrawl usually returns clean output but
  // occasionally leaves in '#' prefixes or stray whitespace.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of rawTags) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().replace(/^#/, '').toLowerCase();
    if (clean.length === 0 || seen.has(clean)) continue;
    seen.add(clean);
    tags.push(clean);
  }

  return {
    tags,
    bio: extracted.bio && extracted.bio.length > 0 ? extracted.bio : null,
    profileGenre:
      extracted.profileGenre && extracted.profileGenre.length > 0
        ? extracted.profileGenre
        : null,
    sourceUrl:
      response.data.metadata?.sourceURL ??
      response.data.metadata?.url ??
      profileUrl,
  };
}
