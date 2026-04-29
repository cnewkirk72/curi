// Phase 5.7 — public barrel for the Spotify follow-graph pathfinder
// client.
//
// Imported through the `@curi/ingestion/spotify-follows` workspace
// path declared in packages/ingestion's exports. Both apps/web (server
// action) and packages/ingestion (cron) consume from this barrel so
// neither has to know about the file layout.
//
// Deliberately does NOT re-export `playwright-fallback.ts` — that
// module is scaffolded but not wired up, and re-exporting it would
// pull Playwright into the apps/web bundle via Next.js's
// transpilePackages graph the moment we ever add a real import there.
// When the fallback is activated, add the export here.

export { fetchUserFollowedArtists } from './pathfinder.js';
export {
  getBotAccessToken,
  invalidateBotToken,
} from './bot-token.js';
export {
  getPersistedQueryHash,
  invalidateHash,
} from './hash-resolver.js';
export {
  ScrapeFailedError,
  SpotifyAuthFailedError,
  UserNotFoundError,
  type SpotifyFollowedArtist,
} from './types.js';
