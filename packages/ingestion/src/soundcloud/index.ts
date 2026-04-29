// Phase 5.6.2 — public barrel for the SoundCloud follow-graph scraper.
//
// Imported through the `@curi/ingestion/soundcloud` workspace export
// declared in packages/ingestion/package.json. Both apps/web (server
// action) and packages/ingestion (cron) consume from this barrel so
// neither has to know about the file layout.
//
// Deliberately does NOT re-export `playwright-fallback.ts` — that
// module is scaffolded but not wired up, and re-exporting it would
// pull Playwright into the apps/web bundle via Next.js's
// transpilePackages graph the moment we ever add a real import there.
// When the fallback is activated, add the export here.

export { scrapeUserFollows } from './follows-scraper.js';
export { getClientId, invalidateClientId } from './client-id.js';
export {
  ScrapeFailedError,
  UserNotFoundError,
  type ScrapedFollow,
} from './types.js';
