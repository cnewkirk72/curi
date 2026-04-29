// Phase 5.7 — public types for the Spotify follow-graph pathfinder.
//
// NOTE: This is a copy of packages/ingestion/src/spotify-follows/types.ts.
// Both copies must stay in sync. Same dual-copy convention as
// apps/web/src/lib/soundcloud/types.ts ↔
// packages/ingestion/src/soundcloud/types.ts (Phase 5.6.2). If a
// third consumer ever lands, extract into a `@curi/spotify-pathfinder`
// workspace package.
//
// Why the duplication: the canonical pathfinder client lives in
// packages/ingestion for the Railway cron's use, but apps/web's
// server action (driving the /profile connect card) needs the same
// code path. Cross-workspace imports require a pnpm-lock.yaml
// regeneration that introduces deploy risk on Vercel's
// --frozen-lockfile install — the duplication keeps each workspace
// self-contained at the cost of two-file maintenance.

export type SpotifyFollowedArtist = {
  spotifyId: string;
  name: string;
  imageUrl: string | null;
  followers: number | null;
  followedAt: string | null;
};

export class SpotifyAuthFailedError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'SpotifyAuthFailedError';
  }
}

export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`Spotify user "${userId}" not found or profile is private`);
    this.name = 'UserNotFoundError';
  }
}

export class ScrapeFailedError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ScrapeFailedError';
  }
}
