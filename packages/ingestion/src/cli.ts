#!/usr/bin/env node
// Phase-2 stub CLI. Full version lands alongside the first scraper.
// Usage (intended):
//   pnpm ingest --sources=all
//   pnpm ingest --sources=venue:public-records,shotgun
import 'dotenv/config';

function parseSources(argv: string[]): string[] {
  const arg = argv.find((a) => a.startsWith('--sources='));
  if (!arg) return ['all'];
  return arg.slice('--sources='.length).split(',').map((s) => s.trim());
}

async function main() {
  const sources = parseSources(process.argv.slice(2));
  console.log(`[curi-ingest] requested sources: ${sources.join(', ')}`);
  console.log('[curi-ingest] not yet implemented — Phase 2 (Checkpoint 1 must clear first).');
}

main().catch((err) => {
  console.error('[curi-ingest] fatal', err);
  process.exit(1);
});
