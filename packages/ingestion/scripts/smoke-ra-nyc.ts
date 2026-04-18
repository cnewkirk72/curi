// Smoke test: run the RA-NYC aggregator against the live RA GraphQL endpoint.
// No DB writes. Run from packages/ingestion/:
//   npx tsx scripts/smoke-ra-nyc.ts
//   CURI_VERBOSE=1 npx tsx scripts/smoke-ra-nyc.ts   # also prints drop tally
import { raNycScraper } from '../src/scrapers/aggregators/ra-nyc.js';

async function main() {
  const events = await raNycScraper.scrape();
  console.log(`scraped ${events.length} events from RA-NYC (seeded venues only)`);

  // Group by venue slug to show per-venue coverage.
  const byVenue: Record<string, number> = {};
  for (const e of events) {
    const s = e.venueSlug ?? 'NULL';
    byVenue[s] = (byVenue[s] ?? 0) + 1;
  }
  console.log('---events per seeded venue:');
  for (const [slug, n] of Object.entries(byVenue).sort((a, b) => b[1] - a[1])) {
    console.log(' ', String(n).padStart(3), slug);
  }

  console.log('---first 5 events:');
  for (const ev of events.slice(0, 5)) {
    console.log('---');
    console.log('id         ', ev.sourceId);
    console.log('startsAt   ', ev.startsAt);
    console.log('endsAt     ', ev.endsAt);
    console.log('title      ', ev.title);
    console.log('venueSlug  ', ev.venueSlug);
    console.log('artistNames', ev.artistNames);
    console.log('ticketUrl  ', ev.ticketUrl);
  }

  const cov = {
    total: events.length,
    withStart: events.filter((e) => e.startsAt).length,
    withEnd: events.filter((e) => e.endsAt).length,
    withImage: events.filter((e) => e.imageUrl).length,
    withArtists: events.filter((e) => e.artistNames.length > 0).length,
    withTicket: events.filter((e) => e.ticketUrl).length,
    uniqueVenues: Object.keys(byVenue).length,
  };
  console.log('---coverage---', cov);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
