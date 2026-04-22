// Phase 4f.5 — targeted Spotify retry.
//
// Re-runs the Spotify Client Credentials search for artists whose
// previous pass hit the rate-limit wall and left them marked
// `spotify_discovery_failed_at IS NOT NULL` without a resolved
// `spotify_url`. No LLM, no Firecrawl — this is spotify-only.
//
// Selection criteria:
//   spotify_discovery_failed_at IS NOT NULL
//   AND spotify_url IS NULL
//   AND last_enriched_at IS NOT NULL
//
// (The `last_enriched_at IS NOT NULL` guard keeps us from picking up
// brand-new artists that still need the full backfill pass — those
// should go through `pnpm backfill` instead.)
//
// Behavior on each artist:
//   - Match found (high/medium): write spotify_id/url/followers/popularity
//     /image_url + spotify_checked_at; clear spotify_discovery_failed_at.
//   - No confirmed match or soft-null: re-stamp spotify_discovery_failed_at
//     to `now` so subsequent retries can age-prioritize.
//   - Hard error (rate-limit cap reached, network): leave the row alone
//     and log — we'll catch it on the next monthly refresh.
//
// Concurrency defaults to 4 with the spotify.ts MIN_INTERVAL_MS=100ms
// throttle. The file-level note in spotify.ts mentions bumping to
// 400ms interval / concurrency 4 when the quota is tight — override
// via --concurrency if you want to be even more conservative.
//
// Usage:
//   pnpm --filter @curi/ingestion spotify-retry \
//     [--concurrency 4] \
//     [--limit N] \
//     [--dry-run]

import type { Database } from './db-types.js';
import { supabase } from './supabase.js';
import {
  searchArtistOnSpotify,
  type SpotifyArtistMatch,
} from './spotify.js';

type ArtistUpdate = Database['public']['Tables']['artists']['Update'];

const DEFAULT_CONCURRENCY = 4;
const PAGE_SIZE = 1000;
const LOOKUP_TIMEOUT_MS = 15_000;

interface Args {
  concurrency: number;
  limit: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let concurrency = DEFAULT_CONCURRENCY;
  let limit: number | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--concurrency') concurrency = Number(argv[++i]);
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--dry-run') dryRun = true;
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    concurrency = DEFAULT_CONCURRENCY;
  }
  return { concurrency, limit, dryRun };
}

interface Artist {
  id: string;
  name: string;
}

// Paginated load of candidate artists. Mirrors backfill-run's
// .range() discipline — Supabase's JS client silently caps
// unpaginated selects at 1000 rows.
async function loadCandidates(limit: number | null): Promise<Artist[]> {
  const client = supabase();
  const all: Artist[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select('id, name')
      .not('spotify_discovery_failed_at', 'is', null)
      .is('spotify_url', null)
      .not('last_enriched_at', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Artist[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (limit !== null && all.length >= limit) break;
  }
  return limit !== null ? all.slice(0, limit) : all;
}

// Wrap the spotify call in a 15s timeout — same guard the backfill
// uses to keep a stalled lookup from freezing the pool.
async function lookupWithTimeout(
  name: string,
): Promise<SpotifyArtistMatch | null> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`spotify lookup timeout after ${LOOKUP_TIMEOUT_MS}ms`)),
      LOOKUP_TIMEOUT_MS,
    ),
  );
  return Promise.race([searchArtistOnSpotify(name), timeout]);
}

interface PerArtistOutcome {
  id: string;
  name: string;
  status: 'matched' | 'no_match' | 'error';
  confidence?: 'high' | 'medium' | 'low';
  error?: string;
}

async function processArtist(
  artist: Artist,
  dryRun: boolean,
): Promise<PerArtistOutcome> {
  let match: SpotifyArtistMatch | null = null;
  try {
    match = await lookupWithTimeout(artist.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: artist.id, name: artist.name, status: 'error', error: message };
  }

  const now = new Date().toISOString();
  const client = supabase();

  if (match && match.confidence !== 'low') {
    if (dryRun) {
      return {
        id: artist.id,
        name: artist.name,
        status: 'matched',
        confidence: match.confidence,
      };
    }
    const payload: ArtistUpdate = {
      spotify_id: match.spotifyId,
      spotify_url: match.spotifyUrl,
      spotify_checked_at: now,
      // Clearing the failure stamp is the whole point of a retry run.
      // Without this the row still looks "failed" in ops queries even
      // after a successful re-match.
      spotify_discovery_failed_at: null,
    };
    if (Number.isFinite(match.followers)) payload.spotify_followers = match.followers;
    if (Number.isFinite(match.popularity)) payload.spotify_popularity = match.popularity;
    if (match.imageUrl) payload.spotify_image_url = match.imageUrl;

    const { error } = await client
      .from('artists')
      .update(payload)
      .eq('id', artist.id);
    if (error) {
      return { id: artist.id, name: artist.name, status: 'error', error: error.message };
    }
    return { id: artist.id, name: artist.name, status: 'matched', confidence: match.confidence };
  }

  // No confirmed match (either null or low-confidence fuzzy). Re-stamp
  // the failure so the age-based prioritization in the monthly refresh
  // knows this row has been retried recently.
  if (!dryRun) {
    const { error } = await client
      .from('artists')
      .update({ spotify_discovery_failed_at: now } as ArtistUpdate)
      .eq('id', artist.id);
    if (error) {
      return { id: artist.id, name: artist.name, status: 'error', error: error.message };
    }
  }
  return { id: artist.id, name: artist.name, status: 'no_match' };
}

// Tiny concurrency pool — mirrors backfill-run's shape but without
// the JSON checkpoint machinery (the retry set is small enough that
// a full re-run on crash is fine).
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
  console.log(
    `spotify-retry: concurrency=${args.concurrency} limit=${args.limit ?? 'none'} dry-run=${args.dryRun}`,
  );

  const candidates = await loadCandidates(args.limit);
  console.log(`found ${candidates.length} candidate artists`);
  if (candidates.length === 0) {
    console.log('nothing to do — exiting.');
    return;
  }

  const tallies = { matched: 0, no_match: 0, error: 0 };
  const startedAt = Date.now();

  await runPool(candidates, args.concurrency, async (artist, i) => {
    const outcome = await processArtist(artist, args.dryRun);
    tallies[outcome.status] += 1;
    const prefix = `[${i + 1}/${candidates.length}]`;
    if (outcome.status === 'matched') {
      console.log(`${prefix} matched (${outcome.confidence}): ${artist.name}`);
    } else if (outcome.status === 'no_match') {
      console.log(`${prefix} no match: ${artist.name}`);
    } else {
      console.log(`${prefix} ERROR: ${artist.name} — ${outcome.error}`);
    }
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\ndone in ${elapsedSec}s — matched=${tallies.matched} no_match=${tallies.no_match} error=${tallies.error}`,
  );
  if (args.dryRun) console.log('(dry-run — no DB writes were performed)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
