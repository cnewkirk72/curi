// Nowadays (Ridgewood, Queens) scraper — backed by Resident Advisor GraphQL.
//
// Nowadays hosts its calendar exclusively on RA (ra.co/clubs/105873); the
// WordPress-based nowadays.nyc site links out to RA for "Programming & RSVP"
// rather than maintaining its own listing. We hit RA's GraphQL directly
// (see ra-graphql.ts for header requirements).
//
// Shape-wise this is the easiest scraper in the repo: artists come back as
// structured rows, so we skip `parseArtists(title)` entirely and use what RA
// already has.
//
// Caveats worth remembering:
//   - RA returns startTime/endTime as naive ISO strings ("2026-04-18T22:00:00.000")
//     with no timezone suffix. For a NYC venue these are NYC wallclock — we
//     convert through `nycWallclockToIso` to stamp the correct UTC offset
//     (EST/EDT-aware).
//   - `flyerFront` is always null on RA's API; use `images[]` (type=FLYERFRONT)
//     rather than guess.
//   - RA sometimes puts a 24h range on open-to-close "Nonstop" parties
//     (e.g. 22:00 → next-day 22:00). That's real — don't "fix" it.

import type { Scraper, RawEvent } from '../../types.js';
import { RawEventSchema } from '../../types.js';
import { fetchVenueEvents, type RAEvent } from '../../ra-graphql.js';
import { nycWallclockToIso } from '../../time.js';
import { parseArtists } from '../../artist-parsing.js';

const RA_VENUE_ID = '105873';
const SOURCE = 'venue:nowadays';
const VENUE_SLUG = 'nowadays';

/** Turn "2026-04-18T22:00:00.000" into a NYC-offset ISO string. */
function naiveToNyc(s: string): string {
  // Split once instead of new Date(...): we do NOT want the host's locale
  // involved. These strings are always the same shape coming out of RA.
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
  );
  if (!m) {
    // Fall back to Date parsing if RA ever returns a different shape; this
    // will assume UTC which is wrong for naive strings but at least valid.
    return new Date(s).toISOString();
  }
  const [, Y, M, D, h, mi] = m;
  return nycWallclockToIso(
    Number(Y),
    Number(M),
    Number(D),
    Number(h),
    Number(mi),
  );
}

function toRawEvent(e: RAEvent): RawEvent | null {
  if (!e.id || !e.title || !e.startTime) return null;

  const startsAt = naiveToNyc(e.startTime);
  const endsAt = e.endTime ? naiveToNyc(e.endTime) : null;

  const raArtists = (e.artists ?? [])
    .map((a) => a.name?.trim())
    .filter((n): n is string => !!n);
  // RA sometimes lists an event without individual billing (e.g. "Body Hack",
  // a promoter-named party). Fall back to parsing the title in that case.
  const artistNames = raArtists.length > 0 ? raArtists : parseArtists(e.title);

  // RA's canonical event URL; no separate ticket URL in the API response.
  // Their detail page embeds the ticket provider link, which we'd need a
  // second scrape to extract — leaving as the RA URL is fine for Phase 2b.
  const contentUrl = e.contentUrl?.startsWith('http')
    ? e.contentUrl
    : `https://ra.co${e.contentUrl}`;

  // RA-curated event genres. Same role as in ra-nyc — a high-precision base
  // layer the normalizer adds into the rollup regardless of MB coverage.
  const sourceGenres = (e.genres ?? [])
    .map((g) => g.name?.trim())
    .filter((n): n is string => !!n);

  return RawEventSchema.parse({
    sourceId: e.id,
    source: SOURCE,
    title: e.title,
    startsAt,
    endsAt,
    venueSlug: VENUE_SLUG,
    priceMin: null,
    priceMax: null,
    ticketUrl: contentUrl,
    // RA's `flyerFront` is always null; real image lives in images[] with
    // type=FLYERFRONT. Fall back to first image, then flyerFront for safety.
    imageUrl:
      (e.images ?? []).find((img) => img.type === 'FLYERFRONT')?.filename ??
      (e.images ?? [])[0]?.filename ??
      e.flyerFront ??
      null,
    description: null,
    artistNames,
    sourceGenres,
    raw: {
      raEventId: e.id,
      raContentUrl: contentUrl,
      isTicketed: e.isTicketed,
      artistIds: (e.artists ?? []).map((a) => a.id),
      raGenres: (e.genres ?? []).map((g) => ({ id: g.id, name: g.name })),
    },
  });
}

async function scrape(): Promise<RawEvent[]> {
  const { events } = await fetchVenueEvents(RA_VENUE_ID, 40);
  const out: RawEvent[] = [];
  for (const e of events) {
    const mapped = toRawEvent(e);
    if (mapped) out.push(mapped);
  }
  return out;
}

export const nowadaysScraper: Scraper = {
  source: SOURCE,
  scrape,
};
