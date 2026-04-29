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
 */
export type LineupArtist = {
  name: string;
  position: number;
  is_headliner: boolean;
  image_url: string | null;
  spotify_url: string | null;
  spotify_popularity: number | null;
  soundcloud_url: string | null;
  soundcloud_followers: number | null;
  bandcamp_url: string | null;
  bandcamp_followers: number | null;
  // Phase 5.6 — normalized lowercased SoundCloud profile slug from
  // migration 0022. Join key for user_soundcloud_follows.
  soundcloud_username: string | null;
  // Phase 5.7 — Spotify artist ID (the base62 string in
  // open.spotify.com/artist/{id} URLs). Already populated for every
  // artist with a spotify_url from the Phase 4 enrichment pass. Join
  // key for the user's Spotify follow graph in user_spotify_follows;
  // consumed by the SPOTIFY tier in feedScore() and by the
  // FollowDotStack badge on EventCard / LineupList.
  spotify_id: string | null;
};

export type FeedEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  genres: string[];
  vibes: string[];
  setting: string[];
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: {
    name: string;
    neighborhood: string | null;
    slug: string;
    image_url: string | null;
  } | null;
  lineup: LineupArtist[];
};

export type DetailEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  description: string | null;
  genres: string[];
  vibes: string[];
  setting: string[];
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
    image_url: string | null;
  } | null;
  lineup: LineupArtist[];
};

type EventRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  genres: string[] | null;
  vibes: string[] | null;
  setting: string[] | null;
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: {
    name: string;
    neighborhood: string | null;
    slug: string;
    image_url: string | null;
  } | null;
  event_artists:
    | {
        position: number;
        is_headliner: boolean;
        artist: {
          name: string;
          spotify_image_url: string | null;
          soundcloud_image_url: string | null;
          bandcamp_image_url: string | null;
          spotify_url: string | null;
          spotify_popularity: number | null;
          soundcloud_url: string | null;
          soundcloud_followers: number | null;
          soundcloud_username: string | null;
          spotify_id: string | null;
          bandcamp_url: string | null;
          bandcamp_followers: number | null;
        } | null;
      }[]
    | null;
};

