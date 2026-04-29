// Phase 5.6 + 5.7 — SoundCloud + Spotify follow-graph data fetchers.
// Server-only, gated by user_soundcloud_follows + user_spotify_follows
// owner-RLS policies (migrations 0022 + 0023): the signed-in user can
// only see their own rows. Anon viewers and signed-in users with no
// follows both get [].
//
// The follow sets are consumed by `feedScore` in lib/enrichment.ts to
// add tier floors on events whose lineup overlaps the user's follow
// graph (BOTH > Spotify > SC > none), by
// `getFollowedEventsInWindow` / `getFollowedSpotifyEventsInWindow`
// (below) to augment the SSR'd candidate pool with followed events
// that fall outside the chronological page cap, and by
// `EventCard` / `LineupList` to render the FollowDotStack indicator.

import { createClient } from '@/lib/supabase/server';
import { dateWindowFor, type FilterState } from '@/lib/filters';
import type { FeedEvent } from '@/lib/events';

/**
 * Fetch the lowercased SoundCloud usernames the signed-in user follows.
 *
 * Returns an array (not a Set) so it can be passed across the RSC
 * boundary as plain JSON without serialization tricks.
 */
export async function getUserFollowedSoundcloudUsernames(): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_soundcloud_follows')
    .select('soundcloud_username');

  if (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getUserFollowedSoundcloudUsernames failed:',
      error.message,
    );
    return [];
  }

  const rows = (data ?? []) as unknown as { soundcloud_username: string }[];
  return rows.map((r) => r.soundcloud_username);
}

/**
 * Phase 5.7 — fetch the Spotify artist IDs the signed-in user follows.
 *
 * Returns base62 IDs (the segment after `https://open.spotify.com/artist/`).
 * Mirrors the SC counterpart: array on the wire, Set rebuild on the
 * client side for O(1) lookup. Same anon-safe / unconnected-user
 * behavior — RLS returns [] for both.
 *
 * The IDs are stored exactly as Spotify exposes them (case-sensitive
 * base62), so the consumer's `.has(artist.spotify_id)` against the
 * Set is a direct comparison — no normalization needed.
 */
export async function getUserFollowedSpotifyArtistIds(): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_spotify_follows')
    .select('spotify_artist_id');

  if (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getUserFollowedSpotifyArtistIds failed:',
      error.message,
    );
    return [];
  }

  const rows = (data ?? []) as unknown as { spotify_artist_id: string }[];
  return rows.map((r) => r.spotify_artist_id);
}

/**
 * Hard cap on the number of followed-artist events injected into
 * the SSR'd page per platform. Same value applies to both SC and
 * Spotify injectors.
 */
const MAX_FOLLOWED_EXTRAS = 50;

/**
 * Phase 5.6 — fetch events in the date window where the lineup
 * features any artist the signed-in user follows on SoundCloud.
 *
 * See module header for the architectural rationale; same shape as
 * `getFollowedSpotifyEventsInWindow` below.
 */
export async function getFollowedEventsInWindow(
  filters: FilterState,
  followedSoundcloudUsernames: string[],
): Promise<FeedEvent[]> {
  if (followedSoundcloudUsernames.length === 0) return [];

  const supabase = createClient();
  const { startIso, endIso } = dateWindowFor(filters);

  const { data: artistRows, error: artistErr } = await supabase
    .from('artists')
    .select('id')
    .in('soundcloud_username', followedSoundcloudUsernames);

  if (artistErr) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getFollowedEventsInWindow artist lookup failed:',
      artistErr.message,
    );
    return [];
  }

  const artistIds = (artistRows ?? []).map(
    (r) => (r as { id: string }).id,
  );
  if (artistIds.length === 0) return [];

  return fetchEventsByArtistIds(artistIds, startIso, endIso);
}

/**
 * Phase 5.7 — fetch events in the date window where the lineup
 * features any artist the signed-in user follows on Spotify.
 *
 * Mirrors `getFollowedEventsInWindow`. Resolves Spotify artist IDs
 * (`artists.spotify_id`) → internal artist UUIDs → events. Same anon /
 * empty-set short-circuits, same date-window honoring, same
 * MAX_FOLLOWED_EXTRAS cap.
 */
export async function getFollowedSpotifyEventsInWindow(
  filters: FilterState,
  followedSpotifyArtistIds: string[],
): Promise<FeedEvent[]> {
  if (followedSpotifyArtistIds.length === 0) return [];

  const supabase = createClient();
  const { startIso, endIso } = dateWindowFor(filters);

  const { data: artistRows, error: artistErr } = await supabase
    .from('artists')
    .select('id')
    .in('spotify_id', followedSpotifyArtistIds);

  if (artistErr) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getFollowedSpotifyEventsInWindow artist lookup failed:',
      artistErr.message,
    );
    return [];
  }

  const artistIds = (artistRows ?? []).map(
    (r) => (r as { id: string }).id,
  );
  if (artistIds.length === 0) return [];

  return fetchEventsByArtistIds(artistIds, startIso, endIso);
}

// ─── Shared helper ─────────────────────────────────────────────────────
//
// Both injectors converge on the same query once they've resolved
// artist UUIDs. Extracted to keep the two callers thin and avoid
// accidental projection drift between SC and Spotify branches.

async function fetchEventsByArtistIds(
  artistIds: string[],
  startIso: string,
  endIso: string | null,
): Promise<FeedEvent[]> {
  const supabase = createClient();

  const { data: linkRows, error: linkErr } = await supabase
    .from('event_artists')
    .select('event_id')
    .in('artist_id', artistIds);

  if (linkErr) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] fetchEventsByArtistIds event-link lookup failed:',
      linkErr.message,
    );
    return [];
  }
  const eventIds = Array.from(
    new Set((linkRows ?? []).map((r) => (r as { event_id: string }).event_id)),
  );
  if (eventIds.length === 0) return [];

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
    .gte('starts_at', startIso)
    .in('id', eventIds);

  if (endIso) {
    query = query.lt('starts_at', endIso);
  }

  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(MAX_FOLLOWED_EXTRAS);

  if (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] fetchEventsByArtistIds events fetch failed:',
      error.message,
    );
    return [];
  }

  const rows = (data ?? []) as unknown as Array<{
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
  }>;

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
