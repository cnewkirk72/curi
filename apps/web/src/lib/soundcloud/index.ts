// Phase 5.6.2 — public barrel for the SoundCloud follow-graph scraper.
//
// NOTE: This is a copy of packages/ingestion/src/soundcloud/index.ts.
// Both copies must stay in sync — see ./types.ts for the dual-copy
// rationale.

export { scrapeUserFollows } from './follows-scraper';
export { getClientId, invalidateClientId } from './client-id';
export {
  ScrapeFailedError,
  UserNotFoundError,
  type ScrapedFollow,
} from './types';
