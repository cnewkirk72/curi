// Normalizer: takes a RawEvent, writes:
//   - one events row (upsert on (source, source_id))
//   - one artists row per parsed artist (upsert on slug)
//   - one event_artists row per (event, artist) pair
//   - optional MusicBrainz enrichment of each artist (stale → refresh)
//   - event rollup: aggregate genre/vibe signals into events.genres/vibes
//     from three layers (weights chosen so source/venue signals survive even
//     when every artist has zero MB coverage — the failure mode that left 82%
//     of events untagged in Phase 3.15):
//       * RawEvent.sourceGenres (RA-curated event tags)  → weight 4
//       * headliner artist genres/vibes                  → weight 2
//       * supporting artist genres/vibes                 → weight 1
//       * venue.default_genres/default_vibes (fallback)  → weight 1, gated
//         *per dimension*: default_genres only apply when no higher-priority
//         layer produced any genres, and default_vibes likewise for vibes.
//
// Phase 4f.8 additions:
//   - Forward-prevention: classifyArtistName (from src/artist-parsing.ts) is
//     called on every artistName before getOrCreateArtist, so scrapers that
//     bypass parseArtists (e.g. RA's structured artist objects) still get
//     filtered against the same reject list used at audit time. Invalid names
//     are skipped with a console.warn; we don't throw, because a single bad
//     lineup entry shouldn't fail the whole event.
//   - Cross-source duplicate-event warning: after a NEW event is inserted,
//     check for siblings with (venue_id, same day, overlapping title
//     fingerprint). Logs only — forward-prevention would require a canonical
//     event model we don't have yet. The next audit run surfaces these for
//     manual merge via duplicate_events.
import { supabase } from './supabase.js';
import { slugify } from './slug.js';
import { enrichArtist as mbEnrichArtist } from './musicbrainz.js';
import { resolveTags } from './taxonomy.js';
import { classifyArtistName } from './artist-parsing.js';
import type { RawEvent } from './types.js';
import type { Database, Json } from './db-types.js';

type ArtistRow = Database['public']['Tables']['artists']['Row'];
type VenueDefaults = {
  genres: string[];
  vibes: string[];
};

// Refresh MB enrichment for an artist every 30 days. Beyond that, tags may have
// drifted (new releases, editorial changes).
const ENRICHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Shared with src/audit.ts — kept local to avoid a cross-file dependency on
// a tiny helper. If either implementation changes, update both.
const EVENT_STOP: ReadonlySet<string> = new Set([
  'presents', 'present', 'pres', 'live', 'at', 'the', 'a', 'an',
  'with', 'feat', 'featuring', 'vs', 'and', 'party', 'night', 'show',
  'nyc', 'brooklyn', 'manhattan', 'club', 'room', 'bar', 'dj',
]);

function titleFingerprint(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !EVENT_STOP.has(w))
    .slice(0, 3)
    .join(' ');
}

function isStale(lastEnrichedAt: string | null): boolean {
  if (!lastEnrichedAt) return true;
  const age = Date.now() - new Date(lastEnrichedAt).getTime();
  return age > ENRICHMENT_TTL_MS;
}

async function getOrCreateArtist(name: string): Promise<ArtistRow> {
  const client = supabase();
  const slug = slugify(name);

  const existing = await client
    .from('artists')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;

  const inserted = await client
    .from('artists')
    .insert({ name, slug })
    .select('*')
    .single();
  if (inserted.error) {
    // Race condition: someone else inserted. Refetch.
    if (inserted.error.code === '23505') {
      const refetch = await client
        .from('artists')
        .select('*')
        .eq('slug', slug)
        .single();
      if (refetch.data) return refetch.data;
    }
    throw inserted.error;
  }
  return inserted.data;
}

