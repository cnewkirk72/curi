// Event data fetchers. Server-only — these pull through the anon
// Supabase client from server.ts, so RLS applies and any future
// "private event" rows would be automatically gated.

import { createClient } from '@/lib/supabase/server';

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
  lineup: {
    name: string;
    position: number;
    is_headliner: boolean;
  }[];
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
 * for the sort — don't add filters that would force a seq scan without
 * matching indexes.
 */
export async function getUpcomingEvents({
  limit = 80,
}: { limit?: number } = {}): Promise<FeedEvent[]> {
  const supabase = createClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
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
    .gte('starts_at', nowIso)
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
