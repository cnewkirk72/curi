#!/usr/bin/env node
// Curi ingestion CLI.
//
// Usage:
//   pnpm ingest                                          # all default sources
//   pnpm ingest --sources=all
//   pnpm ingest --sources=venue:public-records
//   pnpm ingest --sources=venue:public-records,venue:nowadays
import 'dotenv/config';

import { env } from './env.js';
import { runAll, type RunSummary } from './runner.js';
import type { Scraper } from './types.js';
import { publicRecordsScraper } from './scrapers/venues/public-records.js';

// Registry of every scraper Curi knows about. Phase 2 adds public-records first;
// more sources land as they're built.
const REGISTRY: Record<string, Scraper> = {
  [publicRecordsScraper.source]: publicRecordsScraper,
};

function parseSources(argv: string[]): string[] {
  const arg = argv.find((a) => a.startsWith('--sources='));
  const raw = arg ? arg.slice('--sources='.length) : env.defaultSources;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
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

function printSummary(summary: RunSummary): void {
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

async function main() {
  const requested = parseSources(process.argv.slice(2));
  const scrapers = resolveScrapers(requested);

  console.log(
    `[curi-ingest] running ${scrapers.length} scraper(s): ` +
      scrapers.map((s) => s.source).join(', '),
  );
  const summaries = await runAll(scrapers);
  for (const s of summaries) printSummary(s);

  const hasErrors = summaries.some((s) => s.errors.length > 0);
  process.exit(hasErrors ? 1 : 0);
}

main().catch((err) => {
  console.error('[curi-ingest] fatal', err);
  process.exit(1);
});
