// Phase 5.7 — cross-platform follow indicator. Reused by EventCard
// (feed avatars, 6×6 cluster) and LineupList (detail page, 14×14
// headliner + 10×10 supporting avatars).
//
// Behavior:
//   - SC follow only      → single sc-orange dot, bottom-right
//   - Spotify follow only → single spotify-green dot, bottom-right
//   - Both                → spotify-green dot offset up-right (+3px,
//                            -3px), sc-orange dot at the bottom-right
//                            on top. Two dots layered so a glance
//                            sees both signals.
//   - Neither             → null (no dot rendered)
//
// `aria-label` on the visible dot describes which platform(s); the
// hidden second dot in the both-case uses aria-hidden so SR users
// don't hear the indicator twice.
//
// Caller is responsible for the wrapping `relative` element so the
// dots can absolute-position outside the avatar's `overflow-hidden`
// rounded clip. See the JSDoc on each prop for sizing notes.

import { cn } from '@/lib/utils';

export type FollowDotSize = 'sm' | 'md';

type Props = {
  /** Display name used in the aria-label so screen readers can
   *  identify which artist the indicator belongs to. */
  artistName: string;
  /** Lowercased SC profile slug for this artist. May be null when
   *  the artist hasn't been SC-enriched. */
  soundcloudUsername: string | null;
  /** Spotify artist ID (base62) for this artist. May be null when
   *  the artist hasn't been Spotify-enriched. */
  spotifyId: string | null;
  /** Set of SC slugs the signed-in user follows. Optional —
   *  empty/undefined Set short-circuits to "no SC follow". */
  followedSoundcloudUsernames?: Set<string>;
  /** Set of Spotify artist IDs the signed-in user follows. Optional —
   *  empty/undefined Set short-circuits to "no Spotify follow". */
  followedSpotifyArtistIds?: Set<string>;
  /** Dot size variant.
   *  - `'sm'` (default) is `h-2 w-2` — used by the 6×6 EventCard
   *    avatar cluster and the 10×10 LineupList supporting avatars.
   *  - `'md'` is `h-2.5 w-2.5` — proportional bump for the 14×14
   *    LineupList headliner avatar so the dot stays visible without
   *    becoming a smudge. */
  size?: FollowDotSize;
};

export function FollowDotStack({
  artistName,
  soundcloudUsername,
  spotifyId,
  followedSoundcloudUsernames,
  followedSpotifyArtistIds,
  size = 'sm',
}: Props) {
  const isSc =
    !!followedSoundcloudUsernames &&
    !!soundcloudUsername &&
    followedSoundcloudUsernames.has(soundcloudUsername);
  const isSpotify =
    !!followedSpotifyArtistIds &&
    !!spotifyId &&
    followedSpotifyArtistIds.has(spotifyId);

  if (!isSc && !isSpotify) return null;

  const dotSizeClass = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';

  // Both platforms — stack with Spotify-green BEHIND the SC-orange so
  // the SC indicator (Curi's primary follow signal since 5.6) reads
  // first. Offset the green dot ~3px upper-right so both are visible.
  // The visible "primary" dot owns the aria-label; the offset dot is
  // aria-hidden so SR doesn't double-announce.
  if (isSc && isSpotify) {
    return (
      <>
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute -bottom-0.5 -right-0.5',
            dotSizeClass,
            'rounded-full bg-spotify-green',
            'ring-2 ring-bg-base shadow-glow-spotify-sm',
            'translate-x-[3px] -translate-y-[3px]',
          )}
        />
        <span
          role="img"
          aria-label={`You follow ${artistName} on SoundCloud and Spotify`}
          className={cn(
            'pointer-events-none absolute -bottom-0.5 -right-0.5',
            dotSizeClass,
            'rounded-full bg-sc-orange',
            'ring-2 ring-bg-base shadow-glow-sc-sm',
          )}
        />
      </>
    );
  }

  if (isSpotify) {
    return (
      <span
        role="img"
        aria-label={`You follow ${artistName} on Spotify`}
        className={cn(
          'pointer-events-none absolute -bottom-0.5 -right-0.5',
          dotSizeClass,
          'rounded-full bg-spotify-green',
          'ring-2 ring-bg-base shadow-glow-spotify-sm',
        )}
      />
    );
  }

  // SC only.
  return (
    <span
      role="img"
      aria-label={`You follow ${artistName} on SoundCloud`}
      className={cn(
        'pointer-events-none absolute -bottom-0.5 -right-0.5',
        dotSizeClass,
        'rounded-full bg-sc-orange',
        'ring-2 ring-bg-base shadow-glow-sc-sm',
      )}
    />
  );
}
