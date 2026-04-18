// Elsewhere (elsewhere.club/events) scraper.
//
// Elsewhere's Next.js listing page ships every event as server-rendered HTML
// with *schema.org/MusicEvent microdata*, which is a much cleaner parse target
// than raw CSS classes — itemProp attributes are semantic and stable across
// redesigns. We lean on them entirely; the class-based regexes are only for
// the two fields that aren't in microdata (room/space and live-vs-club badge).
//
// Verified coverage over 36 upcoming articles (2026-04-18):
//   startDate/endDate/image : 100%
//   price                   : 35/36   (one TBA/free event)
//   performer microdata     : 32/36   (fall back to parseArtists(title) otherwise)
//   Eventbrite ticket link  : 35/36
//   Known rooms             : 99 Scott, Chatroom, Full Venue, The Hall,
//                             The Rooftop, Zone One
//
// Note: "99 Scott" is a sibling venue a few blocks from Elsewhere. We keep the
// room in raw.room but still attribute the event to venueSlug "elsewhere" —
// filtering those out (if we ever want to) is a normalizer concern.
//
// Marked as `source: venue:elsewhere`.

import { env } from '../../env.js';
import type { Scraper, RawEvent } from '../../types.js';
import { RawEventSchema } from '../../types.js';
import { parseArtists } from '../../artist-parsing.js';

const CALENDAR_URL = 'https://www.elsewhere.club/events';
const SOURCE = 'venue:elsewhere';
const VENUE_SLUG = 'elsewhere';

// One `<article … itemType="https://schema.org/MusicEvent">…</article>`.
const ARTICLE_BLOCK =
  /<article[^>]*itemType="https:\/\/schema\.org\/MusicEvent"[^>]*>([\s\S]*?)<\/article>/g;

// Microdata fields.
const START_DATE_ATTR =
  /<time[^>]*dateTime="([^"]+)"[^>]*itemProp="startDate"[^>]*>/;
const END_DATE_META =
  /<meta[^>]*content="([^"]+)"[^>]*itemProp="endDate"[^>]*\/>/;
const PRICE_META =
  /<meta[^>]*content="([^"]+)"[^>]*itemProp="price"[^>]*\/>/;
const IMAGE_META =
  /<meta[^>]*content="([^"]+)"[^>]*itemProp="image"[^>]*\/>/;
const URL_ANCHOR =
  /<a[^>]*itemProp="url"[^>]*href="(\/events\/(\d+))"[^>]*>\s*<span[^>]*itemProp="name"[^>]*>([^<]+)<\/span>/;
// Multiple performer blocks; each has a <meta content="Name" itemProp="name"/>.
const PERFORMER_NAME =
  /<div[^>]*itemProp="performer"[^>]*itemType="https:\/\/schema\.org\/MusicGroup"[^>]*>\s*<meta[^>]*content="([^"]+)"[^>]*itemProp="name"[^>]*\/>/g;

// Non-microdata: room badge and live/club type badge.
const BADGE_SPACE = /listing-badge-list__space[^>]*>([^<]+)</;
const BADGE_TYPE = /listing-badge-list__type[^>]*>([^<]+)</;

// Buy Tickets anchor.
const BUY_TICKETS =
  /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*aria-label="Buy Tickets[^"]*"[^>]*>/;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function firstGroup(re: RegExp, s: string): string | null {
  const m = s.match(re);
  return m && m[1] ? m[1] : null;
}

function parseArticle(inner: string): RawEvent | null {
  // URL + source-id + title are all in one anchor; if that's missing we
  // can't key the event, so skip.
  const urlMatch = inner.match(URL_ANCHOR);
  if (!urlMatch) return null;
  const [, pathOnly, sourceId, rawTitle] = urlMatch;
  if (!pathOnly || !sourceId || !rawTitle) return null;

  const title = decodeEntities(rawTitle).trim();
  if (!title) return null;

  const startsAtRaw = firstGroup(START_DATE_ATTR, inner);
  if (!startsAtRaw) return null; // required
  const startsAt = new Date(startsAtRaw).toISOString();

  const endsAtRaw = firstGroup(END_DATE_META, inner);
  const endsAt = endsAtRaw ? new Date(endsAtRaw).toISOString() : null;

  const priceRaw = firstGroup(PRICE_META, inner);
  const priceParsed = priceRaw ? Number(priceRaw) : null;
  // Their markup carries only a single price (entry price). Mirror it into
  // min + max so downstream filters work; if we later see ranges we'll split.
  const priceMin =
    priceParsed != null && Number.isFinite(priceParsed) ? priceParsed : null;
  const priceMax = priceMin;

  const imageRaw = firstGroup(IMAGE_META, inner);
  const imageUrl = imageRaw ? decodeEntities(imageRaw) : null;

  const ticketUrlRaw = firstGroup(BUY_TICKETS, inner);
  const ticketUrl = ticketUrlRaw ? decodeEntities(ticketUrlRaw) : null;

  // Prefer performer microdata over parsing the title — higher quality.
  const performerNames: string[] = [];
  const reP = new RegExp(PERFORMER_NAME.source, 'g');
  let pm: RegExpExecArray | null;
  while ((pm = reP.exec(inner)) !== null) {
    if (pm[1]) {
      const n = decodeEntities(pm[1]).trim();
      if (n) performerNames.push(n);
    }
  }
  const artistNames = performerNames.length > 0
    ? performerNames
    : parseArtists(title);

  const room = firstGroup(BADGE_SPACE, inner)?.trim() ?? null;
  const type = firstGroup(BADGE_TYPE, inner)?.trim().toLowerCase() ?? null;

  const ticketUrlAbs = ticketUrl;
  const eventUrl = `https://www.elsewhere.club${pathOnly}`;

  return RawEventSchema.parse({
    sourceId,
    source: SOURCE,
    title,
    startsAt,
    endsAt,
    venueSlug: VENUE_SLUG,
    priceMin,
    priceMax,
    ticketUrl: ticketUrlAbs ?? eventUrl,
    imageUrl,
    description: null,
    artistNames,
    raw: {
      room,
      type,
      eventUrl,
      performerCount: performerNames.length,
      performersFromMicrodata: performerNames.length > 0,
    },
  });
}

async function fetchCalendar(): Promise<string> {
  const res = await fetch(CALENDAR_URL, {
    headers: {
      'User-Agent': env.musicbrainzUserAgent,
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (res.status === 403 || res.status === 503) {
    throw new Error(`elsewhere blocked (${res.status}) — skipping`);
  }
  if (!res.ok) {
    throw new Error(
      `elsewhere calendar fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}

async function scrape(): Promise<RawEvent[]> {
  const html = await fetchCalendar();
  const events: RawEvent[] = [];
  const errors: string[] = [];

  const re = new RegExp(ARTICLE_BLOCK.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const inner = match[1];
    if (!inner) continue;
    try {
      const ev = parseArticle(inner);
      if (ev) events.push(ev);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (events.length === 0 && errors.length > 0) {
    throw new Error(
      `elsewhere parsed 0 events; first errors: ${errors.slice(0, 3).join(' | ')}`,
    );
  }
  return events;
}

export const elsewhereScraper: Scraper = {
  source: SOURCE,
  scrape,
};
