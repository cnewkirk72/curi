// Phase 4f.1.1 — repair pass for soundcloud_image_url.
//
// The original backfill-avatars.ts run captured og:image via Firecrawl's
// LLM extract. The LLM returned URLs in the deprecated
// `avatars-000XXXXXXX-XXXXXX-tNNNxNNN.jpg` numeric format. SoundCloud
// has rotated to a base64-style identifier
// (`avatars-KqLDTziKPSoSZukC-e1UoxA-t500x500.jpg`); the old numeric URLs
// 404 across i1.sndcdn.com today. Of the 410 SC URLs we wrote, ~273
// match the dead numeric pattern and the rest are a mix of correct new
// IDs and `artworks-...` track-cover URLs the LLM picked off the wrong
// meta tag. Net: most of the SC avatar column is dead links and the
// lineup avatars stay on initials in prod.
//
// This script does a clean re-scrape using the cheapest possible
// method: direct GET against the public profile page, regex out
// `<meta property="og:image" content="...">`. SoundCloud profile pages
// are publicly served, no auth, no rate-limit visible at low
// concurrency, and the og:image is in the static initial HTML — no JS
// render needed (so no Playwright, no Firecrawl, no LLM credit). Cost
// is ~0; we just pay outbound bandwidth.
//
// Per-artist algorithm:
//   1. GET soundcloud_url with a Mozilla UA, follow redirects.
//   2. Regex og:image; reject if missing or not on i1.sndcdn.com /
//      i.sndcdn.com (defensive — same allow-list firecrawl.ts uses).
//   3. HEAD-validate the new URL. If it 200s, write to DB. If it 404s
//      (or any non-200) AND the saved URL also 404s, null out the
//      column — better to fall through to initials than keep a dead
//      link that slows the lineup render with retries.
//   4. On profile-page failure (404, network error, etc.), null the
//      column. Profile is gone or moved; LLM-cached URL definitely
//      isn't recoverable from it.
//
// We re-scrape ALL 410 rather than only the dead numeric format
// because (a) the cost is the same single curl, (b) `artworks-`-prefixed
// URLs are also wrong, (c) even the new-format URLs we already have
// could be stale, and (d) one canonical pass beats three pattern-based
// branches.
//
// Bandcamp f4.bcbits.com URLs are not touched — spot-checked 7/7 alive
// and the LLM extraction worked correctly there.
//
// Usage:
//   pnpm --filter @curi/ingestion repair-sc-images \
//     --green-light \           # actually write (default is dry-run)
//     --hotlink \               # explicit ack of hot-link policy (required)
//     [--concurrency 4] \
//     [--limit N]

import type { Database } from './db-types.js';
import { supabase } from './supabase.js';

type ArtistUpdate = Database['public']['Tables']['artists']['Update'];

const DEFAULT_CONCURRENCY = 4;
const PAGE_SIZE = 1000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface Args {
  concurrency: number;
  limit: number | null;
  greenLight: boolean;
  hotlink: boolean;
}

function parseArgs(argv: string[]): Args {
  let concurrency = DEFAULT_CONCURRENCY;
  let limit: number | null = null;
  let greenLight = false;
  let hotlink = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--concurrency') concurrency = Number(argv[++i]);
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--green-light') greenLight = true;
    else if (a === '--hotlink') hotlink = true;
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    concurrency = DEFAULT_CONCURRENCY;
  }
  return { concurrency, limit, greenLight, hotlink };
}

interface Candidate {
  id: string;
  name: string;
  soundcloud_url: string;
  current_image_url: string;
}

async function loadCandidates(limit: number | null): Promise<Candidate[]> {
  const client = supabase();
  const all: Candidate[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select('id, name, soundcloud_url, soundcloud_image_url')
      .not('soundcloud_image_url', 'is', null)
      .not('soundcloud_url', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      id: string;
      name: string;
      soundcloud_url: string | null;
      soundcloud_image_url: string | null;
    }>;
    for (const r of rows) {
      if (!r.soundcloud_url || !r.soundcloud_image_url) continue;
      all.push({
        id: r.id,
        name: r.name,
        soundcloud_url: r.soundcloud_url,
        current_image_url: r.soundcloud_image_url,
      });
    }
    if (rows.length < PAGE_SIZE) break;
    if (limit !== null && all.length >= limit) break;
  }
  return limit !== null ? all.slice(0, limit) : all;
}

// Same allow-list firecrawl.ts uses — defends against og:image pointing
// at a non-CDN URL (e.g. the profile-page itself if SC ever served a
// page-as-image card). Length cap is sanity.
const SC_CDN_RE = /^https:\/\/i\d*\.sndcdn\.com\//i;

