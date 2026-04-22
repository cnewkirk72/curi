// Event data fetchers. Server-only — these pull through the anon
// Supabase client from server.ts, so RLS applies and any future
// "private event" rows would be automatically gated.
//
// Note: `enrichmentScore` lives in `lib/enrichment.ts`, not here.
// That module is client-safe; this one isn't (`createClient` imports
// `next/headers`), and Vercel's build fails if a client component
// reaches server-only modules through the import graph.

import { createClient } from '@/lib/supabase/server';
import {
  dateWindowFor,
  type FilterState,
  EMPTY_FILTERS,
} from '@/lib/filters';

/**
 * A single lineup entry. Shared between the feed card (which truncates
 * to 3) and the detail screen (which shows the full list).
 *
 * `image_url`, `spotify_url`, and `spotify_popularity` come from the
 * Phase 4f artist enrichment pass (Spotify CDN image, artist profile
 * URL, 0–100 popularity score). They're nullable because the backfill
 * lands row-by-row and some artists won't have a Spotify match at all —
 * the UI falls back to initials + tinted circles in that case.
 */
export type LineupArtist = {
  name: string;
  position: number;
  is_headliner: boolean;
  image_url: string | null;
  spotify_url: string | null;
  spotify_popularity: number | null;
  // Additional enrichment signals from migration 0010. We fetch these
  // so `enrichmentScore` (in lib/enrichment.ts) can compute a hybrid
  // "how well do we know this event's lineup" metric — they're not
  // rendered on the card directly, but drive the default feed sort
  // within each day group.
  soundcloud_url: string | null;
  soundcloud_followers: number | null;
  bandcamp_url: string | null;
  bandcamp_followers: number | null;
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
  vibes: string[];
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
  vibes: string[];
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
  vibes: string[] | null;
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: { name: string; neighborhood: string | null; slug: string } | null;
  event_artists:
    | {
        position: number;
        is_headliner: boolean;
        artist: {
          name: string;
          spotify_image_url: string | null;
          spotify_url: string | null;
          spotify_popularity: number | null;
          soundcloud_url: string | null;
          soundcloud_followers: number | null;
          bandcamp_url: string | null;
          bandcamp_followers: number | null;
        } | null;
      }[]
    | null;
};

/**
 * Keyset cursor for infinite-scroll pagination. We order the feed by
 * `(starts_at ASC, id ASC)`; to continue past an event, send its
 * `starts_at` and `id` — we'll return rows strictly "after" it in the
 * composite ordering. Keyset (vs. OFFSET) survives mid-scroll ingests
 * without double-rendering a row or skipping one, which matters
 * because scrapers run nightly and can land new events while a user
 * is scrolling.
 */
export type FeedCursor = {
  /** ISO UTC string — the `starts_at` of the last event already shown. */
  afterStartsAt: string;
  /** UUID — the `id` of the last event already shown. */
  afterId: string;
};

/**
 * Fetch upcoming NYC events, ordered by start time.
 *
 * Relies on the `events_starts_at_idx` + `events_city_starts_idx` indexes
 * for the sort, and on the `events_genres_gin` / `events_vibes_gin`
 * GIN indexes for the array-overlap filters — don't add filters that
 * would force a seq scan without matching indexes.
 */
