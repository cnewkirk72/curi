// Phase 4f backfill orchestrator.
//
// One-shot human-triggered driver for the full artist enrichment pass.
// The actual per-artist pipeline lives in ./enrich-artist.ts (extracted
// in Phase 5.6 prep so the daily cron in cli.ts can chain the same
// flow). This file owns the orchestration concerns the cron doesn't
// share: paginated cohort load, JSON checkpointing, summary stats.
//
// Per-artist flow (in enrich-artist.ts):
//
//   1. searchArtistOnSpotify — non-blocking, 15s timeout. Confirmed
//      hits feed prior evidence into the LLM context.
//   2. enrichArtistWithLLM — Sonnet 4.6 tool-use loop with prompt
//      caching + stall fallback (never throws).
//   3. Popularity fold-in — uses the LLM's Firecrawl capture if
//      available; else, for electronic acts, calls discoverPopularity
//      for a homonym-guarded SC/BC lookup. Includes the DBBD fix:
//      treats LLM-captured SC URLs with < 100 followers as suspicious
//      and re-runs domain-scoped discovery.
//   4. commitArtist — UPDATE artists with enrichment + Spotify + SC/BC
//      + tier + timestamps. Pass subgenres through resolveTags so
//      novel ones land under a parent in taxonomy_subgenres.
//
// Backfill-run-only:
//   - Paginated load of artists (default `WHERE last_enriched_at IS
//     NULL`, full table on `--force`).
//   - Optional `--limit` for dry runs.
//   - JSON checkpoint after every artist (crash-resumable).
//   - Verbose summary at the end (LLM confidence histogram, tier
//     distribution, flagged-for-review list).
//
// Usage:
//   pnpm --filter @curi/ingestion backfill \
//     [--concurrency 10] \
//     [--limit 1637] \
//     [--force] \
//     [--skip-popularity] \
//     [--skip-spotify] \
//     [--output /tmp/curi-backfill.json]

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type Artist,
  type ArtistLog,
  loadEventContext,
  PAGE_SIZE,
  processArtist,
} from './enrich-artist.js';
import { supabase } from './supabase.js';

const DEFAULT_CONCURRENCY = 10;

interface Args {
  concurrency: number;
  output: string;
  limit: number | null;
  force: boolean;
  skipPopularity: boolean;
  skipSpotify: boolean;
}

function parseArgs(argv: string[]): Args {
  let concurrency = DEFAULT_CONCURRENCY;
  let output = '';
  let limit: number | null = null;
  let force = false;
  let skipPopularity = false;
  let skipSpotify = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--concurrency') concurrency = Number(argv[++i]);
    else if (a === '--output') output = argv[++i] ?? '';
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--force') force = true;
    else if (a === '--skip-popularity') skipPopularity = true;
    else if (a === '--skip-spotify') skipSpotify = true;
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    concurrency = DEFAULT_CONCURRENCY;
  }
  if (!output) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    output = path.join('/tmp', `curi-backfill-${ts}.json`);
  }
  return { concurrency, output, limit, force, skipPopularity, skipSpotify };
}

/**
 * Paginated load of artists, filtered to unenriched by default. Uses
 * .range() because Supabase silently caps unpaginated selects at 1000
 * rows — a bug we hit during the 4e dry run and are not repeating.
 */
