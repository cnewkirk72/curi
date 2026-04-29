// Phase 5.6 + 5.7 — SoundCloud follow-graph data fetchers. Server-only,
// gated by user_soundcloud_follows's owner-RLS policies (migration
// 0022): the signed-in user can only see their own rows. Anon viewers
// and signed-in users with no follows both get [].
//
// Why a separate module rather than folding into saves.ts: the two
// concerns are logically distinct (saves are user → event, follows
// are user → artist), and the home page parallel-fetches both, so
// keeping them as siblings makes the call sites at the page layer
// read symmetrically (`getSavedEventIds` + `getUserFollowedSoundcloudUsernames`).
//
// The follow set is consumed by `feedScore` in lib/enrichment.ts to
// add a flat tier-floor on events whose lineup overlaps the user's
// follow graph, by `getFollowedEventsInWindow` (below) to augment
// the SSR'd candidate pool with followed events that fall outside
// the chronological page cap, and by `EventCard` to render the
// follow indicator dot on matching artist avatars.

import { createClient } from '@/lib/supabase/server';
import { dateWindowFor, type FilterState } from '@/lib/filters';
import type { FeedEvent } from '@/lib/events';

/**
 * Fetch the lowercased SoundCloud usernames the signed-in user follows.
 *
 * Returns an array (not a Set) so it can be passed across the RSC
 * boundary as plain JSON without serialization tricks. The client side
 * (`InfiniteFeed`) rebuilds a Set with `useMemo` for O(1) lookups
 * during the within-day re-sort — same pattern we use for `savedIds`.
 *
 * Usernames are stored lowercased at write time (migration 0022
 * backfill + the Phase 5.6.2 scraper insert path), so the array is
 * already case-normalized; the Set on the client side can do naked
 * `.has(a.soundcloud_username)` against it without any per-call
 * `.toLowerCase()`.
 *
 * Anon viewers: RLS returns [] with no error.
 * Signed-in user with no follows yet (hasn't connected SC, or
 * connected but the sync hasn't run): also [].
 */
export async function getUserFollowedSoundcloudUsernames(): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_soundcloud_follows')
    .select('soundcloud_username');

  if (error) {
    // Match the soft-fail pattern used by saves.ts / events.ts —
    // log to console (catches RLS / env drift in dev) but return
    // empty so the page renders. A broken follow fetch should not
    // break the feed; it should just yield the pre-Phase-5.6 sort.
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getUserFollowedSoundcloudUsernames failed:',
      error.message,
    );
    return [];
  }

  // Same ssr-0.5.1 inference quirk as saves.ts: PostgREST row type
  // resolves to `never` despite the generated Database type being
  // correct. Cast via unknown to a minimal row shape.
  const rows = (data ?? []) as unknown as { soundcloud_username: string }[];
  return rows.map((r) => r.soundcloud_username);
}

/**
 * Hard cap on the number of followed-artist events we'll inject into
 * the SSR'd page. Sized for the upper bound of "in the next 30 days,
 * how many shows might a power-user-follow-set's artists collectively
 * play in NYC?" — call it 20-30 for a typical case, 50 as a safe ceiling.
 *
 * If we ever hit the cap in practice it means the user has more
 * followed events than chronological page cap (100) anyway, so they're
 * not at risk of missing a followed event due to cap interaction.
 */
const MAX_FOLLOWED_EXTRAS = 50;

