// Firecrawl REST client. Used in Phase 4's tier-3 self-tag fallback
// where the target is a SoundCloud or Bandcamp profile page and we
// want the artist-authored hashtags aggregated into a ranked list.
//
// Firecrawl's /v1/scrape with `extract` format does the heavy lifting
// server-side: we give it a prompt + JSON schema, it scrapes the
// page and runs its own LLM pass to pull structured data. One call
// yields profile-level genre, bio, aggregated per-track tags, AND
// follower count + canonical URL for popularity capture (Phase 4f).
//
// We prefer this over rolling our own HTML parse because SoundCloud's
// markup shifts and parsing it ourselves (Playwright + selectors) is
// the kind of brittle work Firecrawl was built to absorb.
//
// Exception: the og:image meta tag. Phase 4f.1 originally asked the
// Firecrawl LLM to read og:image alongside the rest, and that pass
// returned a uniform deprecated `avatars-000NNNNNNN-...` numeric URL
// format that 404s across i1.sndcdn.com today (the LLM either
// hallucinated or pulled stale snapshot data). The og:image is in the
// static profile-page HTML — no JS render needed, no auth — so we now
// fetch the page directly and regex the meta tag ourselves. Costs
// ~0 (one outbound GET) and is far more reliable than the LLM.

import { env } from './env.js';

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const OG_IMAGE_TIMEOUT_MS = 10_000;
const OG_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CDN_ALLOW_RE = /^https:\/\/(i\d*\.sndcdn\.com|f\d+\.bcbits\.com)\//i;

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

// ── public API ──────────────────────────────────────────────

export interface SelfTagsResult {
  /** Genre-style hashtags aggregated across recent tracks, ranked by frequency. */
  tags: string[];
  /** Artist's bio paragraph, or null when absent. */
  bio: string | null;
  /** The profile-level genre field (SoundCloud exposes this), or null. */
  profileGenre: string | null;
  /** Total followers/fans exposed on the profile page, or null when
   *  the number wasn't visible. SoundCloud shows "followers";
   *  Bandcamp shows "fans" — we treat them interchangeably as a
   *  popularity signal. */
  followers: number | null;
  /** Canonical profile URL as the page reports it (Firecrawl reads it
   *  from the og:url / canonical link). Null when the page didn't
   *  surface one. Used for URL normalization across redirects. */
  canonicalUrl: string | null;
  /** Profile avatar URL pulled from `<meta property="og:image">` —
   *  SoundCloud serves these from i1.sndcdn.com, Bandcamp from
   *  f4.bcbits.com. Used as a fallback for `artists.spotify_image_url`
   *  in the lineup avatar projection. Null when the page didn't
   *  expose an og:image, the URL points outside the allow-listed
   *  CDNs, or our direct scrape failed (network/timeout). Sourced via
   *  scrapeOgImage() rather than Firecrawl's LLM extract — the LLM
   *  returned hallucinated/stale URLs in the deprecated numeric SC
   *  format. See header comment for context. */
  imageUrl: string | null;
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
      followers?: number | null;
      canonicalUrl?: string | null;
    };
    metadata?: {
      sourceURL?: string;
      url?: string;
    };
  };
  error?: string;
}

/**
 * Direct og:image scrape against a SoundCloud or Bandcamp profile.
 * Returns null on any failure mode (network error, non-2xx response,
 * missing meta tag, URL outside the allow-listed CDNs, or unreasonable
 * length). Both platforms include og:image in their static initial
 * HTML, so a single GET is sufficient — no JS render, no auth, no
 * rate-limit observed at the concurrency we use.
 */
