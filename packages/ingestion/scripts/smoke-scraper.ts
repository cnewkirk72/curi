// Smoke test: run the scraper against the live Public Records site, print a
// summary. No DB writes. Run from packages/ingestion/:
//   npx tsx scripts/smoke-scraper.ts
import { publicRecordsScraper } from '../src/scrapers/venues/public-records.js';

async function main() {
  const events = await publicRecordsScraper.scrape();
  console.log(`scraped ${events.length} events`);
  for (const ev of events.slice(0, 8)) {
    console.log('---');
    console.log('id         ', ev.sourceId);
    console.log('startsAt   ', ev.startsAt);
    console.log('title      ', ev.title);
    console.log('artistNames', ev.artistNames);
    console.log('ticketUrl  ', ev.ticketUrl);
    console.log('raw        ', JSON.stringify(ev.raw));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
