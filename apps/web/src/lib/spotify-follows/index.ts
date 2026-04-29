// Phase 5.7 — public barrel for the Spotify follow-graph pathfinder.
//
// NOTE: Dual-copy of packages/ingestion/src/spotify-follows/index.ts.
// See ./types.ts for the dual-copy rationale.

export { fetchUserFollowedArtists } from './pathfinder';
export {
  getBotAccessToken,
  invalidateBotToken,
} from './bot-token';
export {
  getPersistedQueryHash,
  invalidateHash,
} from './hash-resolver';
export {
  ScrapeFailedError,
  SpotifyAuthFailedError,
  UserNotFoundError,
  type SpotifyFollowedArtist,
} from './types';
