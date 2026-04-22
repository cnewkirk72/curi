// Phase 4f.6 — Spotify catch-up pass.
//
// Companion to spotify-retry.ts. Where retry handles "we tried, we failed,
// try again", this script handles "we never tried at all." Exposed as a
// distinct entry point because the selection criteria and semantic intent
// are different, even though the per-artist algorithm is identical.
//
// Why this exists: during the Phase 4f backfill, 529 artists got matched
// and 302 got stamped `spotify_discovery_failed_at` after the rate-limit
// burn. But between April 20–21 the runtime ingestion pipeline added ~732
// new artists that were MB-enriched on the fly (last_enriched_at stamped)
// but never sent to Spotify — the Spotify pass is a batch job, not a
// runtime hop, and it hadn't been re-run since Phase 4f closed. Those rows
// are invisible to spotify-retry (it only picks up `failed_at IS NOT NULL`).
//
// Selection criteria:
//   last_enriched_at IS NOT NULL         — real artists, MB-touched
//   AND spotify_url IS NULL              — no match yet
//   AND spotify_checked_at IS NULL       — Spotify was never called on them
//   AND spotify_discovery_failed_at IS NULL — and never recorded as failed
//
// The third and fourth conjuncts are what distinguishes this from retry.
//
// Behavior on each artist — same as spotify-retry:
//   - Match found (high/medium): write spotify_id/url/followers/popularity
//     /image_url + spotify_checked_at; leave spotify_discovery_failed_at
//     null (it's already null by selection).
//   - No confirmed match: stamp spotify_discovery_failed_at = now. This
//     moves the row into the retry pool — next time we run spotify-retry
//     (e.g. next month) the age-based prioritization will pick it up again.
//   - Skipped (event_title / noise / too short): log reason, no DB writes.
//     These shouldn't be in the artists table at all; surface for cleanup.
//   - Hard error (rate-limit cap, network): leave the row unchanged. It
//     will still be a catchup candidate next run — no state to reconcile.
//
// Concurrency defaults to 4 with the spotify.ts MIN_INTERVAL_MS=100ms
// throttle, matching the retry script's posture. At the current throughput
// (~0.6s per artist), a 1,000-row catchup takes ~10 min.
//
// Usage:
//   pnpm --filter @curi/ingestion spotify-catchup \
//     [--concurrency 4] \
//     [--limit N] \
//     [--dry-run]

import type { Database } from './db-types.js';
import { supabase } from './supabase.js';
import {
  searchArtistOnSpotify,
  type SpotifyArtistMatch,
} from './spotify.js';
import { classifyArtistName } from './artist-parsing.js';

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

// Scene-disambiguator patterns — same set as spotify-retry. If these start
// drifting between the two scripts, extract to a shared module. For now the
// duplication is tolerable (one source of drift, not ten).
//
//   - COUNTRY_CODE_SUFFIX   : " (US)", " (UK)", " (DE)", " (FR)" — 2–4 caps
//   - ALPHA_DISAMBIGUATOR   : lowercase word-in-parens that isn't stripped
//                             upstream (" (duo)", " (solo)")
//   - TRAILING_DIGITS       : " 04", " 2024" — scraper ID leakage
//   - TRAILING_UNDERSCORE   : "OTO__" — cosmetic source styling
const COUNTRY_CODE_SUFFIX = /\s*\([A-Z]{2,4}\)\s*$/;
const ALPHA_DISAMBIGUATOR = /\s*\([a-z]{2,10}\)\s*$/;
const TRAILING_DIGITS = /\s+\d+\s*$/;
const TRAILING_UNDERSCORE = /_+\s*$/;

function stripDisambiguator(name: string): string {
  let s = name;
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(COUNTRY_CODE_SUFFIX, '')
      .replace(ALPHA_DISAMBIGUATOR, '')
      .replace(TRAILING_DIGITS, '')
      .replace(TRAILING_UNDERSCORE, '')
      .trim();
    if (s === before) break;
  }
  return s;
}

function buildQueryCandidates(rawName: string, cleaned: string): string[] {
  const candidates: string[] = [];
  const stripped = stripDisambiguator(cleaned);
  if (stripped && stripped.length >= 2) candidates.push(stripped);
  if (cleaned && cleaned !== stripped && cleaned.length >= 2) {
    candidates.push(cleaned);
  }
  if (rawName && rawName !== cleaned && rawName !== stripped) {
    candidates.push(rawName);
  }
  return Array.from(new Set(candidates));
}

