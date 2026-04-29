// Ticketmaster Discovery API → Electronic NYC events aggregator.
//
// Complements ra-nyc by pulling major-label shows (MSG, Terminal 5, Webster
// Hall, etc.) that don't always appear on RA. Uses the same auto-seed venue
// pattern as ra-nyc, but TM provides lat/lng/website/images directly so
// newly-seeded venue rows arrive with real coordinates — no follow-up needed.
//
// Deduplication with ra-nyc:
//   The normalizer's find_dupe_event_by_artist fires when venue_id + time
//   ± 60 min + ≥1 artist slug match. For venues where both scrapers produce
//   the same slug (e.g. "webster-hall") dupes are suppressed automatically.
//   TM venue name variants ("Irving Plaza Powered By Verizon 5G" vs.
//   "Irving Plaza") will create a separate venue row; a venue alias map can
//   collapse those if coverage overlap becomes noisy.
//
// Enrichment strategy (null-safe patching):
//   Every DB write — venues, artists — only fills fields that are currently
//   null. We never overwrite data set by a higher-quality source (Spotify API,
//   MusicBrainz, Firecrawl). TM data is treated as a "seed layer".
//
// Dry-run / preview:
//   Import scrapePreview() — fetches from TM and maps events/venues/artists
//   using locally-computed slugs with zero Supabase calls. Used by
//   scripts/smoke-ticketmaster-nyc.ts and safe to run without DB creds.

import type { Scraper, RawEvent } from '../../types.js';
import type { Database } from '../../db-types.js';
import { RawEventSchema } from '../../types.js';
import { nycWallclockToIso } from '../../time.js';
import { parseArtists } from '../../artist-parsing.js';
import { supabase } from '../../supabase.js';
import { slugify } from '../../slug.js';
import { env } from '../../env.js';

const SOURCE = 'ticketmaster-nyc';
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
const HORIZON_DAYS = 90;
const PAGE_SIZE = 200; // TM max
const MAX_PAGES = 5;   // 1 000 events cap per genre per run
const PAGE_DELAY_MS = 300;

// TM splits electronic music across multiple genre buckets. Querying all of
// them significantly increases coverage — a show at Webster Hall might be
// filed under "Dance/Electronic" rather than "Electronic" depending on how the
// promoter submitted it.
const CLASSIFICATION_NAMES = ['Electronic', 'Dance/Electronic', 'Dance', 'EDM'];

// ── API types ────────────────────────────────────────────────────────────────
// Full shape of TM Discovery API v2 responses. Optional fields reflect real
// API variability — never assume a field is present.

interface TmImage {
  url?: string;
  width?: number;
  height?: number;
  ratio?: string;
  fallback?: boolean;
}

interface TmExternalLinks {
  spotify?:      Array<{ url?: string }>;
  soundcloud?:   Array<{ url?: string }>;
  // TM musicbrainz entries carry the UUID directly in `id` — no URL parsing needed.
  musicbrainz?:  Array<{ id?: string; url?: string }>;
  homepage?:     Array<{ url?: string }>;
  twitter?:      Array<{ url?: string }>;
  facebook?:     Array<{ url?: string }>;
  instagram?:    Array<{ url?: string }>;
  youtube?:      Array<{ url?: string }>;
  itunes?:       Array<{ url?: string }>;
  lastfm?:       Array<{ url?: string }>;
  wiki?:         Array<{ url?: string }>;
  [key: string]: Array<{ url?: string; id?: string }> | undefined;
}

interface TmVenue {
  id: string;
  name: string;
  // TM URL is the venue's TM listing page — prefer externalLinks.homepage for website
  url?: string;
  images?: TmImage[];
  externalLinks?: TmExternalLinks;
  address?: { line1?: string };
  city?: { name?: string };
  state?: { name?: string; stateCode?: string };
  country?: { name?: string; countryCode?: string };
  postalCode?: string;
  timezone?: string;
  location?: { latitude?: string; longitude?: string };
  generalInfo?: { generalRule?: string; childRule?: string };
  boxOfficeInfo?: {
    phoneNumberDetail?: string;
    openHoursDetail?: string;
    acceptedPaymentDetail?: string;
    willCallDetail?: string;
  };
  parkingDetail?: string;
  accessibleSeatingDetail?: string;
  upcomingEvents?: { _total?: number };
  social?: { twitter?: { handle?: string } };
  aliases?: string[];
}