async function enrichArtistIfStale(
  artist: ArtistRow,
): Promise<ArtistRow> {
  if (!isStale(artist.last_enriched_at)) return artist;

  const detail = await mbEnrichArtist(artist.name);
  if (!detail) {
    const updated = await supabase()
      .from('artists')
      .update({ last_enriched_at: new Date().toISOString() })
      .eq('id', artist.id)
      .select('*')
      .single();
    return updated.data ?? artist;
  }

  const mbTags = [
    ...detail.tags,
    ...detail.genres.map((g) => ({ name: g.name, count: (g.count || 1) * 2 })),
  ];
  const agg = await resolveTags(mbTags);

  const updated = await supabase()
    .from('artists')
    .update({
      musicbrainz_id: detail.id,
      mb_tags: mbTags as unknown as Json,
      genres: agg.genres,
      vibes: agg.vibes,
      subgenres: agg.subgenres,
      last_enriched_at: new Date().toISOString(),
    })
    .eq('id', artist.id)
    .select('*')
    .single();
  if (updated.error) throw updated.error;
  return updated.data;
}

interface EventRollup {
  genres: string[];
  vibes: string[];
}

interface RollupSignal {
  genres: string[];
  vibes: string[];
  weight: number;
}

function rollup(signals: RollupSignal[]): EventRollup {
  const genreWeight = new Map<string, number>();
  const vibeWeight = new Map<string, number>();

  for (const s of signals) {
    for (const g of s.genres) {
      genreWeight.set(g, (genreWeight.get(g) ?? 0) + s.weight);
    }
    for (const v of s.vibes) {
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

export interface UpsertResult {
  eventId: string;
  inserted: boolean;
  artistsLinked: number;
  rollup: EventRollup;
}

export async function upsertEvent(event: RawEvent): Promise<UpsertResult> {
  const client = supabase();

  let venueId: string | null = null;
  let venueDefaults: VenueDefaults = { genres: [], vibes: [] };
  if (event.venueSlug) {
    const venue = await client
      .from('venues')
      .select('id, default_genres, default_vibes')
      .eq('slug', event.venueSlug)
      .maybeSingle();
    if (venue.error) throw venue.error;
    venueId = venue.data?.id ?? null;
    venueDefaults = {
      genres: (venue.data as { default_genres?: string[] | null })?.default_genres ?? [],
      vibes: (venue.data as { default_vibes?: string[] | null })?.default_vibes ?? [],
    };
  }

  const { data: eventRow, error: eventErr } = await client
    .from('events')
    .upsert(
      {
        source: event.source,
        source_id: event.sourceId,
        title: event.title,
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        venue_id: venueId,
        price_min: event.priceMin,
        price_max: event.priceMax,
        ticket_url: event.ticketUrl,
        image_url: event.imageUrl,
        description: event.description,
        raw: event.raw as Json,
      },
      { onConflict: 'source,source_id' },
    )
    .select('id, created_at, updated_at')
    .single();
  if (eventErr) throw eventErr;
  const wasJustCreated =
    eventRow.created_at === eventRow.updated_at; // close enough — same ms

  // Phase 4f.8 cross-source duplicate-event warning. Only on NEW inserts so
  // we don't pay a query for every update. Logs only — audit surfaces merges.
  if (wasJustCreated && venueId && event.startsAt) {
    const day = event.startsAt.slice(0, 10);
    const fp = titleFingerprint(event.title);
    if (fp) {
      const { data: siblings } = await client
        .from('events')
        .select('id, title, source, source_id')
        .eq('venue_id', venueId)
        .gte('starts_at', `${day}T00:00:00Z`)
        .lte('starts_at', `${day}T23:59:59Z`)
        .neq('id', eventRow.id);
      for (const s of siblings ?? []) {
        const sfp = titleFingerprint(s.title ?? '');
        if (sfp && (sfp === fp || sfp.includes(fp) || fp.includes(sfp))) {
          console.warn(
            `[dedupe] New event ${event.source}/${event.sourceId} "${event.title}" ` +
              `looks like a duplicate of ${s.source}/${s.source_id} "${s.title}" ` +
              `at venue_id=${venueId}, day=${day}. Audit will surface this for merge.`,
          );
        }
      }
    }
  }

  // 3. Upsert artists + enrich + link event_artists.
  const artistRows: Array<{ artist: ArtistRow; isHeadliner: boolean; position: number }> = [];
  for (let i = 0; i < event.artistNames.length; i++) {
    const name = event.artistNames[i];
    if (!name) continue;

    // Phase 4f.8 forward-prevention. parseArtists already applies the same
    // rule, but structured-data scrapers (RA GraphQL, Shotgun) can push names
    // that never went through it. classifyArtistName is idempotent so running
    // it here is safe even for parseArtists-origin names.
    const { valid, cleaned, reason } = classifyArtistName(name);
    if (!valid) {
      console.warn(
        `[normalizer] rejecting artist "${name}" (reason=${reason}) for event ${event.source}/${event.sourceId}`,
      );
      continue;
    }

    let artist = await getOrCreateArtist(cleaned);
    artist = await enrichArtistIfStale(artist);
    const isHeadliner = i === 0;
    artistRows.push({ artist, isHeadliner, position: i });
  }

  if (artistRows.length > 0) {
    const seenArtistIds = new Set<string>();
    const eaPayload: Array<{
      event_id: string;
      artist_id: string;
      is_headliner: boolean;
      position: number;
    }> = [];
    for (const { artist, isHeadliner, position } of artistRows) {
      if (seenArtistIds.has(artist.id)) continue;
      seenArtistIds.add(artist.id);
      eaPayload.push({
        event_id: eventRow.id,
        artist_id: artist.id,
        is_headliner: isHeadliner,
        position,
      });
    }

    const eaErr = await client
      .from('event_artists')
      .upsert(eaPayload, { onConflict: 'event_id,artist_id' });
    if (eaErr.error) throw eaErr.error;
  }

  // 4. Event rollup — three-layer weighted aggregation.
  const sourceSignals: RollupSignal[] = [];
  if (event.sourceGenres && event.sourceGenres.length > 0) {
    const resolved = await resolveTags(
      event.sourceGenres.map((name) => ({ name, count: 1 })),
    );
    sourceSignals.push({
      genres: resolved.genres,
      vibes: resolved.vibes,
      weight: 4,
    });
  }

  const artistSignals: RollupSignal[] = artistRows.map(
    ({ artist, isHeadliner }) => ({
      genres: artist.genres ?? [],
      vibes: artist.vibes ?? [],
      weight: isHeadliner ? 2 : 1,
    }),
  );

  const haveAnyHigherGenreSignal =
    sourceSignals.some((s) => s.genres.length > 0) ||
    artistSignals.some((s) => s.genres.length > 0);
  const haveAnyHigherVibeSignal =
    sourceSignals.some((s) => s.vibes.length > 0) ||
    artistSignals.some((s) => s.vibes.length > 0);
  const venueSignals: RollupSignal[] = [];
  if (!haveAnyHigherGenreSignal && venueDefaults.genres.length > 0) {
    venueSignals.push({
      genres: venueDefaults.genres,
      vibes: [],
      weight: 1,
    });
  }
  if (!haveAnyHigherVibeSignal && venueDefaults.vibes.length > 0) {
    venueSignals.push({
      genres: [],
      vibes: venueDefaults.vibes,
      weight: 1,
    });
  }

  const eventRollup = rollup([
    ...sourceSignals,
    ...artistSignals,
    ...venueSignals,
  ]);
  const rollupErr = await client
    .from('events')
    .update({ genres: eventRollup.genres, vibes: eventRollup.vibes })
    .eq('id', eventRow.id);
  if (rollupErr.error) throw rollupErr.error;

  return {
    eventId: eventRow.id,
    inserted: wasJustCreated,
    artistsLinked: artistRows.length,
    rollup: eventRollup,
  };
}
