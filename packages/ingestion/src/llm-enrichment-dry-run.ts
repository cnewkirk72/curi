// Phase 4e dry run — enrich a stratified sample of artists from the
// live DB without writing anything back.
//
// Usage:
//   pnpm --filter @curi/ingestion dry-run \
//     [--size 25] \
//     [--extra "artist1,artist2"] \
//     [--output /tmp/curi-dry-run.json]
//
// Sampling is stratified by expected escalation tier so every code path
// gets exercised:
//   - tier 1: mb_tags non-empty              → training/search-only likely
//   - tier 2: no mb_tags, event at a venue with default_genres/vibes
//                                              → search + maybe firecrawl
//   - tier 3: neither                         → firecrawl-heavy underground
//
// For each sampled artist the script loads their most recent event +
// venue defaults + co-billed artist names as EnrichmentContext. Results
// stream to stdout one row at a time; the full JSON (with toolTrace +
// fuzzyMerges) is rewritten to the output file after each row so a crash
// mid-run leaves a partial transcript behind instead of losing
// everything.
//
// No DB writes. Novel tags / confidence / tier mismatches are flagged in
// the final summary for Christian review — per the preference for
// surfacing uncertain inclusions rather than silently including them.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  enrichArtistWithLLM,
  type EnrichmentContext,
  type EnrichmentResult,
} from './llm-enrichment.js';
import { supabase } from './supabase.js';

// ── Arg parsing ───────────────────────────────────────────────────────

interface Args {
  size: number;
  extras: string[];
  output: string;
  tier1: number;
  tier2: number;
  tier3: number;
}

function parseArgs(argv: string[]): Args {
  let size = 25;
  let extras: string[] = [];
  let output = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--size') size = Number(argv[++i]);
    else if (a === '--extra') {
      const raw = argv[++i] ?? '';
      extras = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--output') output = argv[++i] ?? '';
  }
  if (!Number.isFinite(size) || size <= 0) {
    console.error('error: --size must be a positive number');
    process.exit(1);
  }
  // Default 8/9/8 split at size=25; scale proportionally otherwise and
  // assign the remainder to tier-3 so the underground bucket is never
  // starved.
  const tier1 = Math.max(1, Math.floor((size * 8) / 25));
  const tier2 = Math.max(1, Math.floor((size * 9) / 25));
  const tier3 = Math.max(1, size - tier1 - tier2);
  if (!output) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    output = path.join('/tmp', `curi-dry-run-${ts}.json`);
  }
  return { size, extras, output, tier1, tier2, tier3 };
}

// ── Types ─────────────────────────────────────────────────────────────

interface Artist {
  id: string;
  name: string;
  slug: string;
  mb_tags: Array<{ name: string; count?: number }> | null;
}

interface VenueRow {
  slug: string | null;
  default_genres: string[] | null;
  default_vibes: string[] | null;
}

interface EventRow {
  id: string;
  title: string | null;
  starts_at: string;
  venues: VenueRow | VenueRow[] | null;
}

interface EventArtistRow {
  artist_id: string;
  event_id: string;
  events: EventRow | EventRow[] | null;
}

// Supabase sometimes returns belongsTo relations as arrays and
// sometimes as objects depending on its cardinality inference. Normalize.
function asOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

// ── Helpers ───────────────────────────────────────────────────────────

function inferTier(trace: string[]): '1-training' | '2-search' | '3-firecrawl' {
  if (trace.includes('fetch_artist_self_tags')) return '3-firecrawl';
  if (trace.includes('search_web')) return '2-search';
  return '1-training';
}