interface TmAttraction {
  id: string;
  name: string;
  url?: string;
  images?: TmImage[];
  externalLinks?: TmExternalLinks;
  classifications?: Array<{
    primary?: boolean;
    segment?: { id?: string; name?: string };
    genre?: { id?: string; name?: string };
    subGenre?: { id?: string; name?: string };
    type?: { id?: string; name?: string };
    subType?: { id?: string; name?: string };
    family?: boolean;
  }>;
  upcomingEvents?: { _total?: number };
  aliases?: string[];
}

interface TmEvent {
  id: string;
  name: string;
  url?: string;
  locale?: string;
  images?: TmImage[];
  info?: string;
  pleaseNote?: string;
  dates?: {
    start?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
      dateTBD?: boolean;
      dateTBA?: boolean;
      timeTBA?: boolean;
      noSpecificTime?: boolean;
    };
    end?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
      approximate?: boolean;
      noSpecificTime?: boolean;
    };
    timezone?: string;
    status?: { code?: string };
    spanMultipleDays?: boolean;
  };
  // doorsTimes: when doors open (distinct from event start)
  doorsTimes?: {
    localDate?: string;
    localTime?: string;
    dateTime?: string;
  };
  sales?: {
    public?: {
      startDateTime?: string;
      startTBD?: boolean;
      startTBA?: boolean;
      endDateTime?: string;
    };
    presales?: Array<{
      startDateTime?: string;
      endDateTime?: string;
      name?: string;
    }>;
  };
  priceRanges?: Array<{ type?: string; min?: number; max?: number; currency?: string }>;
  classifications?: Array<{
    primary?: boolean;
    segment?: { id?: string; name?: string };
    genre?: { id?: string; name?: string };
    subGenre?: { id?: string; name?: string };
    type?: { id?: string; name?: string };
    subType?: { id?: string; name?: string };
    family?: boolean;
  }>;
  promoter?: { id?: string; name?: string; description?: string };
  promoters?: Array<{ id?: string; name?: string; description?: string }>;
  ageRestrictions?: { legalAgeEnforced?: boolean };
  accessibility?: { ticketLimit?: number; info?: string };
  ticketLimit?: { info?: string };
  ticketing?: {
    safeTix?: { enabled?: boolean };
    allInclusivePricing?: { enabled?: boolean };
  };
  seatmap?: { staticUrl?: string };
  _embedded?: {
    venues?: TmVenue[];
    attractions?: TmAttraction[];
  };
}

