// Orchestrator: run one or more scrapers → normalize each event → log status.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scraper, ScrapeRunResult, RawEvent } from './types.js';
import { upsertEvent } from './normalizer.js';

const __filename = fileURLToPath(import.meta.url);
const STATUS_MD = path.resolve(__filename, '../../STATUS.md');

export interface RunSummary {
  source: string;
  runAt: string;
  eventsFound: number;
  eventsInserted: number;
  eventsUpdated: number;
  errors: string[];
}

async function appendStatus(summary: RunSummary): Promise<void> {
  const row = [
    summary.runAt,
    summary.source,
    `${summary.eventsFound} (${summary.eventsInserted} new / ${summary.eventsUpdated} updated)`,
    summary.errors.length > 0
      ? summary.errors.join(' | ').replace(/\|/g, '\\|')
      : '—',
  ];
  const line = `| ${row.join(' | ')} |\n`;

  try {
    const existing = await fs.readFile(STATUS_MD, 'utf8');
    // Insert right after the header row (first 5 lines of the markdown).
    const lines = existing.split('\n');
    const headerEnd = lines.findIndex((l) => l.startsWith('| ---'));
    if (headerEnd === -1) {
      await fs.appendFile(STATUS_MD, line, 'utf8');
    } else {
      lines.splice(headerEnd + 1, 0, line.trimEnd());
      await fs.writeFile(STATUS_MD, lines.join('\n'), 'utf8');
    }
  } catch {
    // best-effort
  }
}

export async function runScraper(scraper: Scraper): Promise<RunSummary> {
  const runAt = new Date().toISOString();
  const errors: string[] = [];
  let events: RawEvent[] = [];
  let eventsInserted = 0;
  let eventsUpdated = 0;

  try {
    events = await scraper.scrape();
  } catch (err) {
    errors.push(`scrape: ${(err as Error).message}`);
  }

  for (const ev of events) {
    try {
      const result = await upsertEvent(ev);
      if (result.inserted) eventsInserted++;
      else eventsUpdated++;
    } catch (err) {
      errors.push(`event ${ev.sourceId}: ${(err as Error).message}`);
    }
  }

  const summary: RunSummary = {
    source: scraper.source,
    runAt,
    eventsFound: events.length,
    eventsInserted,
    eventsUpdated,
    errors,
  };
  await appendStatus(summary);
  return summary;
}

export async function runAll(scrapers: Scraper[]): Promise<RunSummary[]> {
  const results: RunSummary[] = [];
  for (const scraper of scrapers) {
    const summary = await runScraper(scraper);
    results.push(summary);
  }
  return results;
}

// Also export for tests.
export { appendStatus as _appendStatus };

// Keep the old ScrapeRunResult type usable by legacy callers.
export type { ScrapeRunResult };