async function loadArtistsPaginated(force: boolean): Promise<Artist[]> {
  const client = supabase();
  const all: Artist[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let q = client
      .from('artists')
      .select(
        'id, name, slug, mb_tags, last_enriched_at, soundcloud_url, bandcamp_url',
      )
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (!force) q = q.is('last_enriched_at', null);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as unknown as Artist[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('Loading artists…');
  const allArtists = await loadArtistsPaginated(args.force);
  const artists = args.limit ? allArtists.slice(0, args.limit) : allArtists;
  console.log(
    `Loaded ${allArtists.length} artist${
      args.force ? 's total' : 's without enrichment'
    }${args.limit ? ` (limited to ${args.limit})` : ''}.`,
  );
  if (artists.length === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  console.log('Loading event context…');
  const ctx = await loadEventContext();
  console.log(
    `Loaded ${ctx.eventsByArtist.size} artists with events, ${ctx.artistsByEvent.size} events, ${ctx.nameById.size} artist names.`,
  );

  console.log(
    `\nStarting backfill: concurrency=${args.concurrency}, skipPopularity=${args.skipPopularity}, skipSpotify=${args.skipSpotify}`,
  );
  console.log(`Output: ${args.output}\n`);

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  const log: ArtistLog[] = [];
  const startedAt = new Date().toISOString();
  fs.writeFileSync(
    args.output,
    JSON.stringify({ startedAt, log: [] }, null, 2),
  );

  let cursor = 0;
  let done = 0;
  const total = artists.length;

  const worker = async (workerId: number): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= artists.length) break;
      const artist = artists[idx];
      // Defensive null guard — idx < artists.length implies artist
      // exists, but noUncheckedIndexedAccess makes TS require the check.
      if (!artist) break;
      const result = await processArtist(artist, ctx, {
        skipSpotify: args.skipSpotify,
        skipPopularity: args.skipPopularity,
      });
      log.push(result);
      done += 1;
      const tag = result.error ? 'ERR' : result.stalled ? 'STALL' : 'OK';
      const tier = result.tier ?? '—';
      const trace = result.enrichment?.toolTrace.join('→') ?? '';
      const sp = result.spotify
        ? ` sp=${result.spotify.confidence}:${result.spotify.popularity}/${result.spotify.followers}`
        : '';
      const pop =
        result.popularity?.attempted
          ? ` sc=${result.popularity.soundcloudFollowers ?? '—'}/${
              result.popularity.soundcloudUrl ? '✓' : '✗'
            } bc=${result.popularity.bandcampFollowers ?? '—'}/${
              result.popularity.bandcampUrl ? '✓' : '✗'
            }`
          : '';
      const errSuffix = result.error ? ` · ${result.error}` : '';
      console.log(
        `[${String(done).padStart(4, '0')}/${total}] w${workerId} ${tag} ` +
          `${result.name} · ${(result.elapsedMs / 1000).toFixed(1)}s · ` +
          `tier=${tier}${sp}${pop} · ${trace}${errSuffix}`,
      );

      // Checkpoint after every artist — crash-resumable.
      fs.writeFileSync(
        args.output,
        JSON.stringify({ startedAt, log }, null, 2),
      );
    }
  };

  const workers = Array.from({ length: args.concurrency }, (_, i) =>
    worker(i + 1),
  );
  await Promise.all(workers);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('Backfill summary');
  console.log('══════════════════════════════════════════════════════');
  const okCount = log.filter((r) => !r.error && !r.stalled).length;
  const stalledCount = log.filter((r) => r.stalled).length;
  const errCount = log.filter((r) => !!r.error).length;
  const totalElapsed = log.reduce((s, r) => s + r.elapsedMs, 0);
  console.log(
    `OK: ${okCount}  •  stalled: ${stalledCount}  •  errored: ${errCount}  •  total: ${total}`,
  );
  console.log(
    `Wall clock sum: ${(totalElapsed / 1000).toFixed(
      0,
    )}s  •  avg: ${(totalElapsed / Math.max(total, 1) / 1000).toFixed(
      1,
    )}s/artist`,
  );

  const popAttempted = log.filter((r) => r.popularity?.attempted).length;
  const popAnyUrl = log.filter(
    (r) =>
      r.popularity?.attempted &&
      (r.popularity.soundcloudUrl || r.popularity.bandcampUrl),
  ).length;
  const popAnyFollowers = log.filter(
    (r) =>
      r.popularity?.attempted &&
      (typeof r.popularity.soundcloudFollowers === 'number' ||
        typeof r.popularity.bandcampFollowers === 'number'),
  ).length;
  console.log(
    `Popularity: ${popAnyUrl}/${popAttempted} with URL, ${popAnyFollowers}/${popAttempted} with follower count`,
  );

  const spAttempted = log.filter((r) => r.spotify !== undefined).length;
  const spHighMed = log.filter(
    (r) => r.spotify && r.spotify.confidence !== 'low',
  ).length;
  const spWithGenres = log.filter(
    (r) =>
      r.spotify &&
      r.spotify.confidence !== 'low' &&
      r.spotify.genres.length > 0,
  ).length;
  console.log(
    `Spotify: ${spHighMed}/${spAttempted} confirmed matches, ${spWithGenres} with genres`,
  );

  // Raw LLM confidence — what the model self-reported (pre post-hoc).
  const llmConf = { high: 0, medium: 0, low: 0, 'very-low': 0 };
  // Derived tier — what actually got written to the DB.
  const dbTier = { high: 0, medium: 0, low: 0, 'very-low': 0 };
  for (const r of log) {
    if (r.enrichment) llmConf[r.enrichment.confidence] += 1;
    if (r.tier) dbTier[r.tier] += 1;
  }
  console.log(
    `LLM confidence: high=${llmConf.high}, medium=${llmConf.medium}, low=${llmConf.low}, very-low=${llmConf['very-low']}`,
  );
  console.log(
    `DB tier:        high=${dbTier.high}, medium=${dbTier.medium}, low=${dbTier.low}, very-low=${dbTier['very-low']}`,
  );

  const tierDist = { training: 0, search: 0, firecrawl: 0, error: 0 };
  for (const r of log) {
    if (r.error) {
      tierDist.error += 1;
      continue;
    }
    const t = r.enrichment?.toolTrace ?? [];
    if (t.includes('fetch_artist_self_tags')) tierDist.firecrawl += 1;
    else if (t.includes('search_web')) tierDist.search += 1;
    else tierDist.training += 1;
  }
  console.log(
    `Tier distribution: training=${tierDist.training}, search=${tierDist.search}, firecrawl=${tierDist.firecrawl}, error=${tierDist.error}`,
  );

  const flagged: Array<{ name: string; reasons: string[] }> = [];
  for (const r of log) {
    const reasons: string[] = [];
    if (r.stalled) reasons.push('stalled');
    if (r.error) reasons.push(`error: ${r.error}`);
    if (r.tier === 'very-low' && !r.stalled) {
      reasons.push('tier=very-low (no grounding + no tags)');
    }
    if (r.tier === 'low' && !r.stalled) {
      reasons.push('tier=low');
    }
    if (r.enrichment?.fuzzyMerges.length) {
      reasons.push(`${r.enrichment.fuzzyMerges.length} fuzzy merge(s)`);
    }
    if (reasons.length) flagged.push({ name: r.name, reasons });
  }
  if (flagged.length) {
    console.log(`\nFlagged for review (${flagged.length}):`);
    for (const f of flagged) {
      console.log(`  - ${f.name}: ${f.reasons.join('; ')}`);
    }
  }

  console.log(`\nFull transcript: ${args.output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