interface TmPageResponse {
  _embedded?: { events?: TmEvent[] };
  page?: { totalPages?: number };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchPage(
  apiKey: string,
  page: number,
  gte: string,
  lte: string,
  classificationName: string,
): Promise<{ events: TmEvent[]; totalPages: number }> {
  const params = new URLSearchParams({
    apikey: apiKey,
    city: 'New York',
    stateCode: 'NY',
    countryCode: 'US',
    classificationName,
    startDateTime: gte,
    endDateTime: lte,
    size: String(PAGE_SIZE),
    page: String(page),
    sort: 'date,asc',
  });

  const res = await fetch(`${TM_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });

  if (res.status === 401)
    throw new Error('Ticketmaster 401 — check TICKETMASTER_API_KEY');
  if (res.status === 429)
    throw new Error('Ticketmaster rate limited — try again later');
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    throw new Error(`Ticketmaster HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as TmPageResponse;
  return {
    events: data._embedded?.events ?? [],
    totalPages: data.page?.totalPages ?? 1,
  };
}

/** TM datetime format: YYYY-MM-DDTHH:MM:SSZ — no milliseconds. */
function toTmDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function fetchGenre(
  apiKey: string,
  gte: string,
  lte: string,
  classificationName: string,
): Promise<TmEvent[]> {
  const events: TmEvent[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { events: batch, totalPages } = await fetchPage(apiKey, page, gte, lte, classificationName);
    events.push(...batch);
    if (page + 1 >= totalPages) break;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }
  return events;
}

async function fetchAllEvents(apiKey: string): Promise<TmEvent[]> {
  const now = new Date();
  const gte = toTmDateTime(now);
  const lte = toTmDateTime(new Date(now.getTime() + HORIZON_DAYS * 86_400_000));

  // Query each genre bucket separately and dedupe by TM event id.
  // A single show may appear under multiple classifications so dedup is essential.
  const seen = new Set<string>();
  const all: TmEvent[] = [];

  for (const genre of CLASSIFICATION_NAMES) {
    const events = await fetchGenre(apiKey, gte, lte, genre);
    for (const e of events) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        all.push(e);
      }
    }
    if (process.env.CURI_VERBOSE) {
      console.log(`[ticketmaster-nyc] genre="${genre}" → ${events.length} events (${all.length} unique so far)`);
    }
    // Brief pause between genre queries to stay polite
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return all;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

/**
 * Pick the best image from a TM images array.
 * Prefers non-fallback images; among those, picks the widest.
 * Falls back to fallback images if no non-fallback exist.
 */
function bestImage(images: TmImage[] | undefined): string | null {
  if (!images?.length) return null;
  const nonFallback = images.filter((i) => !i.fallback);
  const pool = nonFallback.length > 0 ? nonFallback : images;
  return pool.reduce((best, img) =>
    (img.width ?? 0) > (best.width ?? 0) ? img : best,
  ).url ?? null;
}

// ── Venue resolution (DB) ─────────────────────────────────────────────────────

type VenueCache = Map<string, string>; // TM venue id → our slug

type VenuePatch = Database['public']['Tables']['venues']['Update'];

function tmVenueToInsert(v: TmVenue, slug: string) {
  const lat = v.location?.latitude ? Number(v.location.latitude) : null;
  const lng = v.location?.longitude ? Number(v.location.longitude) : null;
  // Prefer the venue's own homepage over its TM listing URL
  const website = v.externalLinks?.homepage?.[0]?.url ?? v.url ?? null;
  const image_url = bestImage(v.images);
  return { name: v.name, slug, lat, lng, website, image_url };
}

/**
 * Ensure a venue row exists and backfill any null fields TM can provide.
 * On INSERT: writes all available TM fields.
 * On existing row: patches lat/lng, website, image_url only when currently null.
 * This means running the scraper repeatedly on existing venues is safe and
 * gradually fills in missing coordinates + images for all 247 rows.
 */
async function resolveVenueSlug(
  tmVenue: TmVenue,
  cache: VenueCache,
): Promise<string | null> {
  const cached = cache.get(tmVenue.id);
  if (cached !== undefined) return cached;

  const slug = slugify(tmVenue.name);
  if (!slug) return null;

  const client = supabase();

  const existing = await client
    .from('venues')
    .select('slug, lat, lng, website, image_url')
    .eq('slug', slug)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (!existing.data) {
    // New venue — insert with all available TM data
    const row = tmVenueToInsert(tmVenue, slug);
    const inserted = await client.from('venues').insert(row);
    // 23505 = unique_violation (concurrent run) — tolerable
    if (inserted.error && inserted.error.code !== '23505') {
      throw inserted.error;
    }
  } else {
    // Existing venue — patch only null fields (never overwrite richer data)
    const row = tmVenueToInsert(tmVenue, slug);
    const patch: VenuePatch = {};
    if (existing.data.lat == null && row.lat != null) patch.lat = row.lat;
    if (existing.data.lng == null && row.lng != null) patch.lng = row.lng;
    if (!existing.data.website && row.website) patch.website = row.website;
    if (!existing.data.image_url && row.image_url) patch.image_url = row.image_url;
    if (Object.keys(patch).length > 0) {
      const { error } = await client.from('venues').update(patch).eq('slug', slug);
      if (error) console.warn(`[ticketmaster-nyc] venue patch failed for "${slug}": ${error.message}`);
    }
  }

  cache.set(tmVenue.id, slug);
  return slug;
}

// ── Event mapping ─────────────────────────────────────────────────────────────

function tmLocalToIso(localDate: string, localTime?: string): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const [h = 0, min = 0] = (localTime ?? '00:00').split(':').map(Number) as [
    number,
    number,
  ];
  return nycWallclockToIso(y, m, d, h, min);
}

function toRawEvent(e: TmEvent, venueSlug: string): RawEvent | null {
  if (!e.id || !e.name) return null;

  const start = e.dates?.start;
  if (!start?.localDate || start.dateTBA || start.dateTBD) return null;

  const startsAt = tmLocalToIso(
    start.localDate,
    start.timeTBA || start.noSpecificTime ? undefined : start.localTime,
  );

  // endsAt: use end.dateTime if TM provides it
  let endsAt: string | null = null;
  if (e.dates?.end?.dateTime) {
    endsAt = e.dates.end.dateTime;
  } else if (e.dates?.end?.localDate) {
    endsAt = tmLocalToIso(
      e.dates.end.localDate,
      e.dates.end.noSpecificTime ? undefined : e.dates.end.localTime,
    );
  }

  const attractions = e._embedded?.attractions ?? [];
  const artistNames =
    attractions.length > 0
      ? attractions.map((a) => a.name).filter(Boolean)
      : parseArtists(e.name);

  // sourceGenres: include segment (when meaningful), genre, and subgenre
  // for maximum taxonomy coverage. "Music" is too broad to be useful;
  // "Electronic" as a segment is a real signal.
  const SKIP_TAGS = new Set(['Undefined', 'Music', 'Other', 'Miscellaneous']);
  const cls = e.classifications?.[0];
  const sourceGenres: string[] = [];
  for (const tag of [
    cls?.segment?.name,
    cls?.genre?.name,
    cls?.subGenre?.name,
  ]) {
    if (tag && !SKIP_TAGS.has(tag) && !sourceGenres.includes(tag)) {
      sourceGenres.push(tag);
    }
  }

  const priceRanges = e.priceRanges ?? [];
  // TM uses 0/0 as sentinel for "price unknown" — treat as null
  const rawMin = priceRanges[0]?.min ?? null;
  const rawMax = priceRanges[0]?.max ?? null;
  const priceMin = rawMin != null && rawMin > 0 ? rawMin : null;
  const priceMax = rawMax != null && rawMax > 0 ? rawMax : null;

  // Description: TM's info field has venue notes, lineup blurbs, restrictions.
  // Fall back to pleaseNote (age restrictions, bag policy, etc.) if info absent.
  const description = e.info?.trim() || e.pleaseNote?.trim() || null;

  const tmVenue = e._embedded?.venues?.[0];

  return RawEventSchema.parse({
    sourceId: e.id,
    source: SOURCE,
    title: e.name,
    startsAt,
    endsAt,
    venueSlug,
    priceMin,
    priceMax,
    ticketUrl: e.url ?? null,
    imageUrl: bestImage(e.images),
    description,
    artistNames,
    sourceGenres,
    raw: {
      // IDs for cross-referencing
      tmEventId: e.id,
      tmVenueId: tmVenue?.id ?? null,
      tmAttractionIds: attractions.map((a) => a.id),

      // Classification
      segment:  cls?.segment?.name ?? null,
      genre:    cls?.genre?.name ?? null,
      subgenre: cls?.subGenre?.name ?? null,
      type:     cls?.type?.name ?? null,
      subType:  cls?.subType?.name ?? null,
      family:   cls?.family ?? false,

      // Status & dates
      status:       e.dates?.status?.code ?? null,
      timezone:     e.dates?.timezone ?? null,
      spanMultiple: e.dates?.spanMultipleDays ?? false,
      doorsTime:    e.doorsTimes?.localTime ?? null,

      // Ticketing
      onsaleStart:        e.sales?.public?.startDateTime ?? null,
      onsaleEnd:          e.sales?.public?.endDateTime ?? null,
      presales:           e.sales?.presales ?? [],
      priceRangesRaw:     priceRanges,
      allInclusivePricing: e.ticketing?.allInclusivePricing?.enabled ?? false,
      safeTix:            e.ticketing?.safeTix?.enabled ?? false,
      seatmapUrl:         e.seatmap?.staticUrl ?? null,
      ticketLimitInfo:    e.ticketLimit?.info ?? null,

      // Info & restrictions
      accessibilityInfo:  e.accessibility?.info ?? null,
      ageRestricted:      e.ageRestrictions?.legalAgeEnforced ?? false,
      pleaseNote:         e.pleaseNote ?? null,

      // Promoter
      promoter: e.promoter?.name ?? null,

      // Venue snapshot (for auditing — the actual venue row is resolved separately)
      venueName:    tmVenue?.name ?? null,
      venueAddress: tmVenue?.address?.line1 ?? null,
      venueCity:    tmVenue?.city?.name ?? null,
      venueZip:     tmVenue?.postalCode ?? null,
      venueTz:      tmVenue?.timezone ?? null,
    },
  });
}

// ── Attraction / artist seeding ───────────────────────────────────────────────

/** TM-sourced artist enrichment data that seeds the artists table. */
export interface AttractionSeed {
  tmAttractionId: string;
  name: string;
  slug: string;
  spotifyUrl: string | null;
  /** Extracted from the Spotify URL — saves a Spotify API lookup later. */
  spotifyId: string | null;
  soundcloudUrl: string | null;
  /**
   * TM's musicbrainz externalLink carries the UUID directly in the `id` field —
   * no URL parsing needed. Seeding this skips a MusicBrainz API call.
   */
  musicbrainzId: string | null;
  /** Best-resolution TM-hosted artist image. */
  imageUrl: string | null;
  upcomingEvents: number | null;
}

/** Preview-only venue data (no DB reads). */
export interface VenueSeed {
  tmVenueId: string;
  name: string;
  slug: string;
  lat: number | null;
  lng: number | null;
  website: string | null;
  imageUrl: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  timezone: string | null;
  upcomingEvents: number | null;
}

function extractSpotifyId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/);
  return m?.[1] ?? null;
}

