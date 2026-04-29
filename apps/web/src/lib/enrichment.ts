// Phase 5.7 — feed score function. Drives within-day sort in the home
// feed and /saved. Extends the Phase 5.6.6 two-tier formula
// (followed > unfollowed) into a three-tier system that prioritizes
// cross-platform matches:
//
//   Tier 0  Both Spotify AND SoundCloud match  → top of feed
//   Tier 1  Spotify match only                  → above SC-only
//   Tier 2  SoundCloud match only               → above no-match
//   Tier 3  No follow match                     → popularity + genre-pref
//
// Per Christian's spec: Spotify ranks above SoundCloud (Spotify
// follows are a more deliberate curation signal for most users), and
// any cross-platform match outranks every single-platform match
// regardless of popularity.
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
// Anon-safe by design: all three follow-set / preference parameters
// are optional. Empty/undefined arguments fall back to a pure
// popularity sort, which is the correct behavior for the un-signed-in
// browse path (Curi has a no-auth UX path; the feed must rank
// usefully without any user signal).

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
     *  signed-in user's SC follow set. NULL when the artist has no
     *  SC URL or the URL didn't match the strict profile-URL regex
     *  during the migration 0022 backfill. */
    soundcloud_username: string | null;
    /** Phase 5.7 — Spotify artist ID (base62). Join key against the
     *  signed-in user's Spotify follow set. NULL when the artist
     *  hasn't been Spotify-enriched yet. */
    spotify_id: string | null;
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
 * Phase 5.6.6 — weight on the summed-popularity term. Christian's
 * spec for the unfollowed tier: "summed artist popularity should be
 * weighted more" than the genre-pref match term.
 */
const POPULARITY_WEIGHT = 1;

/**
 * Phase 5.6.6 — additive boost per matching preferred genre on the
 * event. Sized so it meaningfully reorders unfollowed events with
 * similar popularity, without overwhelming the popularity term.
 *
 * Calibration sketch unchanged from 5.6.6:
 *   - Typical 3-artist mid-tier lineup: per-artist popularity ~25–35,
 *     summed (with one headliner) ≈ 90.
 *   - High-tier 1M-follower headliner: summed ≈ 150–180.
 *   - Genre matches typically 0–3.
 *
 * At W_PREF = 25, a 2-genre match (+50) is worth roughly the gap
 * between mid-tier and high-tier — significant but not overwhelming.
 */
const GENRE_PREF_WEIGHT = 25;

/**
 * Phase 5.7 — three tier floors stacked with 1M of headroom each.
 *
 *   BOTH       3_000_000 → cross-platform match (Spotify ∧ SC)
 *   SPOTIFY    2_000_000 → Spotify-only match
 *   SC         1_000_000 → SoundCloud-only match
 *   (none)     0         → unfollowed events compete on popSum + pref
 *
 * The 1M headroom dwarfs the realistic popSum range (~600 max for a
 * 10-artist all-headliner lineup) so tier separation is unambiguous
 * regardless of lineup size. Within each followed tier, events sort
 * by summed popularity. Genre-pref doesn't apply inside followed tiers
 * because the explicit follow signal already dominates.
 *
 * Future-proof: 1M headroom leaves room for new signals (plays-this-
 * week, save-history, attendance) to layer in without colliding with
 * the tier floors.
 */
const TIER_FLOOR_BOTH = 3_000_000;
const TIER_FLOOR_SPOTIFY = 2_000_000;
const TIER_FLOOR_SC = 1_000_000;

/**
 * Compute one artist's popularity contribution. Same recipe as 5.6.6.
 * Pulled out so each tier can use the same value as its in-tier
 * ranker.
 *
 * Per-artist signal:
 *   - spotify_popularity (raw 0–100; dead in DB post Spotify Nov-2024
 *     API change — kept for forward-compat).
 *   - soundcloud_followers, log2-scaled × 2.
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
 * Tiers (high-to-low):
 *   1. Both Spotify AND SC match anywhere in the lineup
 *      → TIER_FLOOR_BOTH + summed-popularity
 *   2. Spotify match (no SC match)
 *      → TIER_FLOOR_SPOTIFY + summed-popularity
 *   3. SC match (no Spotify match)
 *      → TIER_FLOOR_SC + summed-popularity
 *   4. No follow match
 *      → POPULARITY_WEIGHT × summed-popularity +
 *        GENRE_PREF_WEIGHT × genre-pref match count
 *
 * Note on Tier 0: the cross-platform match is event-level, not
 * artist-level. Either of these qualifies the event as Tier 0:
 *   - One artist on the lineup followed on both platforms
 *   - Two different artists, one followed on each platform
 * Both signal stronger overall affinity for the lineup than a
 * single-platform match.
 *
 * Anon path / un-onboarded path:
 *   - Empty Spotify follow set + empty SC follow set + empty preferred
 *     genres → pure popularity sort, the un-signed-in browse experience.
 *
 * This function mutates nothing and reads only the structural fields
 * above, so it's safe to call during render. Keep it allocation-free
 * inside the inner loop — the client comparator runs it O(n log n) per
 * render.
 */
export function feedScore(
  event: ScorableEvent,
  followedSoundcloudUsernames?: Set<string>,
  followedSpotifyArtistIds?: Set<string>,
  preferredGenres?: ReadonlySet<string>,
): number {
  const hasScFollows =
    !!followedSoundcloudUsernames && followedSoundcloudUsernames.size > 0;
  const hasSpotifyFollows =
    !!followedSpotifyArtistIds && followedSpotifyArtistIds.size > 0;
  const hasGenrePrefs =
    !!preferredGenres && preferredGenres.size > 0;

  // Single pass over the lineup: accumulate summed popularity AND
  // detect tier membership in one loop.
  let popSum = 0;
  let scMatched = false;
  let spotifyMatched = false;
  for (const a of event.lineup) {
    popSum += artistPopularity(a);

    if (
      hasScFollows &&
      !scMatched &&
      a.soundcloud_username &&
      followedSoundcloudUsernames!.has(a.soundcloud_username)
    ) {
      scMatched = true;
    }
    if (
      hasSpotifyFollows &&
      !spotifyMatched &&
      a.spotify_id &&
      followedSpotifyArtistIds!.has(a.spotify_id)
    ) {
      spotifyMatched = true;
    }
  }

  if (scMatched && spotifyMatched) return TIER_FLOOR_BOTH + popSum;
  if (spotifyMatched) return TIER_FLOOR_SPOTIFY + popSum;
  if (scMatched) return TIER_FLOOR_SC + popSum;

  // Tier 3 — no follow match. Genre-pref kicks in here per Phase 5.6.6.
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
