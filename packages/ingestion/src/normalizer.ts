// Normalizer: takes a RawEvent, writes:
//   - one events row (upsert on (source, source_id))
//   - one artists row per parsed artist (upsert on slug)
//   - one event_artists row per (event, artist) pair
//   - optional MusicBrainz enrichment of each artist (stale → refresh)
//   - event rollup: aggregate genre/flavor signals into events.genres/flavors
//     from three layers (weights chosen so source/venue signals survive even
//     when every artist has zero MB coverage — the failure mode that left 82%
//     of events untagged in Phase 3.15):
//       * RawEvent.sourceGenres (RA-curated event tags)  → weight 4
//       * headliner artist genres/flavors                 → weight 2
//       * supporting artist genres/flavors                → weight 1
//       * venue.default_genres/default_flavors (fallback) → weight 1, only
//         applied when every other signal came back empty — prevents e.g.
//         Nowadays-seeded defaults overriding a ra-nyc-tagged country set
//         but still tags events at known-genre rooms when MB is blank.
import { supabase } from './supabase.js';
import { slugify } from './slug.js';
import { enrichArtist as mbEnrichArtist } from './musicbrainz.js';
import { resolveTags } from './taxonomy.js';
import type { RawEvent } from './types.js';
import type { Database, Json } from './db-types.js';

type ArtistRow = Database['public']['Tables']['artists']['Row'];
type VenueDefaults = {
  genres: string[];
  flavors: string[];
};

// Refresh MB enrichment for an artist every 30 days. Beyond that, tags may have
// drifted (new releases, editorial changes).
const ENRICHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    // No MB hit. Mark as enriched so we don't re-try every run; we'll revisit
    // in ENRICHMENT_TTL_MS.
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
      flavors: agg.flavors,
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
  flavors: string[];
}

/**
 * Generic weighted signal for the rollup. The normalizer builds one per
 * source of truth (RA event tags, each artist, venue defaults) and hands
 * them to rollup() as a flat list — the function itself stays dumb.
 */
interface RollupSignal {
  genres: string[];
  flavors: string[];
  weight: number;
}

function rollup(signals: RollupSignal[]): EventRollup {
  const genreWeight = new Map<string, number>();
  const flavorWeight = new Map<string, number>();

  for (const s of signals) {
    for (const g of s.genres) {
      genreWeight.set(g, (genreWeight.get(g) ?? 0) + s.weight);
    }
    for (const f of s.flavors) {
      flavorWeight.set(f, (flavorWeight.get(f) ?? 0) + s.weight);
    }
  }

  const byWeightDesc = (a: [string, number], b: [string, number]) =>
    b[1] - a[1];

  return {
    genres: [...genreWeight.entries()].sort(byWeightDesc).map(([g]) => g),
    flavors: [...flavorWeight.entries()].sort(byWeightDesc).map(([f]) => f),
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

  // 1. Resolve venue_id by slug and pull default_genres/default_flavors in
  //    the same query — used later as a rollup fallback for events where
  //    every other signal came back empty.
  let venueId: string | null = null;
  let venueDefaults: VenueDefaults = { genres: [], flavors: [] };
  if (event.venueSlug) {
    const venue = await client
      .from('venues')
      .select('id, default_genres, default_flavors')
      .eq('slug', event.venueSlug)
      .maybeSingle();
    if (venue.error) throw venue.error;
    venueId = venue.data?.id ?? null;
    venueDefaults = {
      // Columns are nullable while backfill rolls out; tolerate null.
      genres: (venue.data as { default_genres?: string[] | null })?.default_genres ?? [],
      flavors: (venue.data as { default_flavors?: string[] | null })?.default_flavors ?? [],
    };
  }

  // 2. Upsert event (on source, source_id).
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

  // 3. Upsert artists + enrich + link event_artists.
  const artistRows: Array<{ artist: ArtistRow; isHeadliner: boolean; position: number }> = [];
  for (let i = 0; i < event.artistNames.length; i++) {
    const name = event.artistNames[i];
    if (!name) continue;
    let artist = await getOrCreateArtist(name);
    artist = await enrichArtistIfStale(artist);
    const isHeadliner = i === 0; // first in list = top billing
    artistRows.push({ artist, isHeadliner, position: i });
  }

  if (artistRows.length > 0) {
    // Dedupe by artist_id. If an event lists the same artist twice (either
    // literal duplicates or two name variants that slugify identically), two
    // rows with the same (event_id, artist_id) in a single INSERT ... ON
    // CONFLICT statement trigger Postgres's "cannot affect row a second time"
    // error (error 21000). Keep the first occurrence — it preserves the
    // headliner flag from the top-billed position.
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
  //
  //    Layer A: source-supplied event genres (RA's `event.genres`, resolved
  //    through taxonomy_map + smart-add). Highest weight because these are
  //    curated per-event by a human editor, and they don't depend on MB
  //    having any tags for the billed artists at all. This is the fix for
  //    Phase 3.15's coverage gap: 410/548 MBID-matched artists had zero MB
  //    tags, so the old artist-only rollup produced empty genres/flavors
  //    even when RA already told us "House" or "Techno" at the event level.
  const sourceSignals: RollupSignal[] = [];
  if (event.sourceGenres && event.sourceGenres.length > 0) {
    const resolved = await resolveTags(
      event.sourceGenres.map((name) => ({ name, count: 1 })),
    );
    sourceSignals.push({
      genres: resolved.genres,
      flavors: resolved.flavors,
      weight: 4,
    });
  }

  //    Layer B: per-artist genres/flavors, 2× on headliner.
  const artistSignals: RollupSignal[] = artistRows.map(
    ({ artist, isHeadliner }) => ({
      genres: artist.genres ?? [],
      flavors: artist.flavors ?? [],
      weight: isHeadliner ? 2 : 1,
    }),
  );

  //    Layer C (fallback only): venue defaults. Applied exclusively when
  //    every higher-priority signal came back empty — otherwise a curated
  //    "Elsewhere defaults" would overwrite a legitimate ra-nyc tag of
  //    "Country" on a one-off event. The fallback keeps tagging honest
  //    at venues with a strong house identity when MB gives us nothing.
  const haveAnyHigherSignal =
    sourceSignals.some((s) => s.genres.length > 0 || s.flavors.length > 0) ||
    artistSignals.some((s) => s.genres.length > 0 || s.flavors.length > 0);
  const venueSignals: RollupSignal[] =
    !haveAnyHigherSignal &&
    (venueDefaults.genres.length > 0 || venueDefaults.flavors.length > 0)
      ? [
          {
            genres: venueDefaults.genres,
            flavors: venueDefaults.flavors,
            weight: 1,
          },
        ]
      : [];

  const eventRollup = rollup([
    ...sourceSignals,
    ...artistSignals,
    ...venueSignals,
  ]);
  const rollupErr = await client
    .from('events')
    .update({ genres: eventRollup.genres, flavors: eventRollup.flavors })
    .eq('id', eventRow.id);
  if (rollupErr.error) throw rollupErr.error;

  return {
    eventId: eventRow.id,
    inserted: wasJustCreated,
    artistsLinked: artistRows.length,
    rollup: eventRollup,
  };
}