function toAttractionSeed(a: TmAttraction): AttractionSeed | null {
  const name = a.name?.trim();
  if (!name) return null;
  const slug = slugify(name);
  if (!slug) return null;

  const links = a.externalLinks ?? {};
  const spotifyUrl = links.spotify?.[0]?.url ?? null;
  const soundcloudUrl = links.soundcloud?.[0]?.url ?? null;
  // TM provides the MB UUID directly in the `id` field of the musicbrainz entry
  const musicbrainzId = links.musicbrainz?.[0]?.id ?? null;

  return {
    tmAttractionId: a.id,
    name,
    slug,
    spotifyUrl,
    spotifyId: extractSpotifyId(spotifyUrl),
    soundcloudUrl,
    musicbrainzId,
    imageUrl: bestImage(a.images),
    upcomingEvents: a.upcomingEvents?._total ?? null,
  };
}

function toVenueSeed(v: TmVenue): VenueSeed | null {
  const name = v.name?.trim();
  if (!name) return null;
  const slug = slugify(name);
  if (!slug) return null;

  return {
    tmVenueId: v.id,
    name,
    slug,
    lat: v.location?.latitude ? Number(v.location.latitude) : null,
    lng: v.location?.longitude ? Number(v.location.longitude) : null,
    website: v.externalLinks?.homepage?.[0]?.url ?? v.url ?? null,
    imageUrl: bestImage(v.images),
    address: v.address?.line1 ?? null,
    city: v.city?.name ?? null,
    postalCode: v.postalCode ?? null,
    timezone: v.timezone ?? null,
    upcomingEvents: v.upcomingEvents?._total ?? null,
  };
}