export type FeedCursor = {
  afterStartsAt: string;
  afterId: string;
};

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
      setting,
      price_min,
      price_max,
      ticket_url,
      venue:venues (
        name,
        neighborhood,
        slug,
        image_url
      ),
      event_artists (
        position,
        is_headliner,
        artist:artists (
          name,
          spotify_image_url,
          soundcloud_image_url,
          bandcamp_image_url,
          spotify_url,
          spotify_popularity,
          soundcloud_url,
          soundcloud_followers,
          soundcloud_username,
          spotify_id,
          bandcamp_url,
          bandcamp_followers
        )
      )
      `,
    )
    .eq('city', 'NYC')
    .gte('starts_at', startIso);

  if (endIso) {
    query = query.lt('starts_at', endIso);
  }

  if (cursor) {
    query = query.or(
      `starts_at.gt.${cursor.afterStartsAt},and(starts_at.eq.${cursor.afterStartsAt},id.gt.${cursor.afterId})`,
    );
  }

  if (filters.q) {
    const escaped = filters.q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    query = query.ilike('title', `%${escaped}%`);
  }
  if (filters.genres.length) {
    query = query.overlaps('genres', filters.genres);
  }
  if (filters.vibes.length) {
    query = query.overlaps('vibes', filters.vibes);
  }
  if (filters.setting.length) {
    query = query.overlaps('setting', filters.setting);
  }

  if (filters.artist) {
    const { data: artistRow, error: artistErr } = await supabase
      .from('artists')
      .select('id')
      .eq('slug', filters.artist)
      .maybeSingle();

    if (artistErr) {
      console.error('[events] artist slug lookup failed:', artistErr.message);
      return [];
    }
    if (!artistRow) return [];

    const { data: linkRows, error: linkErr } = await supabase
      .from('event_artists')
      .select('event_id')
      .eq('artist_id', (artistRow as { id: string }).id);

    if (linkErr) {
      console.error('[events] artist event-link lookup failed:', linkErr.message);
      return [];
    }
    const eventIds = Array.from(
      new Set((linkRows ?? []).map((r) => (r as { event_id: string }).event_id)),
    );
    if (eventIds.length === 0) return [];
    query = query.in('id', eventIds);
  }

  if (filters.venue) {
    const { data: venueRow, error: venueErr } = await supabase
      .from('venues')
      .select('id')
      .eq('slug', filters.venue)
      .maybeSingle();

    if (venueErr) {
      console.error('[events] venue slug lookup failed:', venueErr.message);
      return [];
    }
    if (!venueRow) return [];
    query = query.eq('venue_id', (venueRow as { id: string }).id);
  }

  if (filters.subgenres.length > 0) {
    const { data: artistRows, error: artistErr } = await supabase
      .from('artists')
      .select('id')
      .overlaps('subgenres', filters.subgenres);

    if (artistErr) {
      console.error('[events] subgenre artist lookup failed:', artistErr.message);
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
      console.error('[events] subgenre event-artist lookup failed:', linkErr.message);
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

  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[events] getUpcomingEvents failed:', error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as EventRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    image_url: row.image_url,
    genres: row.genres ?? [],
    vibes: row.vibes ?? [],
    setting: row.setting ?? [],
    price_min: row.price_min,
    price_max: row.price_max,
    ticket_url: row.ticket_url,
    venue: row.venue
      ? {
          name: row.venue.name,
          neighborhood: row.venue.neighborhood,
          slug: row.venue.slug,
          image_url: row.venue.image_url,
        }
      : null,
    lineup: (row.event_artists ?? [])
      .map((ea) => ({
        name: ea.artist?.name ?? '',
        position: ea.position,
        is_headliner: ea.is_headliner,
        image_url:
          ea.artist?.spotify_image_url ??
          ea.artist?.soundcloud_image_url ??
          ea.artist?.bandcamp_image_url ??
          null,
        spotify_url: ea.artist?.spotify_url ?? null,
        spotify_popularity: ea.artist?.spotify_popularity ?? null,
        soundcloud_url: ea.artist?.soundcloud_url ?? null,
        soundcloud_followers: ea.artist?.soundcloud_followers ?? null,
        soundcloud_username: ea.artist?.soundcloud_username ?? null,
        spotify_id: ea.artist?.spotify_id ?? null,
        bandcamp_url: ea.artist?.bandcamp_url ?? null,
        bandcamp_followers: ea.artist?.bandcamp_followers ?? null,
      }))
      .filter((a) => a.name.length > 0)
      .sort((a, b) => a.position - b.position),
  }));
}

type EventDetailDbRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  description: string | null;
  genres: string[] | null;
  vibes: string[] | null;
  setting: string[] | null;
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
        image_url: string | null;
      }
    | null;
  event_artists:
    | {
        position: number;
        is_headliner: boolean;
        artist: {
          name: string;
          spotify_image_url: string | null;
          soundcloud_image_url: string | null;
          bandcamp_image_url: string | null;
          spotify_url: string | null;
          spotify_popularity: number | null;
          soundcloud_url: string | null;
          soundcloud_followers: number | null;
          soundcloud_username: string | null;
          spotify_id: string | null;
          bandcamp_url: string | null;
          bandcamp_followers: number | null;
        } | null;
      }[]
    | null;
};

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
      setting,
      price_min,
      price_max,
      ticket_url,
      venue:venues (
        name,
        slug,
        neighborhood,
        lat,
        lng,
        website,
        image_url
      ),
      event_artists (
        position,
        is_headliner,
        artist:artists (
          name,
          spotify_image_url,
          soundcloud_image_url,
          bandcamp_image_url,
          spotify_url,
          spotify_popularity,
          soundcloud_url,
          soundcloud_followers,
          soundcloud_username,
          spotify_id,
          bandcamp_url,
          bandcamp_followers
        )
      )
      `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
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
    setting: row.setting ?? [],
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
          image_url: row.venue.image_url,
        }
      : null,
    lineup: (row.event_artists ?? [])
      .map((ea) => ({
        name: ea.artist?.name ?? '',
        position: ea.position,
        is_headliner: ea.is_headliner,
        image_url:
          ea.artist?.spotify_image_url ??
          ea.artist?.soundcloud_image_url ??
          ea.artist?.bandcamp_image_url ??
          null,
        spotify_url: ea.artist?.spotify_url ?? null,
        spotify_popularity: ea.artist?.spotify_popularity ?? null,
        soundcloud_url: ea.artist?.soundcloud_url ?? null,
        soundcloud_followers: ea.artist?.soundcloud_followers ?? null,
        soundcloud_username: ea.artist?.soundcloud_username ?? null,
        spotify_id: ea.artist?.spotify_id ?? null,
        bandcamp_url: ea.artist?.bandcamp_url ?? null,
        bandcamp_followers: ea.artist?.bandcamp_followers ?? null,
      }))
      .filter((a) => a.name.length > 0)
      .sort((a, b) => {
        if (a.is_headliner !== b.is_headliner) return a.is_headliner ? -1 : 1;
        return a.position - b.position;
      }),
  };
}
