// Feed enrichment scoring. Kept separate from `events.ts` on purpose:
// `events.ts` imports the server-only Supabase client (which pulls in
// `next/headers`), so any client component that touches `events.ts`
// blows up the Vercel build with:
//
//   "You're importing a component that needs next/headers. That only
//    works in a Server Component..."
//
// This file is pure — no Next, no Supabase, no side effects — so the
// client `infinite-feed.tsx` can import it safely.

/**
 * Minimal structural type for `enrichmentScore`. Deliberately declared
 * inline rather than imported from `events.ts` so this module has zero
 * imports — the whole point of the extraction is to keep the server
 * graph out of the client bundle. `FeedEvent` is a structural supertype
 * of this shape, so callers can pass a `FeedEvent` directly and TS is
 * happy.
 */
type EnrichableEvent = {
  image_url: string | null;
  lineup: Array<{
    spotify_url: string | null;
    spotify_popularity: number | null;
    soundcloud_url: string | null;
    soundcloud_followers: number | null;
    bandcamp_url: string | null;
    bandcamp_followers: number | null;
  }>;
};

/**
 * How much popularity outweighs completeness in the final score. Bumped
 * from 1 → 3 after shipping the initial sort — feedback was that the feed
 * didn't lean hard enough on actually-popular acts. With this weight,
 * a 3-artist event with modest-to-good popularity data lands ~10x
 * higher than an event that's merely "has all the fields filled in."
 *
 * Completeness still matters: it's a tiebreaker for events where we have
 * no popularity signal (fresh scrapes, niche artists Spotify never heard
 * of), and its +5 hero-image bonus keeps image-backed events above
 * otherwise-equivalent text-only ones.
 *
 * Single top-level dial by design: the internal balance between
 * spotify_popularity (raw) and follower log2-scaling was tuned
 * intentionally, and we don't want to touch those each time the
 * overall weight shifts.
 */
const POPULARITY_WEIGHT = 3;

/**
 * "How enriched is this event?" — a hybrid signal used to sort events
 * within each day group in the feed (see `groupByDay` in
 * `infinite-feed.tsx`). Higher = more enriched.
 *
 * Why within-day rather than globally: the feed's primary ordering is
 * chronological, which is load-bearing for keyset pagination on
 * `(starts_at, id)`. Swapping that for a popularity order would break
 * the cursor contract. Resorting each day's bucket client-side keeps
 * pagination intact and still surfaces the richest events at the top
 * of each day.
 *
 * Scoring components:
 *   - completeness: +10 per lineup artist with any streaming link
 *     (spotify / soundcloud / bandcamp), +5 if the event has a hero
 *     image. For a typical 3-artist well-enriched event, ~35.
 *   - popularity (× POPULARITY_WEIGHT): `spotify_popularity` summed raw
 *     (0–100/artist), plus a log-scaled contribution from soundcloud +
 *     bandcamp follower counts (`log2(1 + followers) * 2`) so a viral
 *     100k-follower act doesn't completely drown out a solid 2k one.
 *
 * Note: this mutates nothing and reads only the structural fields
 * above, so it's safe to call during render.
 */
export function enrichmentScore(event: EnrichableEvent): number {
  const lineup = event.lineup;

  const artistsWithAnyLink = lineup.filter(
    (a) =>
      a.spotify_url !== null ||
      a.soundcloud_url !== null ||
      a.bandcamp_url !== null,
  ).length;
  const completeness = artistsWithAnyLink * 10 + (event.image_url ? 5 : 0);

  let popularity = 0;
  for (const a of lineup) {
    popularity += a.spotify_popularity ?? 0;
    if (a.soundcloud_followers) {
      popularity += Math.log2(1 + a.soundcloud_followers) * 2;
    }
    if (a.bandcamp_followers) {
      popularity += Math.log2(1 + a.bandcamp_followers) * 2;
    }
  }

  return completeness + popularity * POPULARITY_WEIGHT;
}