/**
 * Collect unique AttractionSeeds from a batch of TM events.
 * Deduped by slug — first occurrence wins (TM attraction objects are stable
 * across events so data quality is consistent).
 */
function collectAttractionSeeds(events: TmEvent[]): AttractionSeed[] {
  const seen = new Map<string, AttractionSeed>();
  for (const e of events) {
    for (const a of e._embedded?.attractions ?? []) {
      const seed = toAttractionSeed(a);
      if (seed && !seen.has(seed.slug)) seen.set(seed.slug, seed);
    }
  }
  return [...seen.values()];
}

function collectVenueSeeds(events: TmEvent[]): VenueSeed[] {
  const seen = new Map<string, VenueSeed>();
  for (const e of events) {
    const v = e._embedded?.venues?.[0];
    if (!v) continue;
    const seed = toVenueSeed(v);
    if (seed && !seen.has(seed.slug)) seen.set(seed.slug, seed);
  }
  return [...seen.values()];
}

/**
 * Upsert one attraction into the artists table.
 * Only fills fields that are currently null — never overwrites Spotify/MB enrichment.
 */
async function seedArtistLinks(seed: AttractionSeed): Promise<void> {
  const client = supabase();

  // 1. Ensure artist row exists
  await client
    .from('artists')
    .upsert({ name: seed.name, slug: seed.slug }, { onConflict: 'slug', ignoreDuplicates: true });

  // 2. Read current nullable link fields
  const { data } = await client
    .from('artists')
    .select('spotify_url, spotify_id, soundcloud_url, musicbrainz_id')
    .eq('slug', seed.slug)
    .single();

  if (!data) return;

  type ArtistPatch = Database['public']['Tables']['artists']['Update'];
  const patch: ArtistPatch = {};
  if (!data.spotify_url     && seed.spotifyUrl)     patch.spotify_url     = seed.spotifyUrl;
  if (!data.spotify_id      && seed.spotifyId)      patch.spotify_id      = seed.spotifyId;
  if (!data.soundcloud_url  && seed.soundcloudUrl)  patch.soundcloud_url  = seed.soundcloudUrl;
  if (!data.musicbrainz_id  && seed.musicbrainzId)  patch.musicbrainz_id  = seed.musicbrainzId;

  if (Object.keys(patch).length > 0) {
    await client.from('artists').update(patch).eq('slug', seed.slug);
  }
}

