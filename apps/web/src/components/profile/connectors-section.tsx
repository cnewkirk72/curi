// Phase 5.7 — Connectors section wrapper.
//
// Renders the parent "CONNECTORS" eyebrow + the two platform connector
// cards stacked. Spotify above SoundCloud per Christian's spec —
// Spotify gets prioritized in the feed sort (3-tier system in
// feedScore: BOTH > Spotify > SC > none) so its connector card sits
// at the top of the section visually.
//
// Each connector card self-renders its own subheader ("Spotify
// follows" / "SoundCloud follows") + helper text + `.curi-glass`
// chrome. This wrapper just owns the parent eyebrow and the vertical
// spacing between the two cards.
//
// Lives between ProfileForm and PreferencesForm on /profile (same
// position the standalone SoundcloudConnectCard occupied before
// 5.7). The page-level wiring lives in apps/web/src/app/profile/page.tsx.

import { SoundcloudConnectCard } from '@/components/profile/soundcloud-connect-card';
import { SpotifyConnectCard } from '@/components/profile/spotify-connect-card';

type Props = {
  /** From getSpotifyConnection() — null when never connected. */
  spotifyUserId: string | null;
  /** From getSpotifyConnection() — ISO timestamp of last successful
   *  Spotify sync, or null. */
  spotifyLastSyncedAt: string | null;
  /** From getSoundcloudConnection() — null when never connected. */
  soundcloudUsername: string | null;
  /** From getSoundcloudConnection() — ISO timestamp of last
   *  successful SC sync, or null. */
  soundcloudLastSyncedAt: string | null;
};

export function ConnectorsSection({
  spotifyUserId,
  spotifyLastSyncedAt,
  soundcloudUsername,
  soundcloudLastSyncedAt,
}: Props) {
  return (
    <section className="mt-6">
      {/* Parent eyebrow — matches the existing /profile section
          eyebrow rhythm (display 2xs uppercase widest tracking on
          fg-muted, with optional helper on the right). */}
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Connectors
        </h2>
        <span className="text-2xs text-fg-dim">
          Boost events with artists you follow
        </span>
      </div>

      {/* Spotify above SC. space-y-6 between cards — matches the
          padding rhythm the rest of /profile uses between sections.
          Each card self-renders its own subheader + curi-glass card
          chrome, so the wrapper is intentionally thin. */}
      <div className="space-y-6">
        <SpotifyConnectCard
          initialUserId={spotifyUserId}
          initialLastSyncedAt={spotifyLastSyncedAt}
        />
        <SoundcloudConnectCard
          initialUsername={soundcloudUsername}
          initialLastSyncedAt={soundcloudLastSyncedAt}
        />
      </div>
    </section>
  );
}