async function fetchOgImage(profileUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(profileUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Match content="..." or content='...' to be robust to either
    // quote style — SoundCloud uses double quotes today, but cheap to
    // stay flexible.
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (!m || !m[1]) return null;
    const candidate = m[1].trim();
    if (candidate.length === 0 || candidate.length > 500) return null;
    if (!SC_CDN_RE.test(candidate)) return null;
    return candidate;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function headOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

interface Outcome {
  id: string;
  name: string;
  status: 'replaced' | 'kept' | 'nulled' | 'error';
  oldUrl?: string;
  newUrl?: string | null;
  error?: string;
}

async function processArtist(
  candidate: Candidate,
  dryRun: boolean,
): Promise<Outcome> {
  const fresh = await fetchOgImage(candidate.soundcloud_url);

  // Decision matrix:
  //   fresh found + valid    → replace (covers stale → fresh, even when
  //                            old URL also happened to work)
  //   fresh missing/invalid  → null the column (profile gone or no
  //                            og:image; better than a dead link on the
  //                            client)
  // We do NOT "keep" the existing URL silently — if the page-scrape
  // can't find an og:image we can't trust the legacy value either. The
  // monthly refresh cron will retry and re-populate when SC becomes
  // reachable again.

  if (!fresh) {
    if (!dryRun) {
      const client = supabase();
      const { error } = await client
        .from('artists')
        .update({ soundcloud_image_url: null } as ArtistUpdate)
        .eq('id', candidate.id);
      if (error) {
        return {
          id: candidate.id,
          name: candidate.name,
          status: 'error',
          oldUrl: candidate.current_image_url,
          error: error.message,
        };
      }
    }
    return {
      id: candidate.id,
      name: candidate.name,
      status: 'nulled',
      oldUrl: candidate.current_image_url,
      newUrl: null,
    };
  }

  // If the freshly-scraped URL exactly matches what we already had, no
  // need to update — distinguish "kept" so the run summary makes the
  // already-correct cohort visible.
  if (fresh === candidate.current_image_url) {
    return {
      id: candidate.id,
      name: candidate.name,
      status: 'kept',
      oldUrl: candidate.current_image_url,
      newUrl: fresh,
    };
  }

  // HEAD-validate the fresh URL before committing — the og:image meta
  // tag occasionally points at an identifier that's about to expire
  // during a CDN purge window. If we can't verify it, prefer the safer
  // null. Cheap (HEAD only) and prevents writing a fresh-but-broken URL.
  const ok = await headOk(fresh);
  if (!ok) {
    if (!dryRun) {
      const client = supabase();
      const { error } = await client
        .from('artists')
        .update({ soundcloud_image_url: null } as ArtistUpdate)
        .eq('id', candidate.id);
      if (error) {
        return {
          id: candidate.id,
          name: candidate.name,
          status: 'error',
          oldUrl: candidate.current_image_url,
          error: error.message,
        };
      }
    }
    return {
      id: candidate.id,
      name: candidate.name,
      status: 'nulled',
      oldUrl: candidate.current_image_url,
      newUrl: null,
    };
  }

  if (!dryRun) {
    const client = supabase();
    const { error } = await client
      .from('artists')
      .update({ soundcloud_image_url: fresh } as ArtistUpdate)
      .eq('id', candidate.id);
    if (error) {
      return {
        id: candidate.id,
        name: candidate.name,
        status: 'error',
        oldUrl: candidate.current_image_url,
        error: error.message,
      };
    }
  }
  return {
    id: candidate.id,
    name: candidate.name,
    status: 'replaced',
    oldUrl: candidate.current_image_url,
    newUrl: fresh,
  };
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runOne = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        await worker(item, i);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[pool] worker threw on index ${i}: ${msg}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.greenLight;

  if (!args.hotlink) {
    console.error(
      'refusing to run without --hotlink. This script writes hot-linked\n' +
        'CDN URLs from i1.sndcdn.com to the artists table. Pass --hotlink\n' +
        'to acknowledge.',
    );
    process.exit(2);
  }

  console.log(
    `repair-sc-images: concurrency=${args.concurrency} limit=${
      args.limit ?? 'none'
    } dry-run=${dryRun} hotlink=${args.hotlink}`,
  );

  const candidates = await loadCandidates(args.limit);
  console.log(`found ${candidates.length} candidate(s) with non-null soundcloud_image_url`);
  if (candidates.length === 0) {
    console.log('nothing to do — exiting.');
    return;
  }

  const tallies = { replaced: 0, kept: 0, nulled: 0, error: 0 };
  const startedAt = Date.now();

  await runPool(candidates, args.concurrency, async (candidate, i) => {
    const outcome = await processArtist(candidate, dryRun);
    tallies[outcome.status] += 1;
    const prefix = `[${i + 1}/${candidates.length}]`;
    if (outcome.status === 'replaced') {
      console.log(`${prefix} repl: ${candidate.name} → ${outcome.newUrl}`);
    } else if (outcome.status === 'kept') {
      console.log(`${prefix} kept: ${candidate.name}`);
    } else if (outcome.status === 'nulled') {
      console.log(`${prefix} null: ${candidate.name} (was ${outcome.oldUrl})`);
    } else {
      console.log(`${prefix} ERROR: ${candidate.name} — ${outcome.error}`);
    }
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\ndone in ${elapsedSec}s — replaced=${tallies.replaced} kept=${tallies.kept} nulled=${tallies.nulled} error=${tallies.error}`,
  );
  if (dryRun) {
    console.log('(dry-run — no DB writes were performed; pass --green-light to commit)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
