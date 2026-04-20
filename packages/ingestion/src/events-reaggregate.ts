// Phase 4f.8 post-backfill events re-aggregation.
//
// Context: the scrape-time rollup in normalizer.ts computes events.genres
// and events.vibes from a three-layer weighted mix: source-provided tags,
// artist genres/vibes, and venue defaults as per-dimension fallback. At
// scrape time, most artists have empty genres/vibes (they haven't been
// enriched yet), so the rollup leans hard on venue defaults — often
// giving every event at a given venue identical genre arrays. After the
// 4f.8 artist backfill writes real enrichment data on ~1,600 artists,
// events are stale: their stored genres/vibes reflect a world where
// artists had no data, not the post-backfill reality. Hence this script.
//
// Differences from the normalizer's rollup:
//
//   1. Artists with enrichment_confidence='very-low' are skipped entirely.
//      Their tags came from the stall fallback and aren't trustworthy
//      enough to propagate into event-level classifications.
//
//   2. The sourceGenres layer (weight 4 in normalizer.ts) is omitted —
//      we don't store source_genres on events in a queryable form, and
//      the scraper cron re-applies them on its next pass anyway. This
//      script's job is the catch-up from the artist-enrichment side,
//      not a full re-scrape.
//
// Safety:
//   - Dry-run by default. Pass --apply to write.
//   - Only updates events where the new rollup differs from the stored
//     value. No-op updates are suppressed.
//   - Paginates both events and event_artists via .range(0, 999) to
//     avoid Supabase's silent 1000-row cap.
//   - Idempotent: running twice in a row with no artist changes in
//     between produces zero updates on the second pass.
//
// Usage:
//   pnpm --filter @curi/ingestion reaggregate            # dry run
//   pnpm --filter @curi/ingestion reaggregate --apply    # write
//   pnpm --filter @curi/ingestion reaggregate --apply --limit 100

import 'dotenv/config';
import { supabase } from './supabase.js';

const PAGE_SIZE = 1000;

type Confidence = 'high' | 'medium' | 'low' | 'very-low';

interface ArtistRow {
  id: string;
  genres: string[] | null;
  vibes: string[] | null;
  enrichment_confidence: Confidence | null;
}

interface EventArtistRow {
  event_id: string;
  artist_id: string;
  is_headliner: boolean | null;
  position: number | null;
}

interface EventRow {
  id: string;
  title: string | null;
  source: string;
  source_id: string;
  venue_id: string | null;
  genres: string[] | null;
  vibes: string[] | null;
}

interface VenueRow {
  id: string;
  default_genres: string[] | null;
  default_vibes: string[] | null;
}

interface Args {
  apply: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--limit') limit = Number(argv[++i]);
  }
  return { apply, limit };
}

async function loadArtistsIndex(): Promise<Map<string, ArtistRow>> {
  const client = supabase();
  const byId = new Map<string, ArtistRow>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select('id, genres, vibes, enrichment_confidence')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as ArtistRow[];
    for (const r of rows) byId.set(r.id, r);
    if (rows.length < PAGE_SIZE) break;
  }
  return byId;
}

async function loadEventArtists(): Promise<Map<string, EventArtistRow[]>> {
  const client = supabase();
  const byEvent = new Map<string, EventArtistRow[]>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('event_artists')
      .select('event_id, artist_id, is_headliner, position')
      .order('event_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as EventArtistRow[];
    for (const r of rows) {
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
      byEvent.get(r.event_id)!.push(r);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return byEvent;
}

async function loadEvents(limit: number | null): Promise<EventRow[]> {
  const client = supabase();
  const all: EventRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('events')
      .select('id, title, source, source_id, venue_id, genres, vibes')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as EventRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (limit !== null && all.length >= limit) break;
  }
  return limit !== null ? all.slice(0, limit) : all;
}

async function loadVenuesIndex(): Promise<Map<string, VenueRow>> {
  const client = supabase();
  const byId = new Map<string, VenueRow>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('venues')
      .select('id, default_genres, default_vibes')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as VenueRow[];
    for (const r of rows) byId.set(r.id, r);
    if (rows.length < PAGE_SIZE) break;
  }
  return byId;
}

interface RollupSignal {
  genres: string[];
  vibes: string[];
  weight: number;
}

interface EventRollup {
  genres: string[];
  vibes: string[];
}

/**
 * Weighted rollup mirroring normalizer.ts's logic. Tags are summed by
 * weight across signals and returned sorted by total weight descending.
 */
function rollup(signals: RollupSignal[]): EventRollup {
  const genreWeight = new Map<string, number>();
  const vibeWeight = new Map<string, number>();

  for (const s of signals) {
    for (const g of s.genres) {
      if (!g) continue;
      genreWeight.set(g, (genreWeight.get(g) ?? 0) + s.weight);
    }
    for (const v of s.vibes) {
      if (!v) continue;
      vibeWeight.set(v, (vibeWeight.get(v) ?? 0) + s.weight);
    }
  }

  const byWeightDesc = (a: [string, number], b: [string, number]) =>
    b[1] - a[1];

  return {
    genres: [...genreWeight.entries()].sort(byWeightDesc).map(([g]) => g),
    vibes: [...vibeWeight.entries()].sort(byWeightDesc).map(([v]) => v),
  };
}

/**
 * Deep equal for string[] — order matters (the rollup sort is stable and
 * weight-ordered, so a change in order is a change in meaning).
 */
