// Phase 5.6.2 — public types for the SoundCloud follow-graph scraper.
//
// These are exported through `@curi/ingestion/soundcloud` and consumed by:
//   - apps/web/src/app/actions/sync-soundcloud-follows.ts (the user-driven
//     /profile connect card flow)
//   - packages/ingestion/src/refresh-soundcloud-follows.ts (the weekly
//     Sunday cron that re-syncs every connected user)
//
// Both consumers want the same row shape, so the type lives here in the
// shared module rather than being redeclared per call site.

/**
 * One artist the SoundCloud user follows. Field names match the columns
 * of `public.user_soundcloud_follows` (migration 0022) so the consumer
 * can pass each row straight to `.insert()` after attaching `user_id`.
 *
 * `username` is the SC profile slug (the `<slug>` in
 * `https://soundcloud.com/<slug>`). Always lowercased at write time so
 * downstream joins against `artists.soundcloud_username` are
 * case-insensitive without a per-call `.toLowerCase()`.
 *
 * `displayName` is what SC labels as `username` in their JSON — the
 * human-readable name shown on the profile (e.g. "Flux Pavilion"). We
 * surface it on the EventCard "you follow [Artist]" badge if we ever
 * want to show the *follower's* preferred name rather than the slug.
 *
 * `followedAt` is SC's `created_at` on the following relationship row,
 * not the artist's account creation. Useful for "recently followed"
 * sub-sorts later if Curi ever wants to surface them. Nullable because
 * SC's API has occasionally returned rows without it.
 */
export type ScrapedFollow = {
  username: string;
  displayName: string;
  followedAt: string | null;
};

/**
 * Thrown when the user's SoundCloud profile doesn't exist (404 from the
 * api-v2 `/resolve` endpoint), is private, or resolves to a non-user
 * resource (e.g. someone typed a track URL by mistake).
 *
 * Caller: surface as `error: 'user_not_found'` so the connect card can
 * render the targeted "Couldn't find @{username} on SoundCloud" copy
 * rather than a generic failure.
 */
export class UserNotFoundError extends Error {
  constructor(public readonly username: string) {
    super(`SoundCloud user "${username}" not found`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Thrown for transient or unexpected scrape failures — network errors,
 * 5xx responses from api-v2, persistent 401/403 after a client_id retry,
 * unparseable JSON. Distinct from `UserNotFoundError` so callers can
 * tell "user input is wrong" from "infrastructure broke."
 *
 * `cause` carries the underlying error for logging; the public message
 * is generic enough to render to users verbatim.
 */
export class ScrapeFailedError extends Error {
  // `override` modifier required by newer TS lib — `Error` has a
  // built-in `cause` property in ES2022+. We're widening the type
  // from `unknown` to a more meaningful structured cause, so the
  // override declaration matches.
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ScrapeFailedError';
  }
}
