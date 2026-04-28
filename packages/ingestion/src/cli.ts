#!/usr/bin/env node
// Curi ingestion CLI — daily Railway cron entrypoint and dev-loop runner.
//
// Two-phase nightly run:
//   1. Scrape — runs every registered Scraper, normalizes events into
//      Supabase, applies inline MusicBrainz tags via normalizer.ts.
//   2. Enrich — runs a bounded full-pipeline pass (Spotify + LLM +
//      popularity-discovery) over artists in upcoming events that are
//      still missing spotify_checked_at or popularity_checked_at. See
//      post-scrape-enrich.ts.
//
// Phase 5.6 motivation
// ────────────────────
// Phase 5.6's SoundCloud-following ranking signal needs every upcoming
// artist to have a verified soundcloud_url. Without phase 2, the cron
// only ran MB enrichment, so newly-scraped artists sat at null SC/BC/SP
// fields indefinitely and required a one-shot human-triggered backfill
// to populate. Now the gap self-heals incrementally each night. Disable
// with INGEST_AUTO_ENRICH=false if external API budgets need a cut.
//
// Usage:
//   pnpm ingest                                  # all sources, then enrich
//   pnpm ingest --sources=all
//   pnpm ingest --sources=venue:public-records
//   pnpm ingest --sources=venue:public-records,venue:nowadays
//   pnpm ingest --no-enrich                      # scrape only, skip enrichment
//   pnpm ingest --enrich-limit=200               # raise per-run cap
//   pnpm ingest --skip-spotify                   # enrich pass skips Spotify
import 'dotenv/config';

import { env } from './env.js';
import { runAll, type RunSummary } from './runner.js';
import {
  runPostScrapeEnrichment,
  type PostScrapeEnrichSummary,
} from './post-scrape-enrich.js';
import type { Scraper } from './types.js';
import { publicRecordsScraper } from './scrapers/venues/public-records.js';
import { elsewhereScraper } from './scrapers/venues/elsewhere.js';
import { nowadaysScraper } from './scrapers/venues/nowadays.js';
import { raNycScraper } from './scrapers/aggregators/ra-nyc.js';

// Registry of every scraper Curi knows about.
//   Phase 2a: public-records
//   Phase 2b: elsewhere, nowadays, ra-nyc (aggregator, replaces planned
//             Shotgun source which is unreachable behind Vercel's bot gate)
const REGISTRY: Record<string, Scraper> = {
  [publicRecordsScraper.source]: publicRecordsScraper,
  [elsewhereScraper.source]: elsewhereScraper,
  [nowadaysScraper.source]: nowadaysScraper,
  [raNycScraper.source]: raNycScraper,
};

interface CliFlags {
  sources: string[];
  noEnrich: boolean;
  enrichLimit: number | null;
  enrichConcurrency: number | null;
  skipSpotify: boolean;
  skipPopularity: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  let sources: string[] = [];
  let noEnrich = false;
  let enrichLimit: number | null = null;
  let enrichConcurrency: number | null = null;
  let skipSpotify = false;
  let skipPopularity = false;

  let sourcesSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--sources=')) {
      sources = a
        .slice('--sources='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      sourcesSet = true;
    } else if (a === '--no-enrich') {
      noEnrich = true;
    } else if (a.startsWith('--enrich-limit=')) {
      const n = Number.parseInt(a.slice('--enrich-limit='.length), 10);
      if (Number.isFinite(n) && n > 0) enrichLimit = n;
    } else if (a.startsWith('--enrich-concurrency=')) {
      const n = Number.parseInt(a.slice('--enrich-concurrency='.length), 10);
      if (Number.isFinite(n) && n > 0) enrichConcurrency = n;
    } else if (a === '--skip-spotify') {
      skipSpotify = true;
    } else if (a === '--skip-popularity') {
      skipPopularity = true;
    }
  }

  if (!sourcesSet) {
    sources = env.defaultSources
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    sources,
    noEnrich,
    enrichLimit,
    enrichConcurrency,
    skipSpotify,
    skipPopularity,
  };
}

function resolveScrapers(sources: string[]): Scraper[] {
  if (sources.length === 0 || sources.includes('all')) {
    return Object.values(REGISTRY);
  }
  const resolved: Scraper[] = [];
  const missing: string[] = [];
  for (const s of sources) {
    const scraper = REGISTRY[s];
    if (scraper) resolved.push(scraper);
    else missing.push(s);
  }
  if (missing.length > 0) {
    throw new Error(
      `unknown sources: ${missing.join(', ')}. known: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return resolved;
}

function printScrapeSummary(summary: RunSummary): void {
  const status = summary.errors.length > 0 ? 'WITH ERRORS' : 'OK';
  console.log(
    `[${summary.source}] ${status} — ${summary.eventsFound} events ` +
      `(${summary.eventsInserted} new, ${summary.eventsUpdated} updated)`,
  );
  if (summary.errors.length > 0) {
    for (const err of summary.errors.slice(0, 10)) {
      console.log(`  ! ${err}`);
    }
    if (summary.errors.length > 10) {
      console.log(`  ! …and ${summary.errors.length - 10} more`);
    }
  }
}

function printEnrichSummary(summary: PostScrapeEnrichSummary): void {
  if (summary.attempted === 0) {
    console.log('[curi-enrich] no upcoming-event artists need enrichment');
    return;
  }
  console.log(
    `[curi-enrich] ok=${summary.ok}, stalled=${summary.stalled}, ` +
      `errored=${summary.errored}, spotify=${summary.spotifyConfirmed}, ` +
      `popularity-with-url=${summary.popularityWithUrl}, ` +
      `cohort-remaining=${summary.cohortRemaining}, ` +
      `${(summary.durationMs / 1000).toFixed(0)}s`,
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const scrapers = resolveScrapers(flags.sources);

  // ── Phase 1: scrape ───────────────────────────────────────────────
  console.log(
    `[curi-ingest] running ${scrapers.length} scraper(s): ` +
      scrapers.map((s) => s.source).join(', '),
  );
  const summaries = await runAll(scrapers);
  for (const s of summaries) printScrapeSummary(s);
  const scrapeHadErrors = summaries.some((s) => s.errors.length > 0);

  // ── Phase 2: enrich ───────────────────────────────────────────────
  // Decoupled from scrape exit code: enrichment failures (Spotify 429,
  // Anthropic stall, Firecrawl timeout) are operational noise that
  // shouldn't fail the cron. Only scrape errors trip exit(1).
  const enrichEnabled = !flags.noEnrich && env.autoEnrichEnabled;
  if (!enrichEnabled) {
    console.log(
      '[curi-ingest] enrichment disabled (--no-enrich or INGEST_AUTO_ENRICH=false)',
    );
  } else {
    try {
      const enrichSummary = await runPostScrapeEnrichment({
        limit: flags.enrichLimit ?? undefined,
        concurrency: flags.enrichConcurrency ?? undefined,
        skipSpotify: flags.skipSpotify,
        skipPopularity: flags.skipPopularity,
      });
      printEnrichSummary(enrichSummary);
    } catch (err) {
      // Enrichment is secondary — don't fail the whole cron if it blows up.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[curi-enrich] fatal: ${msg}`);
    }
  }

  process.exit(scrapeHadErrors ? 1 : 0);
}

main().catch((err) => {
  console.error('[curi-ingest] fatal', err);
  process.exit(1);
});
