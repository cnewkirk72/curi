// Smoke test: run the Elsewhere scraper against the live site, print a
// summary. No DB writes. Run from packages/ingestion/:
//   npx tsx scripts/smoke-elsewhere.ts
import { elsewhereScraper } from '../src/scrapers/venues/elsewhere.js';

async function main() {
  const events = await elsewhereScraper.scrape();
  console.log(`scraped ${events.length} events`);
  for (const ev of events.slice(0, 8)) {
    console.log('---');
    console.log('id         ', ev.sourceId);
    console.log('startsAt   ', ev.startsAt);
    console.log('endsAt     ', ev.endsAt);
    console.log('title      ', ev.title);
    console.log('artistNames', ev.artistNames);
    console.log('priceMin   ', ev.priceMin);
    console.log('imageUrl   ', ev.imageUrl);
    console.log('ticketUrl  ', ev.ticketUrl);
    console.log('raw        ', JSON.stringify(ev.raw));
  }

  const cov = {
    total: events.length,
    withStart: events.filter((e) => e.startsAt).length,
    withEnd: events.filter((e) => e.endsAt).length,
    withPrice: events.filter((e) => e.priceMin != null).length,
    withImage: events.filter((e) => e.imageUrl).length,
    withPerformers: events.filter((e) => e.artistNames.length > 0).length,
    withTicket: events.filter((e) => e.ticketUrl).length,
  };
  console.log('---coverage---', cov);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
