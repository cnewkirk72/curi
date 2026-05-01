// Phase 5.7.1 + 5.8 — Connectors section wrapper.
//
// Renders the parent "CONNECTORS" eyebrow + the platform connector
// cards stacked. Spotify above SoundCloud per Christian's spec —
// Spotify gets prioritized in the feed sort (3-tier system in
// feedScore: BOTH > Spotify > SC > none) so its connector card sits
// at the top of the section visually.
//
// Phase 5.8 (post-launch): the SoundCloud connector is OAuth-only on
// the UI. The legacy paste-username card has been hidden but the
// underlying components, server action, and ingestion-side scraper
// are intentionally left in place so the weekly Sunday cron can keep
// refreshing existing legacy-connected users' user_soundcloud_follows
// rows until Phase 5.9 wires `/me/followings` into the same table via
// OAuth-fetched data. Once that ships, the legacy code path can be
// fully retired in one sweep.

import { SoundcloudOAuthCard } from '@/components/profile/soundcloud-oauth-card';
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
  /** From getSoundcloudConnection().username — populated by either the
   *  OAuth callback (from /me) or, for already-connected legacy users,
   *  the previously-saved paste-flow handle. */
  soundcloudUsername: string | null;
  /** From getSoundcloudConnection().lastSyncedAt — set by either the
   *  Phase 5.9 OAuth sync or the legacy paste-flow sync. Drives the
   *  connected card's "Last synced X ago" label. */
  soundcloudLastSyncedAt: string | null;
  /** From getSoundcloudConnection().oauthConnected — true iff a SC
   *  OAuth access token is currently persisted. Drives the OAuth
   *  card's connected/disconnected state. */
  soundcloudOauthConnected: boolean;
  /** From getSoundcloudConnection().followsCount — count of rows in
   *  user_soundcloud_follows for this user. Phase 5.9 surfaces this
   *  in the connected card ("247 artists"). */
  soundcloudFollowsCount: number;
};

export function ConnectorsSection({
  spotifyUserId,
  spotifyLastSyncedAt,
  spotifyHasFollows,
  soundcloudUsername,
  soundcloudLastSyncedAt,
  soundcloudOauthConnected,
  soundcloudFollowsCount,
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

        <SoundcloudOAuthCard
          connected={soundcloudOauthConnected}
          username={soundcloudUsername}
          lastSyncedAt={soundcloudLastSyncedAt}
          followsCount={soundcloudFollowsCount}
        />
      </div>
    </section>
  );
}
