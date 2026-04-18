// RA-NYC: broad NYC electronic-music aggregator sourced from Resident Advisor.
//
// We originally planned to use Shotgun (shotgun.live) for this role, but the
// entire shotgun.live domain sits behind Vercel's bot gate — every request,
// including /api/graphql, returns an Astro "Security Checkpoint" page. RA's
// GraphQL covers the same territory (all NYC electronic events, totalResults
// ~640 in a 30-day window) with no challenge, so we swap the source.
//
// This scraper:
//   1. Queries ra.co/graphql for every listing in area=8 (New York City) over
//      the next 30 days, paginating through all pages.
//   2. Maps each RA venue id → our seeded venue slug via RA_VENUE_TO_SLUG.
//   3. Skips events whose venue isn't seeded, and SKIPS venues that have their
//      own dedicated scraper (Nowadays, Elsewhere, Public Records) to avoid
//      writing the same event twice with different (source, source_id) keys.
//   4. Converts RA's naive NYC datetimes ("2026-04-18T22:00:00.000") into
//      proper UTC-offset ISO strings via nycWallclockToIso.
//
// Why not also cover unseeded venues?
//   Phase 2b stays tight: our `venues` table is hand-curated (12 rows). An
//   unseeded RA venue has no slug, so the event would land with venue_id=null
//   — clutter in the DB. When we expand the venues table, add the RA id →
//   slug row here and events at that venue start flowing in automatically.

import type { Scraper, RawEvent } from '../../types.js';
import { RawEventSchema } from '../../types.js';
import {
  fetchAreaEventListings,
  type RAEventWithVenue,
} from '../../ra-graphql.js';
import { nycWallclockToIso } from '../../time.js';
import { parseArtists } from '../../artist-parsing.js';

const SOURCE = 'ra-nyc';
const NYC_AREA_ID = 8;
const DEFAULT_HORIZON_DAYS = 30;

// RA venue id → our venues.slug. Built from a 30-day listings pull on
// 2026-04-18 (see ra_venue_names.mjs probe). Only the ids listed here
// will have their events ingested; everything else is dropped.
//
// Ordering and presence here is the only lever for expanding coverage.
const RA_VENUE_TO_SLUG: Record<string, string> = {
  // ACTIVE — gap-fill venues with no dedicated scraper yet
  '165976': 'basement',
  '69401': 'knockdown-center',
  '97606': 'good-room',
  '71292': 'bossa-nova-civic-club',
  '21488': 'house-of-yes',
  '170479': 'sultan-room',
  '159838': '3-dollar-bill',
  '19281': 'market-hotel',
  // Intentionally excluded — covered by dedicated per-venue scrapers:
  //   '164270' → 'public-records' (scraped via publicrecords.nyc)
  //   '105873' → 'nowadays'       (dedicated RA-backed scraper)
  //   '139960' → 'elsewhere'      (scraped via elsewhere.club)
  // TBA Brooklyn: no active RA presence — revisit after seeded venues grow.
};

function naiveToNyc(s: string): string {
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
  );
  if (!m) return new Date(s).toISOString();
  const [, Y, M, D, h, mi] = m;
  return nycWallclockToIso(
    Number(Y),
    Number(M),
    Number(D),
    Number(h),
    Number(mi),
  );
}

function toRawEvent(
  e: RAEventWithVenue,
  venueSlug: string,
): RawEvent | null {
  if (!e.id || !e.title || !e.startTime) return null;

  const startsAt = naiveToNyc(e.startTime);
  const endsAt = e.endTime ? naiveToNyc(e.endTime) : null;

  const raArtists = (e.artists ?? [])
    .map((a) => a.name?.trim())
    .filter((n): n is string => !!n);
  // Same fallback as the Nowadays scraper: if RA has no structured lineup,
  // try to pull artist names out of the title. Better than shipping an empty
  // lineup that hides the event from genre-filtered views.
  const artistNames = raArtists.length > 0 ? raArtists : parseArtists(e.title);

  const contentUrl = e.contentUrl?.startsWith('http')
    ? e.contentUrl
    : `https://ra.co${e.contentUrl}`;

  return RawEventSchema.parse({
    sourceId: e.id,
    source: SOURCE,
    title: e.title,
    startsAt,
    endsAt,
    venueSlug,
    priceMin: null,
    priceMax: null,
    ticketUrl: contentUrl,
    imageUrl: e.flyerFront ?? null,
    description: null,
    artistNames,
    raw: {
      raEventId: e.id,
      raContentUrl: contentUrl,
      raVenueId: e.venue.id,
      raVenueName: e.venue.name,
      isTicketed: e.isTicketed,
      artistIds: (e.artists ?? []).map((a) => a.id),
    },
  });
}

async function scrape(): Promise<RawEvent[]> {
  const now = new Date();
  const gte = now.toISOString();
  const lte = new Date(
    now.getTime() + DEFAULT_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { events } = await fetchAreaEventListings({
    areaId: NYC_AREA_ID,
    gte,
    lte,
    pageSize: 100,
    maxPages: 10,
    pageDelayMs: 500,
  });

  const out: RawEvent[] = [];
  const dropped: Record<string, number> = {};

  for (const e of events) {
    const raVenueId = e.venue?.id;
    if (!raVenueId) {
      dropped['no-venue'] = (dropped['no-venue'] ?? 0) + 1;
      continue;
    }
    const slug = RA_VENUE_TO_SLUG[raVenueId];
    if (!slug) {
      const key = e.venue.name || `id=${raVenueId}`;
      dropped[key] = (dropped[key] ?? 0) + 1;
      continue;
    }
    const mapped = toRawEvent(e, slug);
    if (mapped) out.push(mapped);
  }

  // Log drops at debug level — useful when adding new venues but noisy otherwise.
  // We keep the tally in-process only; the runner surfaces eventsFound.
  if (process.env.CURI_VERBOSE) {
    const top = Object.entries(dropped)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    // eslint-disable-next-line no-console
    console.log('[ra-nyc] dropped (top 20):', top);
  }

  return out;
}

export const raNycScraper: Scraper = {
  source: SOURCE,
  scrape,
};
