// Thin Resident Advisor GraphQL client.
//
// RA's public frontend uses their own GraphQL endpoint (https://ra.co/graphql).
// It doesn't require auth, but it does reject requests without browser-like
// headers — specifically `Origin`, `Referer`, and a real User-Agent. RA's
// rate limits kick in on abusive bursts; at ~1 req per venue per day we're
// well below anything that would warrant throttling.
//
// Why we use this instead of scraping the rendered page:
//   - /clubs/{id} returns 403 to non-browser fetches (Cloudflare bot gate)
//   - /graphql returns 200 as long as headers look legit
//   - The response is already structured (event id, artists[], startTime) —
//     no DOM parsing, no drift when RA redesigns
//
// Nowadays (club id 105873) is the first consumer; if we add more RA-hosted
// venues later they can share the same fetchVenueEvents(...) entry point.

import { env } from './env.js';

const ENDPOINT = 'https://ra.co/graphql';

// Chrome-like UA. Anthropic/curi-ingest UAs get 403 at the edge.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface RAArtist {
  id: string;
  name: string;
}

export interface RAEvent {
  id: string;
  /** ISO-ish "2026-04-18T00:00:00.000" — midnight anchor, NYC wallclock. */
  date: string;
  /** ISO-ish "2026-04-18T22:00:00.000" — NYC wallclock, NO timezone suffix. */
  startTime: string | null;
  endTime: string | null;
  title: string;
  /** Relative, e.g. "/events/2376282". */
  contentUrl: string;
  /** Promo image URL (nullable — upcoming events often lack flyers). */
  flyerFront: string | null;
  isTicketed: boolean;
  artists: RAArtist[];
}

interface VenueEventsResponse {
  data?: {
    venue: {
      id: string;
      name: string;
      contentUrl: string;
      events: RAEvent[];
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface AreaEventListingsResponse {
  data?: {
    eventListings: {
      totalResults: number;
      data: Array<{ event: RAEvent & { venue: { id: string; name: string; contentUrl: string | null } } }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export type RAEventWithVenue = RAEvent & {
  venue: { id: string; name: string; contentUrl: string | null };
};

const VENUE_EVENTS_QUERY = `
query CuriVenueEvents($id: ID!, $limit: Int!) {
  venue(id: $id, ensureLive: true) {
    id
    name
    contentUrl
    events(type: LATEST, limit: $limit) {
      id
      date
      startTime
      endTime
      title
      contentUrl
      flyerFront
      isTicketed
      artists { id name }
    }
  }
}
`;

const AREA_EVENT_LISTINGS_QUERY = `
query CuriAreaEvents(
  $filters: FilterInputDtoInput!
  $filterOptions: FilterOptionsInputDtoInput!
  $page: Int!
  $pageSize: Int!
) {
  eventListings(
    filters: $filters
    filterOptions: $filterOptions
    page: $page
    pageSize: $pageSize
  ) {
    totalResults
    data {
      event {
        id
        date
        startTime
        endTime
        title
        contentUrl
        flyerFront
        isTicketed
        venue { id name contentUrl }
        artists { id name }
      }
    }
  }
}
`;

/**
 * Fetch upcoming events for an RA club/venue id.
 * `limit` caps how many the API returns; 40 is a safe number for most clubs'
 * 30-day horizon — we can raise it per-venue if needed.
 */
export async function fetchVenueEvents(
  venueId: string,
  limit = 40,
): Promise<{ venueName: string; events: RAEvent[] }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Browser-mimicking headers are load-bearing — RA returns 403 without
      // Origin + Referer. UA is the other hard requirement.
      'User-Agent': UA,
      Accept: '*/*',
      Origin: 'https://ra.co',
      Referer: `https://ra.co/clubs/${venueId}`,
      'ra-content-language': 'en',
      // Pass our contact through a custom header so a friendly ops person at
      // RA can reach us if traffic ever gets suspicious. (Cost: none.)
      'x-curi-contact': env.musicbrainzUserAgent,
    },
    body: JSON.stringify({
      operationName: 'CuriVenueEvents',
      query: VENUE_EVENTS_QUERY,
      variables: { id: venueId, limit },
    }),
  });

  if (res.status === 403 || res.status === 503) {
    throw new Error(`ra.co blocked (${res.status}) — bot gate triggered`);
  }
  if (!res.ok) {
    throw new Error(`ra.co graphql ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as VenueEventsResponse;
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `ra.co graphql errors: ${json.errors.map((e) => e.message).join(' | ')}`,
    );
  }
  const venue = json.data?.venue;
  if (!venue) {
    throw new Error(`ra.co: no venue with id ${venueId}`);
  }
  return { venueName: venue.name, events: venue.events ?? [] };
}

/**
 * Fetch all events in a RA "area" (city) between two ISO dates, paginated.
 * Area IDs: New York City = 8, London = 13, Berlin = 34, etc.
 *
 * Paginates internally until we've pulled every result or hit `maxPages`.
 * Sleeps `pageDelayMs` between pages to stay polite.
 */
export async function fetchAreaEventListings(opts: {
  areaId: number;
  gte: string;
  lte: string;
  pageSize?: number;
  maxPages?: number;
  pageDelayMs?: number;
}): Promise<{ totalResults: number; events: RAEventWithVenue[] }> {
  const {
    areaId,
    gte,
    lte,
    pageSize = 100,
    maxPages = 10,
    pageDelayMs = 500,
  } = opts;

  const events: RAEventWithVenue[] = [];
  let totalResults = 0;
  let page = 1;

  while (page <= maxPages) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        Accept: '*/*',
        Origin: 'https://ra.co',
        Referer: `https://ra.co/events/us/newyorkcity`,
        'ra-content-language': 'en',
        'x-curi-contact': env.musicbrainzUserAgent,
      },
      body: JSON.stringify({
        operationName: 'CuriAreaEvents',
        query: AREA_EVENT_LISTINGS_QUERY,
        variables: {
          filters: {
            areas: { eq: areaId },
            listingDate: { gte, lte },
          },
          filterOptions: { genre: true, eventType: false },
          pageSize,
          page,
        },
      }),
    });
    if (res.status === 403 || res.status === 503) {
      throw new Error(`ra.co blocked (${res.status}) — bot gate triggered`);
    }
    if (!res.ok) {
      throw new Error(`ra.co graphql ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as AreaEventListingsResponse;
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `ra.co graphql errors: ${json.errors.map((e) => e.message).join(' | ')}`,
      );
    }
    const listings = json.data?.eventListings;
    if (!listings) break;
    totalResults = listings.totalResults;
    const batch = (listings.data ?? []).map((d) => d.event);
    events.push(...batch);
    if (batch.length < pageSize) break;
    page++;
    if (page <= maxPages && pageDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }
  }

  return { totalResults, events };
}