function classifyTier(
  artist: Artist,
  eventsByArtist: Map<string, EventRow[]>,
): 1 | 2 | 3 {
  const hasMb = Array.isArray(artist.mb_tags) && artist.mb_tags.length > 0;
  if (hasMb) return 1;
  const events = eventsByArtist.get(artist.id) ?? [];
  const hasVenueSignal = events.some((e) => {
    const v = asOne(e.venues);
    const g = v?.default_genres?.length ?? 0;
    const vb = v?.default_vibes?.length ?? 0;
    return g > 0 || vb > 0;
  });
  return hasVenueSignal ? 2 : 3;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function formatSummaryRow(
  idx: number,
  total: number,
  name: string,
  expectedTier: 1 | 2 | 3,
  result: EnrichmentResult,
  elapsedMs: number,
): string {
  const actual = inferTier(result.toolTrace);
  const divergence =
    (expectedTier === 1 && actual !== '1-training') ||
    (expectedTier === 2 && actual === '3-firecrawl') ||
    (expectedTier === 3 && actual === '1-training')
      ? ' ⚠'
      : '';
  const genres = result.genres.join(', ') || '—';
  const subs = result.subgenres.slice(0, 4).join(', ') || '—';
  const vibes = result.vibes.join(', ') || '—';
  const fuzzy = result.fuzzyMerges.length
    ? `    fuzzy: ${result.fuzzyMerges.map((m) => `${m.proposed}→${m.merged}(d${m.distance})`).join(', ')}`
    : '';
  const lines = [
    `[${String(idx).padStart(2, '0')}/${total}] ${name}${divergence}`,
    `    tier: expected=${expectedTier} actual=${actual}  •  conf=${result.confidence}  •  ${(elapsedMs / 1000).toFixed(1)}s`,
    `    genres:    ${genres}`,
    `    subgenres: ${subs}`,
    `    vibes:     ${vibes}`,
    fuzzy,
    `    trace: ${result.toolTrace.join(' → ') || '(none)'}`,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────

interface PerArtistLog {
  name: string;
  slug: string;
  expectedTier: 1 | 2 | 3;
  actualTier: string;
  elapsedMs: number;
  context: EnrichmentContext;
  result?: EnrichmentResult;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = supabase();

  console.log('Loading artists…');
  const { data: artistsData, error: artistsErr } = await client
    .from('artists')
    .select('id, name, slug, mb_tags');
  if (artistsErr) throw artistsErr;
  const artists = (artistsData ?? []) as unknown as Artist[];

  console.log('Loading event_artists + events + venues…');
  const { data: eaData, error: eaErr } = await client
    .from('event_artists')
    .select(
      'artist_id, event_id, events!inner(id, title, starts_at, venues(slug, default_genres, default_vibes))',
    );
  if (eaErr) throw eaErr;
  const eaRows = (eaData ?? []) as unknown as EventArtistRow[];

  // Build lookup maps.
  const eventsByArtist = new Map<string, EventRow[]>();
  const artistsByEvent = new Map<string, string[]>();
  for (const row of eaRows) {
    const ev = asOne(row.events);
    if (!ev) continue;
    if (!eventsByArtist.has(row.artist_id)) eventsByArtist.set(row.artist_id, []);
    eventsByArtist.get(row.artist_id)!.push(ev);
    if (!artistsByEvent.has(row.event_id)) artistsByEvent.set(row.event_id, []);
    artistsByEvent.get(row.event_id)!.push(row.artist_id);
  }
  const nameById = new Map(artists.map((a) => [a.id, a.name] as const));

  // Partition into tiers.
  const tier1Pool: Artist[] = [];
  const tier2Pool: Artist[] = [];
  const tier3Pool: Artist[] = [];
  for (const a of artists) {
    const tier = classifyTier(a, eventsByArtist);
    if (tier === 1) tier1Pool.push(a);
    else if (tier === 2) tier2Pool.push(a);
    else tier3Pool.push(a);
  }
  console.log(
    `Pool: tier1=${tier1Pool.length}, tier2=${tier2Pool.length}, tier3=${tier3Pool.length}`,
  );

  // Extract --extra artists from the pools so they don't double-count.
  const extrasLower = new Set(args.extras.map((s) => s.toLowerCase()));
  const extraSelected: Artist[] = [];
  for (const pool of [tier1Pool, tier2Pool, tier3Pool]) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (extrasLower.has(pool[i].name.toLowerCase())) {
        extraSelected.push(pool[i]);
        pool.splice(i, 1);
      }
    }
  }
  const missingExtras = args.extras.filter(
    (n) => !extraSelected.some((a) => a.name.toLowerCase() === n.toLowerCase()),
  );
  if (missingExtras.length) {
    console.error(
      `warning: --extra names not found in artists table: ${missingExtras.join(', ')}`,
    );
  }

  // Draw the sample.
  const sampled: Array<{ artist: Artist; expectedTier: 1 | 2 | 3 }> = [];
  sampled.push(
    ...shuffle(tier1Pool)
      .slice(0, Math.min(args.tier1, tier1Pool.length))
      .map((artist) => ({ artist, expectedTier: 1 as const })),
  );
  sampled.push(
    ...shuffle(tier2Pool)
      .slice(0, Math.min(args.tier2, tier2Pool.length))
      .map((artist) => ({ artist, expectedTier: 2 as const })),
  );
  sampled.push(
    ...shuffle(tier3Pool)
      .slice(0, Math.min(args.tier3, tier3Pool.length))
      .map((artist) => ({ artist, expectedTier: 3 as const })),
  );
  for (const a of extraSelected) {
    sampled.push({ artist: a, expectedTier: classifyTier(a, eventsByArtist) });
  }

  const total = sampled.length;
  console.log(
    `Sample: ${args.tier1}t1 + ${args.tier2}t2 + ${args.tier3}t3 + ${extraSelected.length} extras = ${total} artists`,
  );
  console.log(`Output: ${args.output}\n`);

  // Prep output dir.
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  const startedAt = new Date().toISOString();
  fs.writeFileSync(
    args.output,
    JSON.stringify({ startedAt, sampled: [] }, null, 2),
  );

  const log: PerArtistLog[] = [];

  for (let i = 0; i < sampled.length; i++) {
    const { artist, expectedTier } = sampled[i];

    // Build context from most recent event.
    const events = (eventsByArtist.get(artist.id) ?? [])
      .filter((e) => !!e && !!e.starts_at)
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
    const mostRecent = events[0];

    const context: EnrichmentContext = { eventCity: 'NYC' };
    if (artist.mb_tags && artist.mb_tags.length) {
      context.existingMbTags = artist.mb_tags
        .map((t) => t.name)
        .filter((n): n is string => !!n);
    }
    if (mostRecent) {
      const venue = asOne(mostRecent.venues);
      if (venue) {
        context.venueDefaults = {
          genres: venue.default_genres ?? [],
          vibes: venue.default_vibes ?? [],
        };
      }
      const coArtists = (artistsByEvent.get(mostRecent.id) ?? [])
        .filter((id) => id !== artist.id)
        .map((id) => nameById.get(id))
        .filter((n): n is string => !!n);
      if (coArtists.length) {
        context.coBilledArtists = coArtists.slice(0, 10);
      }
      context.eventDate = mostRecent.starts_at;
    }

    const started = Date.now();
    try {
      const result = await enrichArtistWithLLM(artist.name, context);
      const elapsedMs = Date.now() - started;
      log.push({
        name: artist.name,
        slug: artist.slug,
        expectedTier,
        actualTier: inferTier(result.toolTrace),
        elapsedMs,
        context,
        result,
      });
      console.log(
        formatSummaryRow(i + 1, total, artist.name, expectedTier, result, elapsedMs),
      );
      console.log('');
    } catch (err) {
      const elapsedMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      log.push({
        name: artist.name,
        slug: artist.slug,
        expectedTier,
        actualTier: 'error',
        elapsedMs,
        context,
        error: msg,
      });
      console.error(
        `[${String(i + 1).padStart(2, '0')}/${total}] ${artist.name} — ERROR (${elapsedMs}ms): ${msg}\n`,
      );
    }

    // Checkpoint after every artist.
    fs.writeFileSync(
      args.output,
      JSON.stringify({ startedAt, sampled: log }, null, 2),
    );
  }

  // ── Final summary ─────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log('Dry-run summary');
  console.log('═══════════════════════════════════════════════════════');

  const tierDist: Record<string, number> = {
    '1-training': 0,
    '2-search': 0,
    '3-firecrawl': 0,
    error: 0,
  };
  const confDist = { high: 0, medium: 0, low: 0 };
  let totalElapsed = 0;
  let successCount = 0;
  const allFuzzy: Array<{
    name: string;
    proposed: string;
    merged: string;
    distance: number;
  }> = [];

  for (const row of log) {
    totalElapsed += row.elapsedMs;
    tierDist[row.actualTier] = (tierDist[row.actualTier] ?? 0) + 1;
    if (row.result) {
      successCount += 1;
      confDist[row.result.confidence] += 1;
      for (const m of row.result.fuzzyMerges) {
        allFuzzy.push({ name: row.name, ...m });
      }
    }
  }

  console.log(
    `Success: ${successCount}/${total}  •  total: ${(totalElapsed / 1000).toFixed(1)}s  •  avg: ${(totalElapsed / Math.max(total, 1) / 1000).toFixed(1)}s/artist`,
  );
  console.log(
    `Tier distribution: training=${tierDist['1-training']}, search=${tierDist['2-search']}, firecrawl=${tierDist['3-firecrawl']}, error=${tierDist.error}`,
  );
  console.log(
    `Confidence: high=${confDist.high}, medium=${confDist.medium}, low=${confDist.low}`,
  );

  if (allFuzzy.length) {
    console.log(`\nFuzzy merges (${allFuzzy.length}):`);
    for (const m of allFuzzy) {
      console.log(`  ${m.name}: ${m.proposed} → ${m.merged} (d${m.distance})`);
    }
  }

  // Flag uncertain items per the flag-uncertain-inclusions preference:
  // low confidence, any fuzzy merge, or tier divergence against expectation.
  const flagged: Array<{ name: string; reasons: string[] }> = [];
  for (const row of log) {
    const reasons: string[] = [];
    if (row.result?.confidence === 'low') reasons.push('confidence=low');
    if (row.result?.fuzzyMerges.length) reasons.push(`${row.result.fuzzyMerges.length} fuzzy merge(s)`);
    if (row.result) {
      const exp = row.expectedTier;
      const act = inferTier(row.result.toolTrace);
      const divergent =
        (exp === 1 && act !== '1-training') ||
        (exp === 2 && act === '3-firecrawl') ||
        (exp === 3 && act === '1-training');
      if (divergent) reasons.push(`tier expected=${exp} actual=${act}`);
    }
    if (row.error) reasons.push(`error: ${row.error}`);
    if (reasons.length) flagged.push({ name: row.name, reasons });
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
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
