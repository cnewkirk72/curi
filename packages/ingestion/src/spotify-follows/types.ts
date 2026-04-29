// Phase 5.7 — public types for the Spotify follow-graph pathfinder
// client.
//
// Exported through `@curi/ingestion/spotify-follows` and consumed by:
//   - apps/web/src/app/actions/sync-spotify-follows.ts (the user-driven
//     /profile connect card flow via the SpotifyOnboardingOverlay)
//   - packages/ingestion/src/refresh-spotify-follows.ts (the weekly
//     Sunday cron at 0 5 * * 0 UTC)
//
// Both consumers want the same row shape, so the type lives here in
// the shared module rather than being redeclared per call site.

/**
 * One artist the Spotify user follows. Field names match the columns
 * of `public.user_spotify_follows` (migration 0023) so the consumer
 * can pass each row straight to `.insert()` after attaching `user_id`.
 *
 * `spotifyId` is the Spotify artist ID — the base62 string in
 * `https://open.spotify.com/artist/{id}` URLs. Matches
 * `artists.spotify_id` from the Phase 4 enrichment pass; this is the
 * canonical join key for the lineup-match path in `feedScore`.
 *
 * `name` is the artist's Spotify display name. Persisted to
 * `user_spotify_follows.display_name` for "we still know who this is"
 * after a user revokes their connection.
 *
 * `imageUrl` is the avatar URL from the pathfinder
 * `visuals.avatarImage.sources` array. Nullable because Spotify omits
 * avatars for some early/spam accounts. Currently unused at write
 * time but persisted so a future "you follow these artists" UI doesn't
 * need to re-fetch.
 *
 * `followers` is the artist's follower count at sync time. Nullable
 * because pathfinder occasionally omits it for very small artists.
 * Stored for potential future popularity-tier signals; not consumed by
 * `feedScore` today (which uses `artists.spotify_followers` from the
 * enrichment pass instead).
 *
 * `followedAt` is the timestamp the user followed the artist on
 * Spotify, when pathfinder surfaces it. Nullable — not always present
 * in the response.
 */
export type SpotifyFollowedArtist = {
  spotifyId: string;
  name: string;
  imageUrl: string | null;
  followers: number | null;
  followedAt: string | null;
};

/**
 * Thrown when bot authentication itself failed — either the
 * `SPOTIFY_BOT_SP_DC` env var is missing, or token mint returned 401
 * (cookie expired). Distinct from `UserNotFoundError` and
 * `ScrapeFailedError` because the remediation is "Christian re-pastes
 * the bot's sp_dc cookie", not "user fixes their input" or "transient
 * network blip — try again."
 *
 * Caller surfaces as `error: 'bot_auth_failed'` so the connect card
 * renders dedicated copy ("We're having trouble with our Spotify
 * lookup service — try again in a few minutes") and the healthcheck
 * cron pages Christian within 24h.
 */
export class SpotifyAuthFailedError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'SpotifyAuthFailedError';
  }
}

/**
 * Thrown when the user's Spotify profile doesn't exist (404 from
 * pathfinder's `queryArtistsFollowed`), is private, or returns an
 * empty/null result for what should be a public profile.
 *
 * Caller: surface as `error: 'private_profile'` so the connect card
 * can render the targeted "Couldn't find any followed artists for
 * @{username} — make sure your Spotify profile is public" copy
 * rather than a generic failure.
 */
export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`Spotify user "${userId}" not found or profile is private`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Thrown for transient or unexpected scrape failures — network
 * errors, 5xx responses from pathfinder, persistent 400 after a
 * persisted-query hash retry, unparseable JSON. Distinct from
 * `UserNotFoundError` (user input is wrong) and
 * `SpotifyAuthFailedError` (bot infra is wrong) so callers can
 * surface different copy.
 *
 * `cause` carries the underlying error for logging; the public
 * message is generic enough to render to users verbatim.
 */
export class ScrapeFailedError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ScrapeFailedError';
  }
}