// ── Preview result ────────────────────────────────────────────────────────────

export interface ScrapePreviewResult {
  events: RawEvent[];
  attractionSeeds: AttractionSeed[];
  venueSeeds: VenueSeed[];
}

// ── Preview (no DB) ───────────────────────────────────────────────────────────

// Fetches from TM and maps events/venues/artists using locally-computed slugs.
// Zero Supabase calls — safe to run without DB credentials.
// Used by scripts/smoke-ticketmaster-nyc.ts.
export async function scrapePreview(): Promise<ScrapePreviewResult> {
  const apiKey = env.ticketmasterApiKey;
  if (!apiKey) {
    console.warn('[ticketmaster-nyc] TICKETMASTER_API_KEY not set — skipping');
    return { events: [], attractionSeeds: [], venueSeeds: [] };
  }

  const rawEvents = await fetchAllEvents(apiKey);
  const out: RawEvent[] = [];

  for (const e of rawEvents) {
    const tmVenue = e._embedded?.venues?.[0];
    if (!tmVenue?.name) continue;
    const slug = slugify(tmVenue.name);
    if (!slug) continue;
    const mapped = toRawEvent(e, slug);
    if (mapped) out.push(mapped);
  }

  return {
    events: out,
    attractionSeeds: collectAttractionSeeds(rawEvents),
    venueSeeds: collectVenueSeeds(rawEvents),
  };
}

// ── Full scraper (with DB) ────────────────────────────────────────────────────

async function scrape(): Promise<RawEvent[]> {
  const apiKey = env.ticketmasterApiKey;
  if (!apiKey) {
    console.warn('[ticketmaster-nyc] TICKETMASTER_API_KEY not set — skipping');
    return [];
  }

  const rawEvents = await fetchAllEvents(apiKey);
  const venueCache: VenueCache = new Map();
  const out: RawEvent[] = [];
  const skipped: Record<string, number> = {};

  for (const e of rawEvents) {
    const tmVenue = e._embedded?.venues?.[0];
    if (!tmVenue?.name) {
      skipped['no-venue'] = (skipped['no-venue'] ?? 0) + 1;
      continue;
    }

    const slug = await resolveVenueSlug(tmVenue, venueCache);
    if (!slug) {
      skipped[`unslugifiable:${tmVenue.name}`] =
        (skipped[`unslugifiable:${tmVenue.name}`] ?? 0) + 1;
      continue;
    }

    const mapped = toRawEvent(e, slug);
    if (mapped) {
      out.push(mapped);
    } else {
      skipped['unmappable'] = (skipped['unmappable'] ?? 0) + 1;
    }
  }

  // Seed artist links (Spotify, SoundCloud, MusicBrainz) from TM attraction objects.
  // Runs after event mapping — a failed seed never blocks event ingestion.
  // Patches only null fields, so safe to run on every scrape.
  const attractionSeeds = collectAttractionSeeds(rawEvents);
  let seededArtists = 0;
  for (const seed of attractionSeeds) {
    try {
      await seedArtistLinks(seed);
      seededArtists++;
    } catch (err) {
      console.warn(`[ticketmaster-nyc] artist seed failed for "${seed.name}": ${String(err)}`);
    }
  }

  if (process.env.CURI_VERBOSE) {
    console.log(
      `[ticketmaster-nyc] venues=${venueCache.size}, events=${out.length}, ` +
        `artistsSeeded=${seededArtists}, skipped=${JSON.stringify(skipped)}`,
    );
  }

  return out;
}

export const ticketmasterNycScraper: Scraper = {
  source: SOURCE,
  scrape,
};
