// Phase 5.7 — feed score function. Drives within-day sort in the home
// feed and /saved. Replaces the Phase 5.6 `enrichmentScore` with a
// richer, intent-aligned formula:
//
//   1. Followed-artist events → tier floor + summed popularity
//      (so they always outrank unfollowed events; among themselves
//      they sort by how popular the lineup is)
//   2. Other events → weighted combination of summed popularity +
//      genre-pref match count, with popularity weighted more
//
// Kept separate from `events.ts` on purpose: `events.ts` imports the
// server-only Supabase client (which pulls in `next/headers`), so any
// client component that touches `events.ts` blows up the Vercel build:
//
//   "You're importing a component that needs next/headers. That only
//    works in a Server Component..."
//
// This file is pure — no Next, no Supabase, no side effects — so the
// client `infinite-feed.tsx` can import it safely.
//
// Anon-safe by design: `followedSoundcloudUsernames` and
// `preferredGenres` are both optional. Empty/undefined arguments fall
// back to a pure popularity sort, which is the correct behavior for
// the un-signed-in browse path (Curi has a no-auth UX path; the feed
// must rank usefully without any user signal).

/**
 * Minimal structural type for `feedScore`. Deliberately declared
 * inline rather than imported from `events.ts` so this module has zero
 * imports — the whole point of the extraction is to keep the server
 * graph out of the client bundle. `FeedEvent` is a structural supertype
 * of this shape, so callers can pass a `FeedEvent` directly and TS is
 * happy.
 */
type ScorableEvent = {
  /** Used by genre-pref match. */
  genres: string[];
  lineup: Array<{
    is_headliner: boolean;
    spotify_popularity: number | null;
    soundcloud_followers: number | null;
    bandcamp_followers: number | null;
    /** Phase 5.6 — lowercased SC profile slug. Join key against the
     *  signed-in user's follow set. NULL when the artist has no SC URL
     *  or the URL didn't match the strict profile-URL regex during
     *  the migration 0022 backfill (see header for the miss list). */
    soundcloud_username: string | null;
  }>;
};

/**
 * Bonus applied to an artist's contribution when `is_headliner` is set.
 * Same value as Phase 5.6 (preserved). Small enough that a non-headliner
 * with meaningfully more followers still wins, large enough that an
 * advertised top-of-the-bill pulls ahead of a similarly-sized support
 * act.
 */
const HEADLINER_BOOST = 1.25;

/**
 * Phase 5.7 — weight on the summed-popularity term. Christian's spec:
 * "summed artist popularity should be weighted more" than the
 * genre-pref match term. Weight 1 here means popularity contributes
 * its raw magnitude; the genre-pref weight is the modulator below.
 *
 * Single top-level dial — the internal balance between
 * spotify_popularity (raw 0–100) and follower log2-scaling stays
 * fixed inside the per-artist contribution loop.
 */
const POPULARITY_WEIGHT = 1;

/**
 * Phase 5.7 — additive boost per matching preferred genre on the event.
 * Sized so it meaningfully reorders unfollowed events with similar
 * popularity, without overwhelming the popularity term.
 *
 * Calibration sketch:
 *   - Typical 3-artist mid-tier lineup: per-artist popularity ~25–35,
 *     summed (with one headliner) ≈ 90.
 *   - A high-tier lineup with a 1M-follower headliner: per-artist
 *     popularity ~50, summed ≈ 150–180.
 *   - Genre matches typically 0–3 (user has 3–5 preferred genres,
 *     event tags 1–3 genres, intersection 0–2).
 *
 * At W_PREF = 25, a 2-genre match (+50) is worth roughly the gap
 * between a mid-tier and high-tier lineup — significant but not
 * overwhelming. A high-tier lineup with 0 genre matches still beats
 * a low-tier lineup with 2 genre matches (180 > 50 + 50 = 100).
 */
const GENRE_PREF_WEIGHT = 25;

/**
 * Phase 5.7 — followed-event tier floor. Added to every followed
 * event's score so the entire followed-tier sits above the entire
 * unfollowed-tier.
 *
 * 1e6 is comfortable headroom: the heaviest unfollowed score we can
 * realistically construct is summed-popularity over a 10-artist lineup
 * with all-headliner all-1M-follower acts ≈ 50 × 10 × 1.25 ≈ 625, plus
 * (impossibly) 10 genre matches × 25 = 250. Total ≈ 875. 1e6 dwarfs
 * that by 1000×, so the tier separation is unambiguous.
 *
 * Within the followed tier, events sort by summed popularity (no
 * additional weight applied — followed-tier ranking is purely
 * "how big is this lineup"). Genre-pref doesn't apply inside the
 * followed tier because the user's explicit follow signal already
 * dominates the intent.
 */
