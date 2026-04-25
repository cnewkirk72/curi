// Popularity discovery — Phase 4f.
//
// Standalone SoundCloud + Bandcamp follower lookup with a homonym
// guard. Used when the enrichment path didn't already call Firecrawl
// (i.e. tier-1/tier-2 artists whose genres resolved from training or
// web search). The popularity ranker needs follower counts regardless
// of how we classified the artist, so this is the fallback.
//
// Algorithm, per platform:
//   1. Exa neural search scoped to soundcloud.com (or bandcamp.com),
//      returning up to 3 candidate profile URLs.
//   2. Homonym guard: reject candidates whose URL slug doesn't overlap
//      with the artist's normalized name slug. This is the critical
//      step — common names ("John Smith", "Sunset") land on random
//      unrelated SoundCloud accounts without a guard, confidently
//      polluting the popularity data.
//   3. If a candidate passes, Firecrawl-scrape it for follower count
//      and canonical URL. A Firecrawl 404 on the guessed URL is
//      treated as a soft miss — we keep the URL but leave followers
//      null.
//
// Platform order: SoundCloud first (where most of Curi's catalog
// lives), Bandcamp only as fallback when SC returns nothing. Running
// both every time would double the Firecrawl cost without meaningful
// uplift — the rare artist on both platforms will have SC populated
// and that's sufficient for the popularity tier.

import { findProfileUrls } from './exa.js';
import { fetchArtistSelfTags } from './firecrawl.js';

export interface PopularityResult {
  /** True when we made at least one external call. When false, the
   *  caller decided the artist didn't warrant discovery (e.g. folk
   *  act with no plausible SC presence). */
  attempted: boolean;
  soundcloudUrl?: string | null;
  soundcloudFollowers?: number | null;
  /** og:image avatar from the SoundCloud profile (i1.sndcdn.com).
   *  Captured opportunistically from the same Firecrawl scrape — used
   *  to backfill `artists.soundcloud_image_url` as a fallback for
   *  `spotify_image_url` in the lineup avatar projection. */
  soundcloudImageUrl?: string | null;
  bandcampUrl?: string | null;
  bandcampFollowers?: number | null;
  /** og:image avatar from the Bandcamp profile (f4.bcbits.com).
   *  Same role as soundcloudImageUrl, one tier down the cascade. */
  bandcampImageUrl?: string | null;
  /** URLs consulted during discovery — useful for post-run audit. */
  sources: string[];
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractSlug(url: string): string | null {
  let m = url.match(/soundcloud\.com\/([^/?#]+)/i);
  if (m) return normalize(m[1]!);
  m = url.match(/https?:\/\/([^.]+)\.bandcamp\.com/i);
  if (m) return normalize(m[1]!);
  return null;
}

/**
 * Reject candidates whose URL slug doesn't overlap with the artist's
 * normalized name slug. Substring match in either direction handles
 * common variations ("theblaze" ⊂ "the-blaze-official" and vice
 * versa). Slugs under 3 chars are rejected as too weak a signal —
 * "jk" or "ab" match almost anything.
 */
function isSlugMatch(artistName: string, url: string): boolean {
  const nameSlug = normalize(artistName);
  const urlSlug = extractSlug(url);
  if (!nameSlug || !urlSlug || nameSlug.length < 3 || urlSlug.length < 3) {
    return false;
  }
  if (urlSlug === nameSlug) return true;
  return urlSlug.includes(nameSlug) || nameSlug.includes(urlSlug);
}

async function tryPlatform(
  artistName: string,
  platform: 'soundcloud' | 'bandcamp',
): Promise<{ url: string; followers: number | null; imageUrl: string | null } | null> {
  let candidates;
  try {
    candidates = await findProfileUrls(artistName, platform, 3);
  } catch {
    return null;
  }
  const matched = candidates.filter((c) => isSlugMatch(artistName, c.url));
  if (matched.length === 0) return null;

  // Scrape every slug-matching candidate so we can pick the highest-
  // follower one. Common-handle squatters tend to share the slug with
  // the real artist (e.g. soundcloud.com/dbbd squatter @ 19 followers
  // vs the real DBBD at soundcloud.com/playdbbd @ 15.3k). Returning
  // the first slug match — Exa's neural-rank winner — let the squatter
  // win on short handles. Ranking by follower count breaks the tie
  // toward the real artist. Bounded at 3 candidates per platform, so
  // worst-case Firecrawl cost is 3x the previous single scrape.
  const scraped = await Promise.all(
    matched.map(async (cand) => {
      try {
        const r = await fetchArtistSelfTags(cand.url, 3);
        return {
          url: r.canonicalUrl ?? cand.url,
          followers: r.followers ?? null,
          imageUrl: r.imageUrl ?? null,
        };
      } catch {
        // Firecrawl failed (404, timeout, etc). Keep the URL but no
        // follower count — the monthly popularity cron can retry. A
        // failed scrape sorts behind any successful scrape, so we
        // only fall back to it if every candidate failed.
        return {
          url: cand.url,
          followers: null as number | null,
          imageUrl: null as string | null,
        };
      }
    }),
  );

  // Highest follower count wins. Null/unknown counts treated as -1 so
  // any verified count beats an unverified one, but the candidate
  // ordering is otherwise stable on Exa's neural rank for ties.
  scraped.sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1));
  return scraped[0] ?? null;
}

/**
 * Look up popularity for an artist across SoundCloud then Bandcamp.
 * Returns a PopularityResult with URL + follower count per platform
 * (or null). Never throws — any lookup failure resolves to nulls
 * with attempted=true so the orchestrator can record
 * popularity_discovery_failed_at and move on.
 */
export async function discoverPopularity(
  artistName: string,
): Promise<PopularityResult> {
  const sources: string[] = [];
  const sc = await tryPlatform(artistName, 'soundcloud');
  let bc: { url: string; followers: number | null; imageUrl: string | null } | null = null;
  if (!sc) {
    bc = await tryPlatform(artistName, 'bandcamp');
  }

  if (sc?.url) sources.push(sc.url);
  if (bc?.url) sources.push(bc.url);

  return {
    attempted: true,
    soundcloudUrl: sc?.url ?? null,
    soundcloudFollowers: sc?.followers ?? null,
    soundcloudImageUrl: sc?.imageUrl ?? null,
    bandcampUrl: bc?.url ?? null,
    bandcampFollowers: bc?.followers ?? null,
    bandcampImageUrl: bc?.imageUrl ?? null,
    sources,
  };
}
