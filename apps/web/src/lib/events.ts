// Event data fetchers. Server-only — these pull through the anon
// Supabase client from server.ts, so RLS applies and any future
// "private event" rows would be automatically gated.

import { createClient } from '@/lib/supabase/server';
import {
  dateWindowFor,
  type FilterState,
  EMPTY_FILTERS,
} from '@/lib/filters';

/**
 * A single lineup entry. Shared between the feed card (which truncates
 * to 3) and the detail screen (which shows the full list).
 */
export type LineupArtist = {
  name: string;
  position: number;
  is_headliner: boolean;
};

/**
 * Shape returned by `getUpcomingEvents`. This is the projection we want
 * to display in the home feed — venue and lineup are joined inline so
 * a single round-trip renders the card.
 */
export type FeedEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  genres: string[];
  flavors: string[];
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: {
    name: string;
    neighborhood: string | null;
    slug: string;
  } | null;
  lineup: LineupArtist[];
};

/**
 * Richer projection for the single-event detail screen. Adds
 * `description` and the venue's `lat`/`lng`/`website` (used by the
 * Location card's "Open in Maps" CTA and the venue link). Lineup is
 * the full artist list — not truncated.
 */
export type DetailEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  description: string | null;
  genres: string[];
  flavors: string[];
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: {
    name: string;
    slug: string;
    neighborhood: string | null;
    lat: number | null;
    lng: number | null;
    website: string | null;
  } | null;
  lineup: LineupArtist[];
};

/**
 * Raw row shape from the Supabase select string below. We type it
 * explicitly because Supabase's generated types infer joined rows as
 * `never` in the one-to-many direction (event_artists) — a known
 * limitation of the PostgREST type inference. This type mirrors the
 * select string exactly; if the select changes, update this in sync.
 */
type EventRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  genres: string[] | null;
  flavors: string[] | null;
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: { name: string; neighborhood: string | null; slug: string } | null;
  event_artists:
    | {
        position: number;
        is_headliner: boolean;
        artist: { name: string } | null;
      }[]
    | null;
};

/**
 * Fetch upcoming NYC events, ordered by start time.
 *
 * Relies on the `events_starts_at_idx` + `events_city_starts_idx` indexes
 * for the sort, and on the `events_genres_gin` / `events_flavors_gin`
 * GIN indexes for the array-overlap filters — don't add filters that
 * would force a seq scan without matching indexes.
 */
export async function getUpcomingEvents({
  limit = 80,
  filters = EMPTY_FILTERS,
}: { limit?: number; filters?: FilterState } = {}): Promise<FeedEvent[]> {
  const supabase = createClient();
  const { startIso, endIso } = dateWindowFor(filters.when);

  let query = supabase
    .from('events')
    .select(
      `
      id,
      title,
      starts_at,
      ends_at,
      image_url,
      genres,
      flavors,
      price_min,
      price_max,
      ticket_url,
      venue:venues (
        name,
        neighborhood,
        slug
      ),
      event_artists (
        position,
        is_headliner,
        artist:artists ( name )
      )
      `,
    )
    .eq('city', 'NYC')
    .gte('starts_at', startIso);

  // Apply the upper bound only when the date filter sets one (`all`
  // has `endIso === null`, i.e. no cap).
  if (endIso) {
    query = query.lt('starts_at', endIso);
  }

  // Multi-select genres / vibes → OR semantics ("techno OR house"),
  // which maps cleanly to PostgreSQL's `&&` array-overlap operator
  // and our GIN indexes.
  if (filters.genres.length) {
    query = query.overlaps('genres', filters.genres);
  }
  if (filters.flavors.length) {
    query = query.overlaps('flavors', filters.flavors);
  }

  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .limit(limit);

  if (error) {
    // Don't swallow — callers show an empty state, but the console
    // noise during dev helps catch RLS/env drift early.
    // eslint-disable-next-line no-console
    console.error('[events] getUpcomingEvents failed:', error.message);
    return [];
  }

  // See EventRow above for why we cast rather than rely on inference.
  const rows = (data ?? []) as unknown as EventRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    image_url: row.image_url,
    genres: row.genres ?? [],
    flavors: row.flavors ?? [],
    price_min: row.price_min,
    price_max: row.price_max,
    ticket_url: row.ticket_url,
    venue: row.venue
      ? {
          name: row.venue.name,
          neighborhood: row.venue.neighborhood,
          slug: row.venue.slug,
        }
      : null,
    lineup: (row.event_artists ?? [])
      .map((ea) => ({
        name: ea.artist?.name ?? '',
        position: ea.position,
        is_headliner: ea.is_headliner,
      }))
      .filter((a) => a.name.length > 0)
      .sort((a, b) => a.position - b.position),
  }));
}

/**
 * Raw row shape for the single-event select used by `getEventById`.
 * Same reason as `EventRow` above — we hand-type because PostgREST
 * infers joined rows as `never`.
 */
type EventDetailDbRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  description: string | null;
  genres: string[] | null;
  flavors: string[] | null;
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue:
    | {
        name: string;
        slug: string;
        neighborhood: string | null;
        lat: number | null;
        lng: number | null;
        website: string | null;
      }
    | null;
  event_artists:
    | {
        position: number;
        is_headliner: boolean;
        artist: { name: string } | null;
      }[]
    | null;
};

/**
 * Fetch a single event by id for the detail screen. Returns null when
 * the event is missing (so the caller can `notFound()`) or when the
 * query errors out — we don't want a transient Supabase blip to 500
 * the page; better to render the 404.
 *
 * Pulls the same joined venue + event_artists projection as the feed
 * fetcher, plus `description` and the venue's `lat`/`lng`/`website`
 * which only the detail screen needs.
 */
export async function getEventById(id: string): Promise<DetailEvent | null> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('events')
    .select(
      `
      id,
      title,
      starts_at,
      ends_at,
      image_url,
      description,
      genres,
      flavors,
      price_min,
      price_max,
      ticket_url,
      venue:venues (
        name,
        slug,
        neighborhood,
        lat,
        lng,
        website
      ),
      event_artists (
        position,
        is_headliner,
        artist:artists ( name )
      )
      `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[events] getEventById failed:', error.message);
    return null;
  }
  if (!data) return null;

  const row = data as unknown as EventDetailDbRow;

  return {
    id: row.id,
    title: row.title,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    image_url: row.image_url,
    description: row.description,
    genres: row.genres ?? [],
    flavors: row.flavors ?? [],
    price_min: row.price_min,
    price_max: row.price_max,
    ticket_url: row.ticket_url,
    venue: row.venue
      ? {
          name: row.venue.name,
          slug: row.venue.slug,
          neighborhood: row.venue.neighborhood,
          lat: row.venue.lat,
          lng: row.venue.lng,
          website: row.venue.website,
        }
      : null,
    lineup: (row.event_artists ?? [])
      .map((ea) => ({
        name: ea.artist?.name ?? '',
        position: ea.position,
        is_headliner: ea.is_headliner,
      }))
      .filter((a) => a.name.length > 0)
      .sort((a, b) => {
        // Headliners first within the same position, then by position.
        // In practice ingestion sets position = 0/1/2/... with headliner
        // on 0, so position sort is usually enough — but defend against
        // scrapers that set is_headliner without adjusting position.
        if (a.is_headliner !== b.is_headliner) return a.is_headliner ? -1 : 1;
        return a.position - b.position;
      }),
  };
}
