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
    is_headliner: boolean;
    spotify_url: string | null;
    spotify_popularity: number | null;
    soundcloud_url: string | null;
    soundcloud_followers: number | null;
    bandcamp_url: string | null;
    bandcamp_followers: number | null;
  }>;
};

/**
 * How much popularity outweighs completeness in the final score. With
 * popularity derived from the TOP act (not summed), the range of the
 * popularity term is bounded — a log2 of 1M followers is ~40 — so the
 * weight here is what makes it dominate the flat completeness bonus.
 *
 * Single top-level dial by design: the internal balance between
 * spotify_popularity (raw) and follower log2-scaling was tuned
 * intentionally, and we don't want to touch those each time the
 * overall weight shifts.
 */
const POPULARITY_WEIGHT = 3;

/**
 * Bonus applied to an artist's popularity when `is_headliner` is set.
 * Small enough that a non-headliner with meaningfully more followers
 * still wins, large enough that an advertised top-of-the-bill pulls
 * ahead of a similarly-sized support act.
 */
const HEADLINER_BOOST = 1.25;

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
 *   - completeness (flat): +10 if the event has at least one artist
 *     with a streaming link, +5 if there's a hero image. Deliberately
 *     NOT count-based — the previous "× number of artists" formulation
 *     structurally favored 9-DJ warehouse bills over 2-DJ star-led
 *     nights, which is the opposite of what we want.
 *   - popularity (× POPULARITY_WEIGHT): MAX over the lineup of each
 *     artist's own popularity score. Per-artist popularity is
 *     `spotify_popularity` (raw 0–100, currently dead in DB — see note
 *     below) + log-scaled soundcloud + bandcamp follower contributions,
 *     multiplied by HEADLINER_BOOST if the artist is billed as
 *     headliner. Using MAX rather than SUM means one major act
 *     outranks a long bill of mid-tier acts, which matches how
 *     people actually think about "is this show big."
 *
 * Note on `spotify_popularity`: Spotify's Nov-2024 API policy change
 * dropped `popularity`, `followers`, and `genres` from /artists/{id}
 * responses for apps without Extended Quota Mode. Every Spotify-linked
 * artist in the DB has popularity = 0 as a result. We keep the term in
 * the formula so that if we ever backfill from Last.fm (or manually
 * tier known names), the scoring picks it up automatically — but today
 * the actual signal comes entirely from soundcloud + bandcamp.
 *
 * This function mutates nothing and reads only the structural fields
 * above, so it's safe to call during render.
 */
export function enrichmentScore(event: EnrichableEvent): number {
  const lineup = event.lineup;

  const hasAnyLink = lineup.some(
    (a) =>
      a.spotify_url !== null ||
      a.soundcloud_url !== null ||
      a.bandcamp_url !== null,
  );
  const completeness = (hasAnyLink ? 10 : 0) + (event.image_url ? 5 : 0);

  let topArtistPop = 0;
  for (const a of lineup) {
    let pop = a.spotify_popularity ?? 0;
    if (a.soundcloud_followers) {
      pop += Math.log2(1 + a.soundcloud_followers) * 2;
    }
    if (a.bandcamp_followers) {
      pop += Math.log2(1 + a.bandcamp_followers) * 2;
    }
    if (a.is_headliner) pop *= HEADLINER_BOOST;
    if (pop > topArtistPop) topArtistPop = pop;
  }

  return completeness + topArtistPop * POPULARITY_WEIGHT;
}
