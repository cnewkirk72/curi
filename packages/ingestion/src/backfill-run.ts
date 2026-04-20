// Phase 4f backfill orchestrator.
//
// Drives the full artist enrichment pass:
//
//   1. Paginated load of artists WHERE last_enriched_at IS NULL
//      (or all artists if --force). Paginates with .range() because
//      Supabase's JS client caps at 1000 rows per query — the
//      dry-run hit this silently in 4e and we are not repeating that.
//   2. Load event_artists + events + venues + artist names once,
//      paginated, to build co-bill and venue-defaults context maps.
//   3. Concurrency pool (default 10 workers) runs artists in parallel.
//   4. Per-artist pipeline:
//        a. enrichArtistWithLLM — Sonnet 4.6 tool-use loop with
//           prompt caching + stall fallback (never throws now).
//        b. Popularity fold-in — if enrichment already fetched SC/BC
//           self-tags, we have followers + URL. If not, and the
//           artist looks electronic, call discoverPopularity for a
//           homonym-guarded SC/BC lookup.
//        c. Per-artist DB commit:
//             - UPDATE artists SET genres, subgenres, vibes,
//                                 soundcloud_url, soundcloud_followers,
//                                 bandcamp_url, bandcamp_followers,
//                                 popularity_checked_at,
//                                 popularity_discovery_failed_at,
//                                 last_enriched_at
//             - Pass subgenres through resolveTags to auto-create
//               taxonomy_subgenres rows under the best-matching
//               parent (Phase 2 Jaccard inference).
//        d. JSON checkpoint after every artist — crash-resumable.
//
// Run location: Christian's laptop, one-shot. Re-run the script to
// resume — unenriched-only load naturally picks up where a crash left
// off.
//
// Usage:
//   pnpm --filter @curi/ingestion backfill \
//     [--concurrency 10] \
//     [--limit 1637] \
//     [--force] \
//     [--skip-popularity] \
//     [--output /tmp/curi-backfill.json]

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  enrichArtistWithLLM,
  type EnrichmentContext,
  type EnrichmentResult,
} from './llm-enrichment.js';
import { supabase } from './supabase.js';
import {
  discoverPopularity,
  type PopularityResult,
} from './popularity-discovery.js';
import { resolveTags } from './taxonomy.js';

const DEFAULT_CONCURRENCY = 10;
const PAGE_SIZE = 1000;

// Heuristic for "worth spending Firecrawl credits on standalone
// popularity lookup". Matches substrings of electronic genre/tag
// names likely to predict SC/BC presence. Conservative — a folk act
// tagged "ambient folk" might slip through, but that's fine: the
// homonym guard in discoverPopularity is what keeps us from
// polluting the DB.
const ELECTRONIC_PATTERN =
  /electro|house|techno|trance|dance|club|dub|ambient|bass|dnb|drum-?and-?bass|garage|idm|breakbeat|jungle|grime|hyperpop|footwork|leftfield/i;

interface Args {
  concurrency: number;
  output: string;
  limit: number | null;
  force: boolean;
  skipPopularity: boolean;
}

function parseArgs(argv: string[]): Args {
  let concurrency = DEFAULT_CONCURRENCY;
  let output = '';
  let limit: number | null = null;
  let force = false;
  let skipPopularity = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') concurrency = Number(argv[++i]);
    else if (a === '--output') output = argv[++i] ?? '';
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--force') force = true;
    else if (a === '--skip-popularity') skipPopularity = true;
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    concurrency = DEFAULT_CONCURRENCY;
  }
  if (!output) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    output = path.join('/tmp', `curi-backfill-${ts}.json`);
  }
  return { concurrency, output, limit, force, skipPopularity };
}

