// Smoke test: run the Nowadays scraper (RA GraphQL) against the live API,
// print a summary. No DB writes. Run from packages/ingestion/:
//   npx tsx scripts/smoke-nowadays.ts
import { nowadaysScraper } from '../src/scrapers/venues/nowadays.js';

async function main() {
  const events = await nowadaysScraper.scrape();
  console.log(`scraped ${events.length} events from Nowadays (RA id 105873)`);
  for (const ev of events.slice(0, 8)) {
    console.log('---');
    console.log('id         ', ev.sourceId);
    console.log('startsAt   ', ev.startsAt);
    console.log('endsAt     ', ev.endsAt);
    console.log('title      ', ev.title);
    console.log('artistNames', ev.artistNames);
    console.log('imageUrl   ', ev.imageUrl);
    console.log('ticketUrl  ', ev.ticketUrl);
    console.log('raw        ', JSON.stringify(ev.raw));
  }

  const cov = {
    total: events.length,
    withStart: events.filter((e) => e.startsAt).length,
    withEnd: events.filter((e) => e.endsAt).length,
    withImage: events.filter((e) => e.imageUrl).length,
    withArtists: events.filter((e) => e.artistNames.length > 0).length,
    withTicket: events.filter((e) => e.ticketUrl).length,
  };
  console.log('---coverage---', cov);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
