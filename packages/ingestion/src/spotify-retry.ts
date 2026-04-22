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
// Name-cleaning pipeline (added 2026-04-21 after the first sample run
// returned 20/20 no_match — every failure was a name-shape problem, not a
// Spotify-side miss):
//
//   1. classifyArtistName() from artist-parsing.ts
//      Filters out rows that should never have been searched at all —
//      event titles like "The 2016 Party: Party like it's 2016", noise
//      tokens like "secret guest", empty/too-short fragments. These get
//      a 'skipped' tally and zero DB writes; flag them for cleanup.
//
//   2. stripDisambiguator()
//      Scene-level disambiguators ("Hugo (US)", "Annicka 04", "OTO__")
//      don't exist on Spotify — Spotify just calls the artist "Hugo".
//      The exact-name filter in searchArtistOnSpotify compares via
//      normalizeForCompare (strip-everything-non-alphanumeric), so
//      "Hugo (US)" → "hugous" and Spotify's "Hugo" → "hugo" — never
//      match. Stripping the suffix before the search restores the
//      match. We try cleaned-first, then raw as a fallback in case the
//      "disambiguator" was actually part of the artist's real name.
//
// Behavior on each artist:
//   - Match found (high/medium): write spotify_id/url/followers/popularity
//     /image_url + spotify_checked_at; clear spotify_discovery_failed_at.
//   - No confirmed match or soft-null: re-stamp spotify_discovery_failed_at
//     to `now` so subsequent retries can age-prioritize.
//   - Skipped (event_title / noise / too short): log reason, no DB writes.
//     These shouldn't be in the artists table to begin with — surface
//     them for cleanup rather than silently re-stamping.
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

// Scene-disambiguator patterns observed in the 302-artist failure set.
// Each is anchored to the END of the string — we're stripping suffixes, not
// substrings, because a leading "(US)" would be suspicious enough to leave
// alone. Applied in a loop so combined suffixes ("OTO__ 04") collapse in
// one pass.
//
//   - COUNTRY_CODE_SUFFIX   : " (US)", " (UK)", " (DE)", " (FR)" — 2–4 caps
//   - ALPHA_DISAMBIGUATOR   : " (live)", " (dj)" were handled upstream by
//                             LIVE_TAG in artist-parsing; this catches the
//                             lowercase word-in-parens shape that slipped
//                             through (" (duo)", " (solo)").
//   - TRAILING_DIGITS       : " 04", " 2024" — scraper ID leakage.
//   - TRAILING_UNDERSCORE   : "OTO__" — cosmetic styling from the source page.
const COUNTRY_CODE_SUFFIX = /\s*\([A-Z]{2,4}\)\s*$/;
const ALPHA_DISAMBIGUATOR = /\s*\([a-z]{2,10}\)\s*$/;
const TRAILING_DIGITS = /\s+\d+\s*$/;
const TRAILING_UNDERSCORE = /_+\s*$/;

function stripDisambiguator(name: string): string {
  let s = name;
  // Up to 3 passes — covers "OTO__ 04 (US)" type stackings without looping
  // forever on a pathological input.
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

// Build an ordered list of query candidates to try against Spotify, most-
// specific first. Dedupes on the raw string so we never burn a second
// request on the same query. The raw name always comes last so we still
// try it verbatim in case the "disambiguator" was actually part of the
// real artist name (rare, but legit — e.g. a band whose stage name is
// literally "Foo 04").
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
  // Dedupe while preserving order.
  return Array.from(new Set(candidates));
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
  status: 'matched' | 'no_match' | 'skipped' | 'error';
  confidence?: 'high' | 'medium' | 'low';
  /** Query string that produced the match, when different from the raw name. */
  matchedQuery?: string;
  /** Spotify-side name of the matched artist, for eyeball verification. */
  spotifyName?: string;
  /** Reason we skipped (from classifyArtistName). */
  skipReason?: string;
  error?: string;
}

async function processArtist(
  artist: Artist,
  dryRun: boolean,
): Promise<PerArtistOutcome> {
  // Step 1: classify. Event titles and noise get dropped before we burn a
  // Spotify request. classifyArtistName also returns a cleaned version with
  // live tags / quoted blocks / orphan conjunctions stripped — we use that
  // as the input to stripDisambiguator instead of the raw name.
  const classification = classifyArtistName(artist.name);
  if (!classification.valid) {
    return {
      id: artist.id,
      name: artist.name,
      status: 'skipped',
      skipReason: classification.reason ?? 'invalid',
    };
  }

  // Step 2: build query candidates (stripped → cleaned → raw) and try them
  // in order. First high/medium match wins. We stop on the first hit so a
  // precise stripped-name match beats a noisier raw-name match.
  const candidates = buildQueryCandidates(artist.name, classification.cleaned);
  let match: SpotifyArtistMatch | null = null;
  let matchedQuery: string | undefined;
  for (const q of candidates) {
    let hit: SpotifyArtistMatch | null = null;
    try {
      hit = await lookupWithTimeout(q);
    } catch (err) {
      // Hard errors (rate-limit cap, network) abort this artist entirely —
      // trying another query shape won't help and burns quota. Leave the
      // row unchanged so the monthly refresh retries.
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
    return {
      id: artist.id,
      name: artist.name,
      status: 'matched',
      confidence: match.confidence,
      matchedQuery,
      spotifyName: match.name,
    };
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

  const tallies = { matched: 0, no_match: 0, skipped: 0, error: 0 };
  const startedAt = Date.now();

  await runPool(candidates, args.concurrency, async (artist, i) => {
    const outcome = await processArtist(artist, args.dryRun);
    tallies[outcome.status] += 1;
    const prefix = `[${i + 1}/${candidates.length}]`;
    if (outcome.status === 'matched') {
      // When the matched query differs from the raw DB name, surface the
      // mapping so a skim of the log reveals any "Hugo (US)" → mainstream-
      // Hugo style mismatches. Christian's review catches these; we don't
      // want silent wrong-artist writes.
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