function arraysEqual(a: string[] | null, b: string[]): boolean {
  const aNonNull = a ?? [];
  if (aNonNull.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (aNonNull[i] !== b[i]) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`Events re-aggregation — ${mode}${args.limit ? ` (limit=${args.limit})` : ''}`);

  console.log('Loading artists…');
  const artistsById = await loadArtistsIndex();
  const confCounts = { high: 0, medium: 0, low: 0, 'very-low': 0, null: 0 };
  for (const a of artistsById.values()) {
    const k = a.enrichment_confidence ?? 'null';
    confCounts[k as keyof typeof confCounts] =
      (confCounts[k as keyof typeof confCounts] ?? 0) + 1;
  }
  console.log(
    `  ${artistsById.size} artists — conf: high=${confCounts.high}, medium=${confCounts.medium}, low=${confCounts.low}, very-low=${confCounts['very-low']}, null=${confCounts.null}`,
  );

  console.log('Loading event_artists…');
  const eventArtistsByEvent = await loadEventArtists();
  console.log(`  ${eventArtistsByEvent.size} events have artists`);

  console.log('Loading venues…');
  const venuesById = await loadVenuesIndex();
  console.log(`  ${venuesById.size} venues`);

  console.log('Loading events…');
  const events = await loadEvents(args.limit);
  console.log(`  ${events.length} events to re-aggregate`);

  const client = supabase();
  let changed = 0;
  let unchanged = 0;
  let skippedEmpty = 0;
  let applied = 0;
  const sampleDiffs: Array<{
    id: string;
    title: string | null;
    from: { genres: string[] | null; vibes: string[] | null };
    to: { genres: string[]; vibes: string[] };
  }> = [];

  for (const event of events) {
    // Build artist signals, filtered by confidence.
    const eas = eventArtistsByEvent.get(event.id) ?? [];
    const artistSignals: RollupSignal[] = [];
    for (const ea of eas) {
      const artist = artistsById.get(ea.artist_id);
      if (!artist) continue;
      const conf = artist.enrichment_confidence;
      // Skip very-low (stall fallback — untrustworthy) and null
      // (shouldn't exist post-backfill, but guard anyway).
      if (conf === 'very-low' || conf === null) continue;
      const genres = artist.genres ?? [];
      const vibes = artist.vibes ?? [];
      if (genres.length === 0 && vibes.length === 0) continue;
      artistSignals.push({
        genres,
        vibes,
        weight: ea.is_headliner ? 2 : 1,
      });
    }

    // Venue defaults — per-dimension fallback, same as normalizer.ts.
    const venue = event.venue_id ? venuesById.get(event.venue_id) : null;
    const venueGenres = venue?.default_genres ?? [];
    const venueVibes = venue?.default_vibes ?? [];
    const haveArtistGenres = artistSignals.some((s) => s.genres.length > 0);
    const haveArtistVibes = artistSignals.some((s) => s.vibes.length > 0);
    const venueSignals: RollupSignal[] = [];
    if (!haveArtistGenres && venueGenres.length > 0) {
      venueSignals.push({ genres: venueGenres, vibes: [], weight: 1 });
    }
    if (!haveArtistVibes && venueVibes.length > 0) {
      venueSignals.push({ genres: [], vibes: venueVibes, weight: 1 });
    }

    const newRollup = rollup([...artistSignals, ...venueSignals]);

    // Skip events where we have no signal AT ALL — don't overwrite any
    // stored data with empty arrays. This preserves stale-but-nonzero
    // rollups from before the backfill until a scraper re-run refreshes
    // the event with current source tags.
    if (newRollup.genres.length === 0 && newRollup.vibes.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    const genresEqual = arraysEqual(event.genres, newRollup.genres);
    const vibesEqual = arraysEqual(event.vibes, newRollup.vibes);
    if (genresEqual && vibesEqual) {
      unchanged += 1;
      continue;
    }

    changed += 1;
    if (sampleDiffs.length < 10) {
      sampleDiffs.push({
        id: event.id,
        title: event.title,
        from: { genres: event.genres, vibes: event.vibes },
        to: { genres: newRollup.genres, vibes: newRollup.vibes },
      });
    }

    if (args.apply) {
      const { error } = await client
        .from('events')
        .update({ genres: newRollup.genres, vibes: newRollup.vibes })
        .eq('id', event.id);
      if (error) {
        console.warn(`  update failed for event ${event.id}: ${error.message}`);
        continue;
      }
      applied += 1;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Re-aggregation summary — ${mode}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  events scanned: ${events.length}`);
  console.log(`  changed:        ${changed}`);
  console.log(`  unchanged:      ${unchanged}`);
  console.log(`  skipped (no signal + no venue defaults): ${skippedEmpty}`);
  if (args.apply) {
    console.log(`  applied:        ${applied}`);
  }

  if (sampleDiffs.length > 0) {
    console.log('\nSample diffs (first 10):');
    for (const d of sampleDiffs) {
      console.log(`\n  [${d.id}] ${d.title ?? '(untitled)'}`);
      console.log(`    genres: ${JSON.stringify(d.from.genres)} → ${JSON.stringify(d.to.genres)}`);
      console.log(`    vibes:  ${JSON.stringify(d.from.vibes)} → ${JSON.stringify(d.to.vibes)}`);
    }
  }

  if (!args.apply && changed > 0) {
    console.log('\nDry run — re-run with --apply to persist these changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