interface Artist {
  id: string;
  name: string;
  slug: string;
  mb_tags: Array<{ name: string; count?: number }> | null;
  last_enriched_at: string | null;
  soundcloud_url: string | null;
  bandcamp_url: string | null;
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

function asOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
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

async function loadEventContext(): Promise<{
  eventsByArtist: Map<string, EventRow[]>;
  artistsByEvent: Map<string, string[]>;
  nameById: Map<string, string>;
}> {
  const client = supabase();
  const eventsByArtist = new Map<string, EventRow[]>();
  const artistsByEvent = new Map<string, string[]>();
  const nameById = new Map<string, string>();

  // event_artists + embedded event + venue
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('event_artists')
      .select(
        'artist_id, event_id, events!inner(id, title, starts_at, venues(slug, default_genres, default_vibes))',
      )
      .order('artist_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as EventArtistRow[];
    for (const r of rows) {
      const ev = asOne(r.events);
      if (!ev) continue;
      if (!eventsByArtist.has(r.artist_id)) eventsByArtist.set(r.artist_id, []);
      eventsByArtist.get(r.artist_id)!.push(ev);
      if (!artistsByEvent.has(r.event_id)) artistsByEvent.set(r.event_id, []);
      artistsByEvent.get(r.event_id)!.push(r.artist_id);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // All artist names for co-bill lookup.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select('id, name')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const r of rows) nameById.set(r.id, r.name);
    if (rows.length < PAGE_SIZE) break;
  }

  return { eventsByArtist, artistsByEvent, nameById };
}

function buildContext(
  artist: Artist,
  eventsByArtist: Map<string, EventRow[]>,
  artistsByEvent: Map<string, string[]>,
  nameById: Map<string, string>,
): EnrichmentContext {
  const context: EnrichmentContext = { eventCity: 'NYC' };
  if (artist.mb_tags && artist.mb_tags.length) {
    context.existingMbTags = artist.mb_tags
      .map((t) => t.name)
      .filter((n): n is string => !!n);
  }
  const events = (eventsByArtist.get(artist.id) ?? [])
    .filter((e) => !!e && !!e.starts_at)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const mostRecent = events[0];
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
    if (coArtists.length) context.coBilledArtists = coArtists.slice(0, 10);
    context.eventDate = mostRecent.starts_at;
  }
  return context;
}

function hasElectronicSignal(
  artist: Artist,
  context: EnrichmentContext,
  enrichment: EnrichmentResult,
): boolean {
  if (
    artist.mb_tags?.some((t) => t.name && ELECTRONIC_PATTERN.test(t.name))
  ) {
    return true;
  }
  if (context.venueDefaults?.genres.some((g) => ELECTRONIC_PATTERN.test(g))) {
    return true;
  }
  if (context.venueDefaults?.vibes.some((v) => ELECTRONIC_PATTERN.test(v))) {
    return true;
  }
  if (enrichment.genres.some((g) => ELECTRONIC_PATTERN.test(g))) return true;
  if (enrichment.subgenres.some((s) => ELECTRONIC_PATTERN.test(s))) {
    return true;
  }
  return false;
}

interface ArtistLog {
  id: string;
  name: string;
  slug: string;
  startedAt: string;
  elapsedMs: number;
  enrichment?: EnrichmentResult;
  popularity?: PopularityResult | null;
  stalled?: boolean;
  error?: string;
}

async function commitArtist(
  artist: Artist,
  enrichment: EnrichmentResult,
  popularity: PopularityResult | null,
): Promise<void> {
  const client = supabase();
  const now = new Date().toISOString();

  const updatePayload: Record<string, unknown> = {
    genres: enrichment.genres,
    subgenres: enrichment.subgenres,
    vibes: enrichment.vibes,
    last_enriched_at: now,
  };

  if (popularity?.attempted) {
    // Only write a URL/followers column when we actually have a
    // non-null value — preserves any pre-existing data from an earlier
    // discovery pass if the current one came up empty.
    if (popularity.soundcloudUrl) {
      updatePayload.soundcloud_url = popularity.soundcloudUrl;
    }
    if (
      typeof popularity.soundcloudFollowers === 'number' &&
      Number.isFinite(popularity.soundcloudFollowers)
    ) {
      updatePayload.soundcloud_followers = popularity.soundcloudFollowers;
    }
    if (popularity.bandcampUrl) {
      updatePayload.bandcamp_url = popularity.bandcampUrl;
    }
    if (
      typeof popularity.bandcampFollowers === 'number' &&
      Number.isFinite(popularity.bandcampFollowers)
    ) {
      updatePayload.bandcamp_followers = popularity.bandcampFollowers;
    }

    const foundAny = !!(popularity.soundcloudUrl || popularity.bandcampUrl);
    if (foundAny) {
      updatePayload.popularity_checked_at = now;
    } else {
      updatePayload.popularity_discovery_failed_at = now;
    }
  }

  const { error } = await client
    .from('artists')
    .update(updatePayload)
    .eq('id', artist.id);
  if (error) throw error;

  // Register novel subgenres via the Phase 2 Jaccard inference so they
  // land under a matching parent in taxonomy_subgenres — and feed the
  // vocabulary for subsequent enrichments in future runs. Best-effort:
  // a taxonomy insert race shouldn't fail the whole artist commit.
  if (enrichment.subgenres.length) {
    const pairs = enrichment.subgenres.map((s) => ({ name: s, count: 1 }));
    try {
      await resolveTags(pairs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  taxonomy resolve failed for ${artist.name}: ${msg}`);
    }
  }
}

async function processArtist(
  artist: Artist,
  eventsByArtist: Map<string, EventRow[]>,
  artistsByEvent: Map<string, string[]>,
  nameById: Map<string, string>,
  skipPopularity: boolean,
): Promise<ArtistLog> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const context = buildContext(
    artist,
    eventsByArtist,
    artistsByEvent,
    nameById,
  );

  try {
    const enrichment = await enrichArtistWithLLM(artist.name, context);
    let popularity: PopularityResult | null = null;

    if (!skipPopularity) {
      if (enrichment.popularity) {
        popularity = enrichment.popularity;
      } else if (hasElectronicSignal(artist, context, enrichment)) {
        popularity = await discoverPopularity(artist.name);
      } else {
        // Non-electronic act, enrichment didn't touch Firecrawl. Skip
        // discovery — a folk/jazz act on SC is a low-value signal at
        // Firecrawl credit cost.
        popularity = { attempted: false, sources: [] };
      }
    }

    await commitArtist(artist, enrichment, popularity);

    const elapsedMs = Date.now() - start;
    return {
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
      startedAt,
      elapsedMs,
      enrichment,
      popularity,
      stalled: enrichment.stalled,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
      startedAt,
      elapsedMs,
      error: msg,
    };
  }
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
  const { eventsByArtist, artistsByEvent, nameById } =
    await loadEventContext();
  console.log(
    `Loaded ${eventsByArtist.size} artists with events, ${artistsByEvent.size} events, ${nameById.size} artist names.`,
  );

  console.log(
    `\nStarting backfill: concurrency=${args.concurrency}, skipPopularity=${args.skipPopularity}`,
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
      const result = await processArtist(
        artist,
        eventsByArtist,
        artistsByEvent,
        nameById,
        args.skipPopularity,
      );
      log.push(result);
      done += 1;
      const tag = result.error ? 'ERR' : result.stalled ? 'STALL' : 'OK';
      const conf = result.enrichment?.confidence ?? '—';
      const trace = result.enrichment?.toolTrace.join('→') ?? '';
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
          `conf=${conf}${pop} · ${trace}${errSuffix}`,
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

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Backfill summary');
  console.log('═══════════════════════════════════════════════════════');
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

  const conf = { high: 0, medium: 0, low: 0 };
  for (const r of log) {
    if (r.enrichment) conf[r.enrichment.confidence] += 1;
  }
  console.log(
    `Confidence: high=${conf.high}, medium=${conf.medium}, low=${conf.low}`,
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
    if (r.enrichment?.confidence === 'low' && !r.stalled) {
      reasons.push('confidence=low');
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
