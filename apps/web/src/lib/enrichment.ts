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
// Anon-safe by design: all three follow-set / preference parameters
// are optional. Empty/undefined arguments fall back to a pure
// popularity sort.

type ScorableEvent = {
  genres: string[];
  lineup: Array<{
    is_headliner: boolean;
    spotify_popularity: number | null;
    soundcloud_followers: number | null;
    bandcamp_followers: number | null;
    soundcloud_username: string | null;
    spotify_id: string | null;
  }>;
};

const HEADLINER_BOOST = 1.25;
const POPULARITY_WEIGHT = 1;
const GENRE_PREF_WEIGHT = 25;
const TIER_FLOOR_BOTH = 3_000_000;
const TIER_FLOOR_SPOTIFY = 2_000_000;
const TIER_FLOOR_SC = 1_000_000;

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
 * @deprecated Use `feedScore` directly. Kept for one phase of
 *             call-site migration; remove in Phase 5.8.
 */
export const enrichmentScore = feedScore;