// Paginated load of catch-up candidates. Same pagination pattern as retry;
// the difference is the WHERE clause.
async function loadCandidates(limit: number | null): Promise<Artist[]> {
  const client = supabase();
  const all: Artist[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select('id, name')
      .not('last_enriched_at', 'is', null)
      .is('spotify_url', null)
      .is('spotify_checked_at', null)
      .is('spotify_discovery_failed_at', null)
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
  status: 'matched' | 'no_match' | 'skipped' | 'error';
  confidence?: 'high' | 'medium' | 'low';
  matchedQuery?: string;
  spotifyName?: string;
  skipReason?: string;
  error?: string;
}

async function processArtist(
  artist: Artist,
  dryRun: boolean,
): Promise<PerArtistOutcome> {
  const classification = classifyArtistName(artist.name);
  if (!classification.valid) {
    return {
      id: artist.id,
      name: artist.name,
      status: 'skipped',
      skipReason: classification.reason ?? 'invalid',
    };
  }

  const candidates = buildQueryCandidates(artist.name, classification.cleaned);
  let match: SpotifyArtistMatch | null = null;
  let matchedQuery: string | undefined;
  for (const q of candidates) {
    let hit: SpotifyArtistMatch | null = null;
    try {
      hit = await lookupWithTimeout(q);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: artist.id, name: artist.name, status: 'error', error: message };
    }
    if (hit && hit.confidence !== 'low') {
      match = hit;
      matchedQuery = q;
      break;
    }
  }

  const now = new Date().toISOString();
  const client = supabase();

  if (match) {
    if (dryRun) {
      return {
        id: artist.id,
        name: artist.name,
        status: 'matched',
        confidence: match.confidence,
        matchedQuery,
        spotifyName: match.name,
      };
    }
    const payload: ArtistUpdate = {
      spotify_id: match.spotifyId,
      spotify_url: match.spotifyUrl,
      spotify_checked_at: now,
      // failed_at is already null by selection, but set it explicitly to
      // make the success path self-documenting.
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
    return {
      id: artist.id,
      name: artist.name,
      status: 'matched',
      confidence: match.confidence,
      matchedQuery,
      spotifyName: match.name,
    };
  }

  // First-time no-match: stamp failed_at so this row enters the retry
  // pool next cycle. Age-based prioritization in the monthly refresh will
  // re-test it alongside the rest of the retry set.
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
    `spotify-catchup: concurrency=${args.concurrency} limit=${args.limit ?? 'none'} dry-run=${args.dryRun}`,
  );

  const candidates = await loadCandidates(args.limit);
  console.log(`found ${candidates.length} never-attempted artist(s)`);
  if (candidates.length === 0) {
    console.log('nothing to do — the gap is closed. exiting.');
    return;
  }

  const tallies = { matched: 0, no_match: 0, skipped: 0, error: 0 };
  const startedAt = Date.now();

  await runPool(candidates, args.concurrency, async (artist, i) => {
    const outcome = await processArtist(artist, args.dryRun);
    tallies[outcome.status] += 1;
    const prefix = `[${i + 1}/${candidates.length}]`;
    if (outcome.status === 'matched') {
      const mapping =
        outcome.matchedQuery && outcome.matchedQuery !== artist.name
          ? ` [via "${outcome.matchedQuery}" → Spotify "${outcome.spotifyName ?? '?'}"]`
          : '';
      console.log(
        `${prefix} matched (${outcome.confidence}): ${artist.name}${mapping}`,
      );
    } else if (outcome.status === 'no_match') {
      console.log(`${prefix} no match: ${artist.name}`);
    } else if (outcome.status === 'skipped') {
      console.log(
        `${prefix} skipped (${outcome.skipReason}): ${artist.name}`,
      );
    } else {
      console.log(`${prefix} ERROR: ${artist.name} — ${outcome.error}`);
    }
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\ndone in ${elapsedSec}s — matched=${tallies.matched} no_match=${tallies.no_match} skipped=${tallies.skipped} error=${tallies.error}`,
  );
  if (tallies.no_match > 0) {
    console.log(
      `note: ${tallies.no_match} row(s) now have spotify_discovery_failed_at stamped — they're in the retry pool for the next spotify-retry run.`,
    );
  }
  if (tallies.skipped > 0) {
    console.log(
      `note: ${tallies.skipped} row(s) were skipped as event_title/noise — these should be flagged for cleanup; they aren't real artists.`,
    );
  }
  if (args.dryRun) console.log('(dry-run — no DB writes were performed)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
