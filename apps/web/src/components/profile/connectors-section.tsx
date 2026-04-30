// Phase 5.7.1 — Connectors section wrapper.
//
// Renders the parent "CONNECTORS" eyebrow + the two platform connector
// cards stacked. Spotify above SoundCloud per Christian's spec —
// Spotify gets prioritized in the feed sort (3-tier system in
// feedScore: BOTH > Spotify > SC > none) so its connector card sits
// at the top of the section visually.
//
// Updated for Phase 5.7.1: SpotifyConnectCard now takes hasFollows
// as a derived "connected?" predicate alongside initialUserId
// (which is null in the WKWebView flow).

import { SoundcloudConnectCard } from '@/components/profile/soundcloud-connect-card';
import { SpotifyConnectCard } from '@/components/profile/spotify-connect-card';

type Props = {
  /** From getSpotifyConnection() — null when never connected via the
   *  legacy URL-paste flow. WKWebView flow leaves this null even when
   *  connected. */
  spotifyUserId: string | null;
  /** From getSpotifyConnection() — ISO timestamp of last successful
   *  Spotify sync, or null. */
  spotifyLastSyncedAt: string | null;
  /** Whether the user has any user_spotify_follows rows. The card
   *  uses this as its canonical "connected?" check. */
  spotifyHasFollows: boolean;
  /** From getSoundcloudConnection() — null when never connected. */
  soundcloudUsername: string | null;
  /** From getSoundcloudConnection() — ISO timestamp of last
   *  successful SC sync, or null. */
  soundcloudLastSyncedAt: string | null;
};

export function ConnectorsSection({
  spotifyUserId,
  spotifyLastSyncedAt,
  spotifyHasFollows,
  soundcloudUsername,
  soundcloudLastSyncedAt,
}: Props) {
  return (
    <section className="mt-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Connectors
        </h2>
        <span className="text-2xs text-fg-dim">
          Boost events with artists you follow
        </span>
      </div>

      <div className="space-y-6">
        <SpotifyConnectCard
          initialUserId={spotifyUserId}
          initialLastSyncedAt={spotifyLastSyncedAt}
          hasFollows={spotifyHasFollows}
        />
        <SoundcloudConnectCard
          initialUsername={soundcloudUsername}
          initialLastSyncedAt={soundcloudLastSyncedAt}
        />
      </div>
    </section>
  );
}