/**
 * Phase 5.7 — fetch events in the date window where the lineup
 * features any artist the signed-in user follows on SoundCloud.
 *
 * Used by the home page to augment the chronologically-paged candidate
 * pool. Without this, an event featuring a followed artist that falls
 * past chronological position N (the SSR page cap) would never appear
 * in the SSR'd feed — the client-side within-day sort can only re-rank
 * what the server returned. With this, every followed event in the
 * window is in the candidate set, and the within-day comparator
 * surfaces it to the top via the FOLLOWED_TIER_FLOOR boost in
 * `feedScore`.
 *
 * Implementation strategy (3 cheap queries instead of one heavy join):
 *   1. Resolve user's followed SC usernames → artist IDs via
 *      `artists.soundcloud_username` (lowercased on both sides).
 *   2. Resolve those artist IDs → event IDs via `event_artists`.
 *   3. Fetch the matching events with the same projection as
 *      `getUpcomingEvents`, filtered by the date window.
 *
 * Each step hits an indexed column (artists_sc_username_lower_idx
 * from migration 0022, event_artists_artist_id_idx, events_starts_at_idx).
 * The total cost is O(N follows) at step 1, O(M events) at step 2,
 * and a bounded fetch at step 3 — vastly cheaper than a multi-join
 * SQL query against the public anon role's RLS-filtered view.
 *
 * Anon path: `followedSoundcloudUsernames` is empty → returns []
 * without any DB calls. Same shape for signed-in users who haven't
 * connected SC.
 *
 * Errors are logged and swallowed (return []), matching the soft-fail
 * pattern in `getUpcomingEvents` and `getUserFollowedSoundcloudUsernames` —
 * a broken follow-extras fetch shouldn't blank the feed.
 *
 * @param filters Same FilterState the home page constructs from search
 *                params. We honor the date window only — explicit
 *                genre/vibe filters intentionally DO NOT apply here.
 *                Rationale: a user filtering to "techno" still wants
 *                to be reminded that an artist they follow is playing
 *                a non-techno show that night; the explicit follow
 *                signal trumps the on-screen genre filter for the
 *                "you follow this" surface. (If they truly want to
 *                hide it, they can clear the follow connection.)
 *                Date window is honored because "tomorrow" really
 *                means tomorrow — bringing in a followed event for
 *                next week into the tomorrow view would be confusing.
 * @param followedSoundcloudUsernames Lowercased SC slugs the user
 *                follows. Pass directly from
 *                getUserFollowedSoundcloudUsernames so we don't
 *                round-trip through Supabase twice on the same page
 *                load.
 */
export async function getFollowedEventsInWindow(
  filters: FilterState,
  followedSoundcloudUsernames: string[],
): Promise<FeedEvent[]> {
  if (followedSoundcloudUsernames.length === 0) return [];

  const supabase = createClient();
  const { startIso, endIso } = dateWindowFor(filters);

  // 1. Followed usernames → artist IDs.
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

  // 2. Artist IDs → event IDs in the date window. We do the date-window
  //    filter on the events query (step 3) rather than here, because
  //    event_artists doesn't carry starts_at; pulling event IDs without
  //    the date filter and then constraining at step 3 is the cheapest
  //    PostgREST-friendly path.
  const { data: linkRows, error: linkErr } = await supabase
    .from('event_artists')
    .select('event_id')
    .in('artist_id', artistIds);

  if (linkErr) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getFollowedEventsInWindow event-link lookup failed:',
      linkErr.message,
    );
    return [];
  }
  const eventIds = Array.from(
    new Set((linkRows ?? []).map((r) => (r as { event_id: string }).event_id)),
  );
  if (eventIds.length === 0) return [];

  // 3. Fetch the events with the same projection as getUpcomingEvents,
  //    filtered by date window AND the eventIds set. We do NOT apply
  //    user-supplied genre/vibe/setting filters here — see the JSDoc
  //    above for the rationale.
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

  // Order chronologically and cap. Even if a power user follows hundreds
  // of artists, MAX_FOLLOWED_EXTRAS keeps the result bounded; the
  // chronological tail just won't appear in the followed-tier injection
  // (it would still surface via normal pagination).
  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(MAX_FOLLOWED_EXTRAS);

  if (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getFollowedEventsInWindow events fetch failed:',
      error.message,
    );
    return [];
  }

  // Cast + project — same shape transform as getUpcomingEvents. Kept
  // duplicated here rather than extracted into a shared mapper because
  // the two call sites have slightly different concerns (getUpcoming
  // applies user-filter logic; this one doesn't), and unifying the
  // mapper would require either a config object or a shared private
  // helper. The duplication is ~30 lines; cheap maintenance vs.
  // premature abstraction.
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
        bandcamp_url: ea.artist?.bandcamp_url ?? null,
        bandcamp_followers: ea.artist?.bandcamp_followers ?? null,
      }))
      .filter((a) => a.name.length > 0)
      .sort((a, b) => a.position - b.position),
  }));
}