async function scrapeOgImage(profileUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OG_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(profileUrl, {
      headers: {
        'User-Agent': OG_IMAGE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Match either attribute order; quote-style flexible. SC and BC
    // both use double-quoted property=og:image content="..." today,
    // but staying tolerant costs nothing.
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (!m || !m[1]) return null;
    const candidate = m[1].trim();
    if (candidate.length === 0 || candidate.length > 500) return null;
    if (!CDN_ALLOW_RE.test(candidate)) return null;
    return candidate;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract artist-authored tags + popularity from a SoundCloud or
 * Bandcamp profile. `limit` caps how many recent tracks the Firecrawl
 * LLM samples for per-track hashtags — keeps the credit cost bounded
 * (≈1 credit per scrape in our plan regardless of limit, but the
 * prompt stays focused and quality goes up with tighter scope).
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
        `From this artist profile, extract:\n` +
        `(1) the profile-level genre field value if one is shown,\n` +
        `(2) the artist's bio paragraph if present,\n` +
        `(3) the set of genre-style hashtags appearing on the artist's ` +
        `${limit} most recent tracks — aggregate across tracks, ` +
        `deduplicate case-insensitively, return ranked by frequency ` +
        `(most frequent first), include only music-genre or subgenre ` +
        `tags (exclude promotional hashtags, mood/emoji tags, and ` +
        `release-type tags),\n` +
        `(4) the total follower count (SoundCloud: followers number; ` +
        `Bandcamp: fans / supporters count) as an integer. Parse ` +
        `abbreviated numbers into raw integers: "12.5K" → 12500, ` +
        `"1,234" → 1234, "3.1M" → 3100000. Return null if not visible.\n` +
        `(5) the canonical profile URL as displayed on the page (check ` +
        `<link rel="canonical"> or og:url meta tag).`,
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
          followers: {
            type: ['integer', 'null'],
            description:
              'Total followers/fans as a raw integer, or null if not visible',
          },
          canonicalUrl: {
            type: 'string',
            description:
              'Canonical profile URL from the page, or empty string if none',
          },
        },
        required: ['tags'],
      },
    },
    onlyMainContent: true,
    waitFor: 1500,
  };

  // Run the Firecrawl extract and the og:image scrape in parallel —
  // they hit different hosts, share no state, and we always need both.
  // Serializing them would add ~200–800ms of latency for no gain.
  const [response, scrapedImageUrl] = await Promise.all([
    firecrawlFetch<FirecrawlScrapeResponse>('/scrape', body),
    scrapeOgImage(profileUrl),
  ]);

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

  // Follower count can come back as integer, null, or — occasionally —
  // as a stringified number Firecrawl didn't parse. Coerce defensively.
  let followers: number | null = null;
  const rawFollowers = extracted.followers;
  if (typeof rawFollowers === 'number' && Number.isFinite(rawFollowers) && rawFollowers >= 0) {
    followers = Math.round(rawFollowers);
  } else if (typeof rawFollowers === 'string') {
    const parsed = parseFirecrawlNumberString(rawFollowers);
    if (parsed !== null) followers = parsed;
  }

  const canonicalUrl =
    typeof extracted.canonicalUrl === 'string' && extracted.canonicalUrl.length > 0
      ? extracted.canonicalUrl
      : null;

  // imageUrl comes from scrapeOgImage above — already validated against
  // the CDN allow-list and length cap inside that helper. Null when the
  // direct scrape couldn't find or verify an og:image, in which case
  // the avatar projection cascades to the next platform (or initials).

  return {
    tags,
    bio: extracted.bio && extracted.bio.length > 0 ? extracted.bio : null,
    profileGenre:
      extracted.profileGenre && extracted.profileGenre.length > 0
        ? extracted.profileGenre
        : null,
    followers,
    canonicalUrl,
    imageUrl: scrapedImageUrl,
    sourceUrl:
      response.data.metadata?.sourceURL ??
      response.data.metadata?.url ??
      profileUrl,
  };
}

// Belt-and-suspenders: if Firecrawl's own LLM pass leaves a string like
// "12.5K" instead of parsing it to 12500, do the conversion client-side.
function parseFirecrawlNumberString(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '');
  const m = s.match(/^([\d.]+)\s*([km])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult);
}