export async function getUpcomingEvents({
  limit = 80,
  filters = EMPTY_FILTERS,
  cursor,
}: {
  limit?: number;
  filters?: FilterState;
  cursor?: FeedCursor;
} = {}): Promise<FeedEvent[]> {
  const supabase = createClient();
  // Pass the full FilterState so `dateWindowFor` can honor custom
  // ranges (when='custom' reads date_from / date_to off the state).
  const { startIso, endIso } = dateWindowFor(filters);

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
      vibes,
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
        artist:artists (
          name,
          spotify_image_url,
          spotify_url,
          spotify_popularity,
          soundcloud_url,
          soundcloud_followers,
          bandcamp_url,
          bandcamp_followers
        )
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

  // Keyset pagination. Continue strictly after the last shown event
  // in the composite `(starts_at, id)` ordering:
  //   starts_at > after.starts_at
  //   OR (starts_at = after.starts_at AND id > after.id)
  //
  // PostgREST `.or(...)` builds an OR group; the inner `and(...)` is
  // nested and combined implicitly with the rest of the query via AND,
  // so the effective predicate is `(window bounds) AND (keyset)` —
  // exactly what we want.
  if (cursor) {
    query = query.or(
      `starts_at.gt.${cursor.afterStartsAt},and(starts_at.eq.${cursor.afterStartsAt},id.gt.${cursor.afterId})`,
    );
  }

  // Multi-select genres / vibes → OR semantics ("techno OR house"),
  // which maps cleanly to PostgreSQL's `&&` array-overlap operator
  // and our GIN indexes.
  if (filters.genres.length) {
    query = query.overlaps('genres', filters.genres);
  }
  if (filters.vibes.length) {
    query = query.overlaps('vibes', filters.vibes);
  }

  // Subgenre filter. Events don't carry subgenres directly — they
  // inherit them through their artist lineup via `artists.subgenres`.
  // We resolve that in two lightweight queries rather than an RPC
  // or a joined embedded filter:
  //
  //   (1) find artist_ids whose subgenres[] overlaps the filter
  //   (2) find event_ids in event_artists where artist_id ∈ (1)
  //   (3) constrain the main query with `.in('id', eventIds)`
  //
  // Costs an extra round-trip but keeps the main feed query simple,
  // and both helper queries hit the `artists_subgenres_gin` index
  // from migration 0003. If this becomes hot, the next step is a
  // trigger-maintained `events.subgenres text[]` column + GIN index,
  // collapsing back to a single query.
  if (filters.subgenres.length > 0) {
    const { data: artistRows, error: artistErr } = await supabase
      .from('artists')
      .select('id')
      .overlaps('subgenres', filters.subgenres);

    if (artistErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[events] subgenre artist lookup failed:',
        artistErr.message,
      );
      return [];
    }
    const artistIds = (artistRows ?? []).map(
      (r) => (r as { id: string }).id,
    );
    if (artistIds.length === 0) return [];

    const { data: linkRows, error: linkErr } = await supabase
      .from('event_artists')
      .select('event_id')
      .in('artist_id', artistIds);

    if (linkErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[events] subgenre event-artist lookup failed:',
        linkErr.message,
      );
      return [];
    }
    const eventIds = Array.from(
      new Set(
        (linkRows ?? []).map((r) => (r as { event_id: string }).event_id),
      ),
    );
    if (eventIds.length === 0) return [];
    query = query.in('id', eventIds);
  }

  // Sort order must match the keyset cursor exactly — tiebreak on `id`
  // so two events at the same `starts_at` always resolve in a stable,
  // cursor-compatible order.
  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .order('id', { ascending: true })
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
    vibes: row.vibes ?? [],
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
        image_url: ea.artist?.spotify_image_url ?? null,
        spotify_url: ea.artist?.spotify_url ?? null,
        spotify_popularity: ea.artist?.spotify_popularity ?? null,
        soundcloud_url: ea.artist?.soundcloud_url ?? null,
        soundcloud_followers: ea.artist?.soundcloud_followers ?? null,
        bandcamp_url: ea.artist?.bandcamp_url ?? null,
        bandcamp_followers: ea.artist?.bandcamp_followers ?? null,
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
  vibes: string[] | null;
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
        artist: {
          name: string;
          spotify_image_url: string | null;
          spotify_url: string | null;
          spotify_popularity: number | null;
          soundcloud_url: string | null;
          soundcloud_followers: number | null;
          bandcamp_url: string | null;
          bandcamp_followers: number | null;
        } | null;
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
      vibes,
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
        artist:artists (
          name,
          spotify_image_url,
          spotify_url,
          spotify_popularity,
          soundcloud_url,
          soundcloud_followers,
          bandcamp_url,
          bandcamp_followers
        )
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
    vibes: row.vibes ?? [],
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
        image_url: ea.artist?.spotify_image_url ?? null,
        spotify_url: ea.artist?.spotify_url ?? null,
        spotify_popularity: ea.artist?.spotify_popularity ?? null,
        soundcloud_url: ea.artist?.soundcloud_url ?? null,
        soundcloud_followers: ea.artist?.soundcloud_followers ?? null,
        bandcamp_url: ea.artist?.bandcamp_url ?? null,
        bandcamp_followers: ea.artist?.bandcamp_followers ?? null,
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
