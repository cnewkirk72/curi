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

import { cn } from '@/lib/utils';

export type FollowDotSize = 'sm' | 'md';

type Props = {
  artistName: string;
  soundcloudUsername: string | null;
  spotifyId: string | null;
  followedSoundcloudUsernames?: Set<string>;
  followedSpotifyArtistIds?: Set<string>;
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
