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
//   2. Auto-seeds any venue it hasn't seen before as a minimal
//      public.venues row (name + slug, everything else null). Hand-edit the
//      row later if we want to enrich neighborhood/website/coords.
//   3. SKIPS venues that have their own dedicated scraper (Nowadays,
//      Elsewhere, Public Records) to avoid writing the same event twice
//      with different (source, source_id) keys.
//   4. Converts RA's naive NYC datetimes ("2026-04-18T22:00:00.000") into
//      proper UTC-offset ISO strings via nycWallclockToIso.
//
// Why auto-seed instead of a hand-curated allowlist?
//   RA's NYC area feed is already genre-scoped to electronic music, and a
//   whitelist silently drops real events (Paragon, Jupiter Disco, The Ten
//   Bells, outdoor pop-ups, etc.). Auto-seed keeps coverage honest: every
//   RA event maps to a venue row, and venue curation becomes a display-time
//   concern rather than an ingestion-time gate.
//
// Deduplication with per-venue scrapers:
//   Venues in EXCLUDED_RA_VENUE_IDS are skipped here because their dedicated
//   scrapers publish events under a different `source` value. If both
//   scrapers wrote, we'd end up with two rows for the same event
//   (source=ra-nyc:123 and source=nowadays:456). The exclusion keeps one
//   canonical row per event.

import type { Scraper, RawEvent } from '../../types.js';
import { RawEventSchema } from '../../types.js';
import {
  fetchAreaEventListings,
  type RAEventWithVenue,
} from '../../ra-graphql.js';
import { nycWallclockToIso } from '../../time.js';
import { parseArtists } from '../../artist-parsing.js';
import { supabase } from '../../supabase.js';
import { slugify } from '../../slug.js';

const SOURCE = 'ra-nyc';
const NYC_AREA_ID = 8;
const DEFAULT_HORIZON_DAYS = 30;

// Venues with their own dedicated scraper. We skip them here to keep one
// canonical (source, source_id) per event. If a venue here ever loses its
// dedicated scraper, remove its id from this set and ra-nyc will pick it
// up automatically.
const EXCLUDED_RA_VENUE_IDS = new Set<string>([
  '164270', // Public Records  → scraped via publicrecords.nyc
  '105873', // Nowadays        → dedicated RA-backed scraper
  '139960', // Elsewhere       → scraped via elsewhere.club
]);

// In-run cache: RA venue id → our venues.slug. Avoids repeated DB
// round-trips and ensures at most one venues-upsert per venue per run.
type VenueCache = Map<string, string>;

async function resolveVenueSlug(
  raVenue: RAEventWithVenue['venue'],
  cache: VenueCache,
): Promise<string | null> {
  if (!raVenue?.id || !raVenue.name) return null;
  const cached = cache.get(raVenue.id);
  if (cached) return cached;

  const slug = slugify(raVenue.name);
  if (!slug) return null;

  const client = supabase();

  // Select-first, insert-on-miss — same pattern as getOrCreateArtist in
  // normalizer.ts. Avoids overwriting hand-seeded venue metadata
  // (neighborhood, website, lat/lng) with null when the slug already exists.
  const existing = await client
    .from('venues')
    .select('slug')
    .eq('slug', slug)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (!existing.data) {
    const inserted = await client
      .from('venues')
      .insert({ name: raVenue.name, slug });
    // 23505 = unique_violation — a concurrent run inserted it. Tolerable.
    if (inserted.error && inserted.error.code !== '23505') {
      throw inserted.error;
    }
  }

  cache.set(raVenue.id, slug);
  return slug;
}

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

  // RA's `flyerFront` is always null on both eventListings and event(id)
  // queries. The real image data lives in `images[]`, where the front flyer
  // is marked type=FLYERFRONT. Fall back to the first image if no explicit
  // FLYERFRONT (covers events that only have a back flyer tagged) and
  // finally to flyerFront for forward compatibility.
  const flyerFront = (e.images ?? []).find((img) => img.type === 'FLYERFRONT');
  const fallbackImage = (e.images ?? [])[0];
  const imageUrl =
    flyerFront?.filename ?? fallbackImage?.filename ?? e.flyerFront ?? null;

  // RA tags events with editorial genres (e.g. "House", "Techno", "Drum &
  // Bass"). These are the most reliable base-layer signal we have because
  // they're curated per-event at listing time — no dependency on MB coverage
  // for any individual artist. Empty array when RA hasn't tagged yet.
  const sourceGenres = (e.genres ?? [])
    .map((g) => g.name?.trim())
    .filter((n): n is string => !!n);

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
    imageUrl,
    description: null,
    artistNames,
    sourceGenres,
    raw: {
      raEventId: e.id,
      raContentUrl: contentUrl,
      raVenueId: e.venue.id,
      raVenueName: e.venue.name,
      isTicketed: e.isTicketed,
      artistIds: (e.artists ?? []).map((a) => a.id),
      raGenres: (e.genres ?? []).map((g) => ({ id: g.id, name: g.name })),
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

  const venueCache: VenueCache = new Map();
  const out: RawEvent[] = [];
  let seededCount = 0;
  const skipped: Record<string, number> = {};

  for (const e of events) {
    const raVenueId = e.venue?.id;
    if (!raVenueId) {
      skipped['no-venue'] = (skipped['no-venue'] ?? 0) + 1;
      continue;
    }
    if (EXCLUDED_RA_VENUE_IDS.has(raVenueId)) {
      // Covered by dedicated scraper — deliberate skip, not a drop.
      skipped[`excluded:${e.venue.name || raVenueId}`] =
        (skipped[`excluded:${e.venue.name || raVenueId}`] ?? 0) + 1;
      continue;
    }

    const wasKnown = venueCache.has(raVenueId);
    const slug = await resolveVenueSlug(e.venue, venueCache);
    if (!slug) {
      skipped[`unslugifiable:${e.venue.name || raVenueId}`] =
        (skipped[`unslugifiable:${e.venue.name || raVenueId}`] ?? 0) + 1;
      continue;
    }
    if (!wasKnown) seededCount++;

    const mapped = toRawEvent(e, slug);
    if (mapped) out.push(mapped);
  }

  if (process.env.CURI_VERBOSE) {
    const top = Object.entries(skipped)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    // eslint-disable-next-line no-console
    console.log(
      `[ra-nyc] venues seen=${venueCache.size} (new-this-run=${seededCount}), ` +
        `skipped categories (top 20):`,
      top,
    );
  }

  return out;
}

export const raNycScraper: Scraper = {
  source: SOURCE,
  scrape,
};
