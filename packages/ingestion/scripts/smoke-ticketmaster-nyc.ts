// Smoke test: fetch Electronic NYC events from Ticketmaster — zero DB writes.
// Run from repo root:
//   pnpm smoke:ticketmaster
//   CURI_VERBOSE=1 pnpm smoke:ticketmaster
import { scrapePreview } from '../src/scrapers/aggregators/ticketmaster-nyc.js';

async function main() {
  const { events, attractionSeeds, venueSeeds } = await scrapePreview();

  // ── Events ──────────────────────────────────────────────────────────────────
  console.log(`\nfetched ${events.length} electronic NYC events from Ticketmaster\n`);

  const byVenue: Record<string, number> = {};
  for (const e of events) {
    const s = e.venueSlug ?? 'NULL';
    byVenue[s] = (byVenue[s] ?? 0) + 1;
  }
  console.log('--- events per venue (top 15):');
  for (const [slug, n] of Object.entries(byVenue).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(' ', String(n).padStart(3), slug);
  }

  console.log('\n--- first 10 events:');
  for (const ev of events.slice(0, 10)) {
    const raw = ev.raw as Record<string, unknown>;
    console.log('---');
    console.log('  id           ', ev.sourceId);
    console.log('  title        ', ev.title);
    console.log('  startsAt     ', ev.startsAt);
    console.log('  endsAt       ', ev.endsAt ?? '–');
    console.log('  venue        ', ev.venueSlug);
    console.log('  artists      ', ev.artistNames);
    console.log('  sourceGenres ', ev.sourceGenres);
    console.log('  price        ', ev.priceMin != null ? `$${ev.priceMin}–$${ev.priceMax}` : 'unknown');
    console.log('  description  ', ev.description ? ev.description.slice(0, 120) + (ev.description.length > 120 ? '…' : '') : '–');
    console.log('  ticketUrl    ', ev.ticketUrl);
    console.log('  imageUrl     ', ev.imageUrl);
    console.log('  status       ', raw['status'] ?? '–');
    console.log('  doorsTime    ', raw['doorsTime'] ?? '–');
    console.log('  ageRestricted', raw['ageRestricted']);
    console.log('  promoter     ', raw['promoter'] ?? '–');
  }

  const cov = {
    total:        events.length,
    withArtists:  events.filter((e) => e.artistNames.length > 0).length,
    withGenres:   events.filter((e) => (e.sourceGenres ?? []).length > 0).length,
    withPrice:    events.filter((e) => e.priceMin != null).length,
    withImage:    events.filter((e) => e.imageUrl).length,
    withDesc:     events.filter((e) => e.description).length,
    withEndsAt:   events.filter((e) => e.endsAt).length,
    withTicketUrl:events.filter((e) => e.ticketUrl).length,
    uniqueVenues: Object.keys(byVenue).length,
  };
  console.log('\n--- event coverage:', cov);

  // ── Venues ───────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`venue seeds from TM: ${venueSeeds.length} unique venues`);
  console.log('═'.repeat(60));

  const withLat    = venueSeeds.filter((v) => v.lat != null);
  const withImg    = venueSeeds.filter((v) => v.imageUrl);
  const withSite   = venueSeeds.filter((v) => v.website);
  const withAddr   = venueSeeds.filter((v) => v.address);

  console.log('\n--- venue field coverage (would be written to DB):');
  console.log('  lat/lng  ', `${withLat.length} / ${venueSeeds.length}`);
  console.log('  website  ', `${withSite.length} / ${venueSeeds.length}`);
  console.log('  image    ', `${withImg.length} / ${venueSeeds.length}`);
  console.log('  address  ', `${withAddr.length} / ${venueSeeds.length}`);

  console.log('\n--- all venue seeds:');
  for (const v of venueSeeds) {
    console.log('---');
    console.log('  name         ', v.name);
    console.log('  slug         ', v.slug);
    console.log('  lat/lng      ', v.lat != null ? `${v.lat}, ${v.lng}` : '–');
    console.log('  website      ', v.website ?? '–');
    console.log('  imageUrl     ', v.imageUrl ?? '–');
    console.log('  address      ', v.address ?? '–');
    console.log('  city         ', v.city ?? '–');
    console.log('  postalCode   ', v.postalCode ?? '–');
    console.log('  timezone     ', v.timezone ?? '–');
    console.log('  upcoming_evts', v.upcomingEvents ?? '–');
  }

  // ── Artists ───────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`artist seeds from TM attractions: ${attractionSeeds.length} unique artists`);
  console.log('═'.repeat(60));

  const withSpotify    = attractionSeeds.filter((a) => a.spotifyUrl);
  const withSoundCloud = attractionSeeds.filter((a) => a.soundcloudUrl);
  const withMB         = attractionSeeds.filter((a) => a.musicbrainzId);
  const withNeither    = attractionSeeds.filter((a) => !a.spotifyUrl && !a.soundcloudUrl && !a.musicbrainzId);

  console.log('\n--- artist link coverage:');
  console.log('  spotify      ', `${withSpotify.length} / ${attractionSeeds.length}`);
  console.log('  soundcloud   ', `${withSoundCloud.length} / ${attractionSeeds.length}`);
  console.log('  musicbrainz  ', `${withMB.length} / ${attractionSeeds.length}`);
  console.log('  no links     ', `${withNeither.length} / ${attractionSeeds.length}`);

  console.log('\n--- all artist seeds (sorted by upcoming events desc):');
  const sorted = [...attractionSeeds].sort((a, b) => (b.upcomingEvents ?? 0) - (a.upcomingEvents ?? 0));
  for (const a of sorted) {
    console.log('---');
    console.log('  name         ', a.name);
    console.log('  slug         ', a.slug);
    console.log('  spotify_url  ', a.spotifyUrl ?? '–');
    console.log('  spotify_id   ', a.spotifyId ?? '–');
    console.log('  soundcloud   ', a.soundcloudUrl ?? '–');
    console.log('  musicbrainz  ', a.musicbrainzId ?? '–');
    console.log('  image        ', a.imageUrl ?? '–');
    console.log('  upcoming_evts', a.upcomingEvents ?? '–');
  }

  if (withNeither.length > 0) {
    console.log(`\n--- ${withNeither.length} artists with no external links:`);
    for (const a of withNeither) console.log(' ', a.name);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
