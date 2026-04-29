// Saved-event data fetchers. Server-only.
//
// `user_saves` is gated by the owner-only RLS policy from
// migration 0001 (`user_saves_select_own`), so these queries
// automatically filter to the signed-in user — no need to
// repeat the auth check in the select predicate. If the viewer
// is signed out, Supabase returns [] rather than 403.

import { createClient } from '@/lib/supabase/server';
import type { FeedEvent } from '@/lib/events';

// Row shape when we join user_saves → events → venues. Same
// reason as EventRow in events.ts: PostgREST infers joined
// rows as `never`, so we hand-type.
type SavedRow = {
  event: {
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
  } | null;
};

/**
 * Fetch the signed-in user's saved events as FeedEvent[], ordered
 * by event start time (so the Saved page reads like a mini-feed
 * of "what's coming up on your list").
 *
 * Returns [] for unauthenticated viewers — the caller is expected
 * to render a signed-out CTA separately, based on their own auth
 * check (we don't force that concern down into the fetcher).
 */
export async function getSavedEvents(): Promise<FeedEvent[]> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('user_saves')
    .select(
      `
      event:events (
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
      )
      `,
    )
    // Chronological by event time, not by save time. Users want
    // "what's coming up next that I've saved," not "what did I
    // bookmark most recently."
    .order('starts_at', { referencedTable: 'events', ascending: true });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[saves] getSavedEvents failed:', error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as SavedRow[];

  return rows
    .map((r) => r.event)
    .filter((e): e is NonNullable<SavedRow['event']> => e !== null)
    .map((e) => ({
      id: e.id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      image_url: e.image_url,
      genres: e.genres ?? [],
      vibes: e.vibes ?? [],
      setting: e.setting ?? [],
      price_min: e.price_min,
      price_max: e.price_max,
      ticket_url: e.ticket_url,
      venue: e.venue
        ? {
            name: e.venue.name,
            neighborhood: e.venue.neighborhood,
            slug: e.venue.slug,
            image_url: e.venue.image_url,
          }
        : null,
      lineup: (e.event_artists ?? [])
        .map((ea) => ({
          name: ea.artist?.name ?? '',
          position: ea.position,
          is_headliner: ea.is_headliner,
          image_url: ea.artist?.spotify_image_url ?? null,
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

/**
 * Fetch the set of event ids the signed-in user has saved.
 *
 * The feed uses this to render each card's bookmark in the right
 * initial state without firing N queries — we pull the whole id
 * set once per request, then pass it down as a Set for O(1)
 * lookups.
 *
 * Returns empty set for unauth viewers (RLS — see header).
 */
export async function getSavedEventIds(): Promise<Set<string>> {
  const supabase = createClient();
  const { data, error } = await supabase.from('user_saves').select('event_id');

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[saves] getSavedEventIds failed:', error.message);
    return new Set();
  }
  // Same ssr-0.5.1 inference quirk as save-actions.ts: the row type
  // here resolves to `never` despite the generated Database type
  // being correct. Cast via unknown to a minimal row shape.
  const rows = (data ?? []) as unknown as { event_id: string }[];
  return new Set(rows.map((r) => r.event_id));
}

/**
 * Count how many events the signed-in user has saved. Surfaced on
 * the Profile page as a stat, and cheap to query (count-only).
 */
export async function getSaveCount(): Promise<number> {
  const supabase = createClient();
  const { count, error } = await supabase
    .from('user_saves')
    .select('*', { count: 'exact', head: true });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[saves] getSaveCount failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * Cheap boolean for the detail page: is *this* event saved?
 * Used instead of pulling the whole id set when we only need
 * one answer.
 */
export async function isEventSaved(eventId: string): Promise<boolean> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_saves')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[saves] isEventSaved failed:', error.message);
    return false;
  }
  return !!data;
}
