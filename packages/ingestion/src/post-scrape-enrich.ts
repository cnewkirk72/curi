// Post-scrape enrichment orchestrator — chains the full Spotify + LLM +
// popularity-discovery pipeline onto the daily Railway cron, immediately
// after `runAll(scrapers)` finishes in cli.ts.
//
// Why this exists
// ───────────────
// Before this module, the daily cron only ran MusicBrainz enrichment
// (via normalizer.ts → enrichArtistIfStale). That meant every newly
// scraped artist had MB tags but null spotify_url / soundcloud_url /
// bandcamp_url forever — Phase 5.6's SoundCloud-following ranking signal
// would have been gated on a one-shot human-triggered backfill instead
// of self-healing nightly.
//
// Cohort
// ──────
// We don't try to re-enrich every artist every night. The cohort is the
// minimum needed to keep upcoming-events ranking signals fresh:
//
//   artists in events.starts_at >= now()
//   AND (spotify_checked_at IS NULL OR popularity_checked_at IS NULL)
//
// Capped at INGEST_AUTO_ENRICH_LIMIT (default 100) per run so the cron
// stays well under any external API rate ceiling, and so a backlog
// doesn't blow up the nightly window. The next night picks up where
// this one left off — once spotify_checked_at and popularity_checked_at
// are populated, the artist is excluded from future cohorts.
//
// Concurrency
// ───────────
// Default 4 — lower than the one-shot backfill's 10 because we share
// Spotify/Anthropic/Exa/Firecrawl rate budgets with whatever else the
// user might be running, and a daily cron should be polite. Override
// via INGEST_AUTO_ENRICH_CONCURRENCY for one-off cron tunings.
//
// Failure model
// ─────────────
// Per-artist errors are caught and logged but do NOT fail the whole
// pass — enrichment is secondary to the scrape itself. The cron's
// process.exit(1) path is reserved for scrape errors, not enrichment
// hiccups (Spotify 429, Anthropic stall, Firecrawl timeout, etc.).
import { env } from './env.js';
import { supabase } from './supabase.js';
import {
  type Artist,
  type EnrichOptions,
  isLikelyEventTitle,
  loadEventContext,
  PAGE_SIZE,
  processArtist,
} from './enrich-artist.js';

export interface PostScrapeEnrichOptions extends EnrichOptions {
  /** Max artists to enrich in one run. Caps API spend per night. */
  limit?: number;
  /** Worker pool size. Default 4 — polite to external APIs. */
  concurrency?: number;
}

export interface PostScrapeEnrichSummary {
  attempted: number;
  ok: number;
  errored: number;
  stalled: number;
  spotifyConfirmed: number;
  popularityWithUrl: number;
  cohortRemaining: number;
  durationMs: number;
}

/**
 * Load the artist cohort that needs enrichment for upcoming events.
 *
 * SQL semantics:
 *   SELECT a.*  FROM artists a
 *   JOIN event_artists ea ON ea.artist_id = a.id
 *   JOIN events e ON e.id = ea.event_id
 *   WHERE e.starts_at >= now()
 *   AND (a.spotify_checked_at IS NULL OR a.popularity_checked_at IS NULL)
 *   ORDER BY a.id
 *   LIMIT N
 *
 * Implementation note: PostgREST's deeply-nested filter syntax is
 * fragile across embedded relationships, so we do this in two cheap
 * round-trips instead of one fragile join select:
 *   1. Fetch artist_ids linked to upcoming events (paginated).
 *   2. Fetch artist rows where id IN (…) AND needs-enrichment.
 */
async function loadCohort(limit: number): Promise<{
  cohort: Artist[];
  cohortRemaining: number;
}> {
  const client = supabase();
  const nowIso = new Date().toISOString();

  // ── Step 1: artist_ids linked to upcoming events ──────────────────
  const upcomingArtistIds = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('event_artists')
      .select('artist_id, events!inner(starts_at)')
      .gte('events.starts_at', nowIso)
      .order('artist_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<{ artist_id: string }>;
    for (const r of rows) upcomingArtistIds.add(r.artist_id);
    if (rows.length < PAGE_SIZE) break;
  }
  const ids = [...upcomingArtistIds];
  if (ids.length === 0) {
    return { cohort: [], cohortRemaining: 0 };
  }

  // ── Step 2: filter to artists that need enrichment ────────────────
  // Supabase's `.in()` filter has a practical URL-length cap. We chunk
  // at 500 ids per query — well under the typical 8KB query string
  // ceiling — and union the results client-side.
  const ID_CHUNK = 500;
  const candidates: Artist[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await client
      .from('artists')
      .select(
        'id, name, slug, mb_tags, last_enriched_at, soundcloud_url, bandcamp_url, spotify_checked_at, popularity_checked_at',
      )
      .in('id', slice)
      .or('spotify_checked_at.is.null,popularity_checked_at.is.null')
      .order('id', { ascending: true });
    if (error) throw error;
    candidates.push(...((data ?? []) as unknown as Artist[]));
  }

  // Triage filter: drop phantom-artist rows whose names look like event
  // or party titles (scraper title-parser leakage). Keeps the nightly
  // cron from burning Spotify/LLM/Firecrawl spend on rows that will
  // never resolve to a real artist. See isLikelyEventTitle() in
  // enrich-artist.ts for the patterns flagged.
  const eligible: Artist[] = [];
  let filteredCount = 0;
  for (const a of candidates) {
    if (isLikelyEventTitle(a.name).flagged) {
      filteredCount += 1;
    } else {
      eligible.push(a);
    }
  }
  if (filteredCount > 0) {
    console.log(
      `[curi-enrich] filtered ${filteredCount} likely event-title row(s) from cohort`,
    );
  }

  const cohortRemaining = eligible.length;
  // Stable order — id ASC — so a partial nightly window picks up
  // deterministically tomorrow.
  eligible.sort((a, b) => a.id.localeCompare(b.id));
  const cohort = eligible.slice(0, limit);
  return { cohort, cohortRemaining };
}

