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
//
// Phase 3.16 additions (cross-source dupe forward-prevention):
//   - Before inserting a new event, call find_dupe_event_by_artist (supabase/
//     migrations/0015_dedup_function.sql) to detect an existing event at the
//     same venue, within ±60 min, sharing ≥1 artist slug, but with a different
//     (source, source_id). If found: skip the insert entirely, backfill any
//     null/empty metadata fields on the existing row, and union the lineup
//     (the new scraper may have pulled additional supporting artists).
//     Rollup is NOT recomputed on the dupe path — the existing row's
//     genres/vibes were derived from the first ingestion's source tags and
//     overwriting them with only this ingestion's signals would be lossy.
//     Supersedes the old passive titleFingerprint warning.
import { supabase } from './supabase.js';
import { slugify } from './slug.js';
import { enrichArtist as mbEnrichArtist } from './musicbrainz.js';
import { resolveTags } from './taxonomy.js';
import { classifyArtistName } from './artist-parsing.js';
import type { RawEvent } from './types.js';
import type { Database, Json } from './db-types.js';

type ArtistRow = Database['public']['Tables']['artists']['Row'];
type EventUpdate = Database['public']['Tables']['events']['Update'];
type VenueDefaults = {
  genres: string[];
  vibes: string[];
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

  // Phase 4f.8 forward-prevention (moved up from the artist-link loop so
  // slugs are available for the Phase 3.16 dedup RPC below). classifyArtistName
  // is idempotent, so names that came through parseArtists get re-checked
  // cheaply; names from structured scrapers (RA GraphQL, Shotgun) that bypass
  // parseArtists get the same reject filter applied.
  const classifiedArtists: Array<{
    cleaned: string;
    slug: string;
    isHeadliner: boolean;
    position: number;
  }> = [];
  for (let i = 0; i < event.artistNames.length; i++) {
    const name = event.artistNames[i];
    if (!name) continue;
    const { valid, cleaned, reason } = classifyArtistName(name);
    if (!valid) {
      console.warn(
        `[normalizer] rejecting artist "${name}" (reason=${reason}) for event ${event.source}/${event.sourceId}`,
      );
      continue;
    }
    classifiedArtists.push({
      cleaned,
      slug: slugify(cleaned),
      isHeadliner: i === 0,
      position: i,
    });
  }

  // Phase 3.16 pre-insert dedup check. Shape of the RPC payload: see
  // supabase/migrations/0015_dedup_function.sql. Returns at most one row —
  // the earliest-created event at the same venue + ±60 min + ≥1 shared
  // artist slug, excluding our own (source, source_id) so a repeat-ingest
  // of this scraper row doesn't look like a dupe of itself.
  type DupeRow = {
    id: string;
    title: string | null;
    source: string;
    source_id: string;
    starts_at: string;
    image_url: string | null;
    description: string | null;
    ticket_url: string | null;
    price_min: number | null;
    price_max: number | null;
    ends_at: string | null;
  };
  let dupe: DupeRow | null = null;
  if (venueId && event.startsAt && classifiedArtists.length > 0) {
    // Cast through `any`: the generated db-types.ts (last regen pre-0015)
    // doesn't yet include find_dupe_event_by_artist in the Functions map.
    // Regenerating types is a separate chore we'll fold into the next
    // supabase:types script run; until then, a localized cast is the
    // lowest-risk path. The RPC shape is pinned in 0015_dedup_function.sql.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client as any).rpc('find_dupe_event_by_artist', {
      p_venue_id: venueId,
      p_starts_at: event.startsAt,
      p_artist_slugs: classifiedArtists.map((a) => a.slug),
      p_exclude_source: event.source,
      p_exclude_source_id: event.sourceId,
    });
    if (error) {
      // Don't throw — a broken dedup path shouldn't block ingestion.
      console.warn(
        `[normalizer] find_dupe_event_by_artist failed (${error.code}): ${error.message}. Falling back to normal upsert.`,
      );
    } else {
      const rows = (data as unknown as DupeRow[] | null) ?? [];
      if (rows.length > 0) dupe = rows[0]!;
    }
  }

  let eventRowId: string;
  let wasJustCreated: boolean;

  if (dupe) {
    // Cross-source dupe confirmed. Skip the upsert entirely — inserting
    // would create a duplicate under a distinct (source, source_id).
    // Instead, backfill any null/empty fields on the existing row so the
    // richer scraper's metadata wins without clobbering first-seen data.
    const deltaMin = Math.round(
      (Date.parse(event.startsAt) - Date.parse(dupe.starts_at)) / 60000,
    );
    console.warn(
      `[dedupe] Cross-source duplicate detected: incoming ${event.source}/${event.sourceId} ` +
        `"${event.title}" → existing ${dupe.source}/${dupe.source_id} "${dupe.title}" ` +
        `(id=${dupe.id}, venue_id=${venueId}, Δ=${deltaMin}min). Skipping insert; backfilling null fields.`,
    );

    const backfill: EventUpdate = {};
    if (!dupe.image_url && event.imageUrl) backfill.image_url = event.imageUrl;
    if (!dupe.description && event.description) backfill.description = event.description;
    if (!dupe.ticket_url && event.ticketUrl) backfill.ticket_url = event.ticketUrl;
    if (dupe.price_min == null && event.priceMin != null) backfill.price_min = event.priceMin;
    if (dupe.price_max == null && event.priceMax != null) backfill.price_max = event.priceMax;
    if (!dupe.ends_at && event.endsAt) backfill.ends_at = event.endsAt;
    if (Object.keys(backfill).length > 0) {
      const { error: bfErr } = await client
        .from('events')
        .update(backfill)
        .eq('id', dupe.id);
      if (bfErr) {
        console.warn(`[normalizer] dupe-merge backfill failed: ${bfErr.message}`);
      }
    }
    eventRowId = dupe.id;
    wasJustCreated = false;
  } else {
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
    eventRowId = eventRow.id;
    wasJustCreated = eventRow.created_at === eventRow.updated_at; // same ms → fresh insert
  }

  // 3. Upsert artists + enrich + link event_artists.
  // On the dupe path we still run this loop so that any NEW supporting
  // artists from this scraper get linked to the existing event (the dupe
  // detector only requires ≥1 shared slug — the lineup might be broader).
  const artistRows: Array<{ artist: ArtistRow; isHeadliner: boolean; position: number }> = [];
  for (const ca of classifiedArtists) {
    let artist = await getOrCreateArtist(ca.cleaned);
    artist = await enrichArtistIfStale(artist);
    artistRows.push({ artist, isHeadliner: ca.isHeadliner, position: ca.position });
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
        event_id: eventRowId,
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
  // On the dupe path we skip rollup: the existing row's genres/vibes were
  // computed from the first ingestion's sourceGenres (weight 4) and full
  // artist set, so overwriting with only THIS scraper's signals would drop
  // tags the first pass supplied. Artists we just linked above will fold
  // into the rollup the next time a non-dupe version of this event (or a
  // nightly re-rollup) runs.
  if (dupe) {
    return {
      eventId: eventRowId,
      inserted: false,
      artistsLinked: artistRows.length,
      rollup: { genres: [], vibes: [] },
    };
  }

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
    .eq('id', eventRowId);
  if (rollupErr.error) throw rollupErr.error;

  return {
    eventId: eventRowId,
    inserted: wasJustCreated,
    artistsLinked: artistRows.length,
    rollup: eventRollup,
  };
}
