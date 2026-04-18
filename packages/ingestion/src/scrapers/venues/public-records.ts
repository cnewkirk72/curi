// Public Records (publicrecords.nyc/calendar) scraper.
//
// The calendar page is fully server-rendered HTML — no JS required. We fetch,
// parse with regex against the well-structured table rows, and return RawEvents.
//
// Structure (from live inspection 2026-04):
//   <a class="event table-row" href="{ticket_url}" data-id="{id}">
//     <div class="table-cell date">
//       Sat 4.18<br/>
//       Live, 6:00 pm,<br/>
//       <span class="location">{room}</span>...
//     </div>
//     <div class="table-cell title">{title}</div>
//   </a>
//
// If their markup changes significantly the tests and this regex block will be
// the only things to touch. Marked as `source: venue:public-records`.

import { env } from '../../env.js';
import type { Scraper, RawEvent } from '../../types.js';
import { RawEventSchema } from '../../types.js';
import { parseArtists } from '../../artist-parsing.js';
import { nycWallclockToIso, inferYear } from '../../time.js';

const CALENDAR_URL = 'https://publicrecords.nyc/calendar';
const SOURCE = 'venue:public-records';
const VENUE_SLUG = 'public-records';

// Matches one `<a class="event table-row" ...>…</a>` block. Non-greedy.
const EVENT_BLOCK =
  /<a[^>]*class="event table-row"[^>]*href="([^"]+)"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

// Inside a block: pull the date cell and title cell text.
const DATE_CELL = /<div[^>]*class="table-cell date"[^>]*>([\s\S]*?)<\/div>/;
const TITLE_CELL = /<div[^>]*class="table-cell title"[^>]*>([\s\S]*?)<\/div>/;
const LOCATION_SPANS = /<span[^>]*class="location"[^>]*>([^<]+)<\/span>/g;

// Day abbreviation (3 letters) + space + "M.D" or "MM.D" or "M.DD" or "MM.DD"
// Followed (on next line after <br/>) by the category, a comma, time, etc.
const DATE_LINE = /[A-Za-z]{3}\s+(\d{1,2})\.(\d{1,2})/;
const CATEGORY_TIME = /([A-Za-z]+),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i;

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
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEventBlock(params: {
  ticketUrl: string;
  sourceId: string;
  inner: string;
}): RawEvent | null {
  const { ticketUrl, sourceId, inner } = params;

  const dateMatch = inner.match(DATE_CELL);
  const titleMatch = inner.match(TITLE_CELL);
  if (!dateMatch || !titleMatch) return null;

  const dateHtml = dateMatch[1];
  const titleHtml = titleMatch[1];
  if (!dateHtml || !titleHtml) return null;

  // Pull locations before stripping (we want them as structured values).
  const locations: string[] = [];
  let locMatch: RegExpExecArray | null;
  const locRe = new RegExp(LOCATION_SPANS.source, 'g');
  while ((locMatch = locRe.exec(dateHtml)) !== null) {
    if (locMatch[1]) locations.push(locMatch[1].trim());
  }

  const dateText = stripTags(dateHtml);
  const titleText = stripTags(titleHtml).replace(/\s*Get tickets\s*$/i, '');
  if (!titleText) return null;

  const dateMD = dateText.match(DATE_LINE);
  if (!dateMD) return null;
  const month = Number(dateMD[1]);
  const day = Number(dateMD[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;

  const timeMatch = dateText.match(CATEGORY_TIME);
  if (!timeMatch) return null;
  const category = timeMatch[1] ?? '';
  let hour = Number(timeMatch[2]);
  const minute = Number(timeMatch[3]);
  const ampm = (timeMatch[4] ?? '').toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const year = inferYear(month, day);
  const startsAt = nycWallclockToIso(year, month, day, hour, minute);

  const artistNames = parseArtists(titleText);

  return RawEventSchema.parse({
    sourceId,
    source: SOURCE,
    title: titleText,
    startsAt,
    endsAt: null,
    venueSlug: VENUE_SLUG,
    priceMin: null,
    priceMax: null,
    ticketUrl: ticketUrl || null,
    imageUrl: null,
    description: null,
    artistNames,
    raw: {
      category,
      locations,
      dateText,
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
    // Cloudflare challenge or aggressive rate limit — skip + log.
    throw new Error(`public-records blocked (${res.status}) — skipping`);
  }
  if (!res.ok) {
    throw new Error(
      `public-records calendar fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}

async function scrape(): Promise<RawEvent[]> {
  const html = await fetchCalendar();
  const events: RawEvent[] = [];
  const errors: string[] = [];
  let match: RegExpExecArray | null;

  const re = new RegExp(EVENT_BLOCK.source, 'g');
  while ((match = re.exec(html)) !== null) {
    const [, ticketUrl, sourceId, inner] = match;
    if (!ticketUrl || !sourceId || !inner) continue;
    try {
      const ev = parseEventBlock({ ticketUrl, sourceId, inner });
      if (ev) events.push(ev);
    } catch (err) {
      errors.push(`data-id=${sourceId}: ${(err as Error).message}`);
    }
  }

  if (events.length === 0 && errors.length > 0) {
    throw new Error(
      `public-records parsed 0 events; first errors: ${errors.slice(0, 3).join(' | ')}`,
    );
  }
  return events;
}

export const publicRecordsScraper: Scraper = {
  source: SOURCE,
  scrape,
};