/**
 * Run a bounded enrichment pass over upcoming-event artists. Idempotent
 * — re-running on the same cohort is safe (commit only overwrites with
 * non-null values, timestamps prevent perpetual re-querying).
 */
export async function runPostScrapeEnrichment(
  opts: PostScrapeEnrichOptions = {},
): Promise<PostScrapeEnrichSummary> {
  const start = Date.now();
  const limit = opts.limit ?? env.autoEnrichLimit;
  const concurrency = opts.concurrency ?? env.autoEnrichConcurrency;
  const skipSpotify = opts.skipSpotify ?? false;
  const skipPopularity = opts.skipPopularity ?? false;

  console.log(
    `[curi-enrich] loading cohort (limit=${limit}, concurrency=${concurrency})…`,
  );
  const { cohort, cohortRemaining } = await loadCohort(limit);

  if (cohort.length === 0) {
    const durationMs = Date.now() - start;
    console.log(
      `[curi-enrich] nothing to enrich — every upcoming-event artist already has spotify_checked_at + popularity_checked_at. (${durationMs}ms)`,
    );
    return {
      attempted: 0,
      ok: 0,
      errored: 0,
      stalled: 0,
      spotifyConfirmed: 0,
      popularityWithUrl: 0,
      cohortRemaining: 0,
      durationMs,
    };
  }

  console.log(
    `[curi-enrich] enriching ${cohort.length}/${cohortRemaining} artist(s) ` +
      `(skipSpotify=${skipSpotify}, skipPopularity=${skipPopularity})`,
  );

  // Load event context once. Heavier than the cohort itself, but
  // amortized across all workers.
  const ctx = await loadEventContext();

  let cursor = 0;
  let ok = 0;
  let errored = 0;
  let stalled = 0;
  let spotifyConfirmed = 0;
  let popularityWithUrl = 0;

  const worker = async (workerId: number): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= cohort.length) break;
      const artist = cohort[idx];
      if (!artist) break;
      const result = await processArtist(artist, ctx, {
        skipSpotify,
        skipPopularity,
      });
      if (result.error) errored += 1;
      else if (result.stalled) stalled += 1;
      else ok += 1;
      if (
        result.spotify &&
        result.spotify.confidence !== 'low' &&
        result.spotifyAttempted
      ) {
        spotifyConfirmed += 1;
      }
      if (
        result.popularity?.attempted &&
        (result.popularity.soundcloudUrl || result.popularity.bandcampUrl)
      ) {
        popularityWithUrl += 1;
      }
      const tag = result.error ? 'ERR' : result.stalled ? 'STALL' : 'OK';
      const tier = result.tier ?? '—';
      const sp = result.spotify
        ? ` sp=${result.spotify.confidence}`
        : result.spotifyAttempted
          ? ' sp=—'
          : '';
      const pop = result.popularity?.attempted
        ? ` sc=${result.popularity.soundcloudUrl ? '✓' : '✗'} bc=${result.popularity.bandcampUrl ? '✓' : '✗'}`
        : '';
      const errSuffix = result.error ? ` · ${result.error}` : '';
      console.log(
        `[curi-enrich] [${idx + 1}/${cohort.length}] w${workerId} ${tag} ` +
          `${result.name} · ${(result.elapsedMs / 1000).toFixed(1)}s · ` +
          `tier=${tier}${sp}${pop}${errSuffix}`,
      );
    }
  };

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const durationMs = Date.now() - start;
  const remaining = Math.max(cohortRemaining - cohort.length, 0);
  console.log(
    `[curi-enrich] done — ok=${ok}, stalled=${stalled}, errored=${errored}, ` +
      `spotify=${spotifyConfirmed}/${cohort.length}, popularity=${popularityWithUrl}/${cohort.length}, ` +
      `remaining=${remaining}, ${(durationMs / 1000).toFixed(0)}s`,
  );

  return {
    attempted: cohort.length,
    ok,
    errored,
    stalled,
    spotifyConfirmed,
    popularityWithUrl,
    cohortRemaining: remaining,
    durationMs,
  };
}