const FOLLOWED_TIER_FLOOR = 1_000_000;

/**
 * Compute one artist's popularity contribution. Pulled out so both the
 * unfollowed-tier (weighted by POPULARITY_WEIGHT) and the followed-tier
 * (raw, used for in-tier ranking) call the same code.
 *
 * Per-artist signal:
 *   - spotify_popularity (raw 0–100). NOTE: Spotify's Nov-2024 API
 *     policy change dropped `popularity` from /artists/{id} responses
 *     for apps without Extended Quota Mode. Every Spotify-linked
 *     artist in the DB has popularity = 0 today. Term kept so a future
 *     Last.fm or manual-tier backfill picks up automatically.
 *   - soundcloud_followers, log2-scaled × 2. log2(1M) ≈ 20, × 2 = 40.
 *   - bandcamp_followers, same shape.
 *   - HEADLINER_BOOST multiplier when is_headliner.
 */
function artistPopularity(a: ScorableEvent['lineup'][number]): number {
  let pop = a.spotify_popularity ?? 0;
  if (a.soundcloud_followers) {
    pop += Math.log2(1 + a.soundcloud_followers) * 2;
  }
  if (a.bandcamp_followers) {
    pop += Math.log2(1 + a.bandcamp_followers) * 2;
  }
  if (a.is_headliner) pop *= HEADLINER_BOOST;
  return pop;
}

/**
 * Score an event for the feed sort. Higher = ranks earlier within the
 * day group.
 *
 * Sort tiers (high-to-low):
 *   1. Followed-artist events: FOLLOWED_TIER_FLOOR + summed-popularity.
 *      Among themselves, sort by lineup popularity. Genre-pref ignored
 *      in this tier because the explicit follow signal is stronger.
 *   2. Unfollowed events: POPULARITY_WEIGHT × summed-popularity +
 *      GENRE_PREF_WEIGHT × genre-pref match count.
 *
 * Anon path / un-onboarded path:
 *   - `followedSoundcloudUsernames` undefined or empty → no event
 *     enters the followed tier; everyone competes on popularity +
 *     genre-pref.
 *   - `preferredGenres` undefined or empty → genre-pref term is 0;
 *     pure popularity sort.
 *   - Both empty → pure popularity sort. This is the un-signed-in
 *     browse experience and yields a sensible "biggest events first"
 *     ordering with no user signal.
 *
 * This function mutates nothing and reads only the structural fields
 * above, so it's safe to call during render. Keep it allocation-free
 * inside the inner loop — the client comparator runs it O(n log n)
 * per render.
 */
export function feedScore(
  event: ScorableEvent,
  followedSoundcloudUsernames?: Set<string>,
  preferredGenres?: ReadonlySet<string>,
): number {
  const hasFollows =
    !!followedSoundcloudUsernames && followedSoundcloudUsernames.size > 0;
  const hasGenrePrefs =
    !!preferredGenres && preferredGenres.size > 0;

  // Single pass over the lineup: accumulate summed popularity AND
  // detect followed-tier membership in one loop. Followed detection
  // short-circuits popularity accumulation NOT — we want the tier-2
  // popularity contribution available even after we know we're in
  // tier 1 (used as the in-tier ranker).
  let popSum = 0;
  let isFollowed = false;
  for (const a of event.lineup) {
    popSum += artistPopularity(a);

    if (
      hasFollows &&
      !isFollowed &&
      a.soundcloud_username &&
      followedSoundcloudUsernames!.has(a.soundcloud_username)
    ) {
      isFollowed = true;
    }
  }

  if (isFollowed) {
    return FOLLOWED_TIER_FLOOR + popSum;
  }

  // Genre-pref match count. Only computed for unfollowed events
  // (followed-tier ignores it). Naked .has() on a Set; assumes the
  // caller normalized casing — see the home page for the .toLowerCase()
  // boundary that builds the Set.
  let genreMatches = 0;
  if (hasGenrePrefs) {
    for (const g of event.genres) {
      if (preferredGenres!.has(g)) genreMatches += 1;
    }
  }

  return (
    POPULARITY_WEIGHT * popSum + GENRE_PREF_WEIGHT * genreMatches
  );
}

/**
 * Phase 5.6 alias preserved for backward-compat with imports inside
 * comments, archived notes, and any straggling consumer. New code
 * should import `feedScore` directly. The shapes are compatible —
 * the new function is a strict superset.
 *
 * @deprecated Use `feedScore` directly. Kept for one phase of
 *             call-site migration; remove in Phase 5.8.
 */
export const enrichmentScore = feedScore;
