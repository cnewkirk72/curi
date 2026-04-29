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
    // Phase 5.6 — lowercased SC profile slug. Used as the join key
    // against the signed-in user's follow set when computing the
    // FOLLOWED_ARTIST_BOOST. NULL when the artist has no SC URL or
    // the URL didn't match the strict profile-URL regex during the
    // 0022 backfill (see migration header for misses).
    soundcloud_username: string | null;
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
 * Phase 5.6 — flat additive bonus per matched followed artist in the
 * lineup. Sized so that ANY followed event outranks the most popular
 * unfollowed event: typical popularity-term contribution is bounded
 * around log2(1M followers) × 2 × HEADLINER_BOOST × POPULARITY_WEIGHT
 * ≈ 50 × 1.25 × 3 ≈ 188. A single non-headliner match (1000) crushes
 * that comfortably; multiple matches stack additively (so an event
 * with 3 followed artists ranks above an event with 1).
 *
 * Headliner matches multiply by HEADLINER_BOOST so the same artist
 * billed top-of-card pulls slightly ahead of a sub-billing.
 *
 * Unlike popularity (which uses MAX over the lineup), the follow
 * boost is summed — "more of the artists you follow are on this
 * lineup" is a directly stronger signal than "one of them is."
 */
const FOLLOWED_ARTIST_BOOST = 1000;

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
 *   - follow boost (Phase 5.6): SUM over the lineup of
 *     FOLLOWED_ARTIST_BOOST per artist whose `soundcloud_username` is
 *     in the signed-in user's follow set, with HEADLINER_BOOST applied
 *     for headliner matches. Sums (not max) because "more of the artists
 *     I follow are on this lineup" is a directly stronger signal — and
 *     the magnitude is sized so any followed event outranks every
 *     unfollowed event (see FOLLOWED_ARTIST_BOOST docstring above).
 *     The set parameter is optional; passing undefined or an empty Set
 *     yields the original (Phase 4) behavior so anon viewers get the
 *     same feed they did before this phase.
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
export function enrichmentScore(
  event: EnrichableEvent,
  followedSoundcloudUsernames?: Set<string>,
): number {
  const lineup = event.lineup;

  const hasAnyLink = lineup.some(
    (a) =>
      a.spotify_url !== null ||
      a.soundcloud_url !== null ||
      a.bandcamp_url !== null,
  );
  const completeness = (hasAnyLink ? 10 : 0) + (event.image_url ? 5 : 0);

  // Treat an empty/undefined set as "no follow signal at all" so we
  // can skip the per-artist Set.has() lookup entirely on anon paths.
  const hasFollows =
    !!followedSoundcloudUsernames && followedSoundcloudUsernames.size > 0;

  let topArtistPop = 0;
  let followBoost = 0;
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

    // Follow-graph match. Username is stored lowercased at write time
    // (migration 0022 backfill + scraper insert path), so naked equality
    // on the Set is correct without a per-call .toLowerCase() — keeps
    // the inner loop allocation-free.
    if (
      hasFollows &&
      a.soundcloud_username &&
      followedSoundcloudUsernames!.has(a.soundcloud_username)
    ) {
      followBoost += a.is_headliner
        ? FOLLOWED_ARTIST_BOOST * HEADLINER_BOOST
        : FOLLOWED_ARTIST_BOOST;
    }
  }

  return completeness + topArtistPop * POPULARITY_WEIGHT + followBoost;
}
