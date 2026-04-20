// Pulls artist names out of an event title or lineup string.
//
// Heuristics (tuned against Public Records / Nowadays / Elsewhere / Shotgun titles):
//   "Public Records presents: Floating Points (live) + DJ Python"
//   "DJ Python b2b Yaeji"
//   "Headliner — support: Local1, Local2"
//   "DJ Python, Yaeji, Eris Drew, Octo Octa"
//   "A b2b B b2b C"
//
// The goal is "probably an artist name" — downstream MusicBrainz lookup decides
// what's real. False positives are cheap (enrichment just fails); false
// negatives hide artists entirely, so we err on the side of inclusion.
//
// This module also exposes classifyArtistName / cleanArtistPiece / NOISE_EXACT
// etc. so the audit pipeline (src/audit.ts) and the runtime normalizer
// (src/normalizer.ts) share one source of truth for reject rules. parseArtists
// itself delegates its keep/clean logic through classifyArtistName, so any
// rule added here takes effect at scrape time AND audit time.

const PRESENTS_SPLIT = /(?:^|[^a-z0-9])(?:presents?|present|pres\.)\s*:?\s*/i;
// `feat` is followed by `\b\.?` rather than `feat\.?\b` so the optional period
// is consumed as part of the delimiter. With `feat\.?\b`, "feat." never matched
// (the `.`→space transition isn't a word boundary), so the engine fell back to
// matching just "feat" and left the orphan period on the next piece — e.g.
// "PLUS ONE feat. MILHOUSE, …" produced ["PLUS ONE", ". MILHOUSE", …].
const SUPPORT_SPLIT = /\s*(?:\b(?:support|w\/|with|feat|featuring)\b\.?)\s*:?\s*/i;
const B2B_SPLIT = /\s+(?:b2b|b3b|b4b|vs\.?|x|&)\s+/i;
const COMMA_SPLIT = /\s*(?:,|\+|\/|;|·|•|→|\||\band\b)\s*/i;

// Matches (live), [live], (dj set), etc. — anywhere in the string.
const LIVE_TAG = /\s*[([](?:live|dj set|live set|dj|all night long|anl|b2b)[)\]]\s*/gi;

// "Series: Artist1, Artist2…" — short prefix (≤ 5 words) + colon at title start.
const SERIES_PREFIX = /^([A-Z][\w'&\s]{1,60}?):\s+(?=\S)/;

// "X \"Album\" Release Show" — strip quoted album/track titles and trailing
// "Release Show" / "Album Release" / "EP Release" tails.
const QUOTED_BLOCK = /[\u201C\u201D\u2018\u2019"'][^\u201C\u201D\u2018\u2019"']+[\u201C\u201D\u2018\u2019"']/g;
const RELEASE_TAIL = /\s*(?:album release|ep release|release show|record release|single release)\s*$/i;

// Trailing orphan conjunctions — e.g. "Nikara Warren x" left after a quoted
// block next to it was stripped. Also handles leading orphans ("& Nikara").
const ORPHAN_CONJ_TAIL = /\s+(?:b2b|b3b|b4b|vs\.?|x|&|\+|\/)\s*$/i;
const ORPHAN_CONJ_HEAD = /^(?:b2b|b3b|b4b|vs\.?|x|&|\+|\/)\s+/i;

/**
 * Placeholder / lineup-noise exact matches. Case-insensitive full-name match
 * only — "DJ Shadow" normalizes to "dj shadow" (with whitespace preserved) and
 * will NOT collide with anything shorter here, so real artists whose names
 * start with "DJ" / "MC" are always kept.
 */
export const NOISE_EXACT: ReadonlySet<string> = new Set([
  // Original Phase 2a noise list (task #27).
  'tbd',
  'tba',
  'special guest',
  'special guests',
  'more tba',
  'and more',
  'local support',
  'residents',
  'hosts',
  // Phase 4f.8 audit extensions — placeholder variants that have leaked into
  // the artists table historically (scrapers bypassing parseArtists, or
  // structured scrapers pulling RA / Shotgun lineup rows verbatim).
  'guest',
  'guests',
  'support',
  'supporting',
  'opener',
  'openers',
  'special',
  'secret',
  'secret guest',
  'secret guests',
  'mystery guest',
  'resident',
  'various',
  'various artists',
  'various hosts',
  'unknown',
  'friends',
  'and friends',
  'and djs',
  'more',
  'more acts tba',
  'headliner',
  'headliners',
  'djs',
  'host',
]);

/**
 * Event-descriptor words that, when present in a piece, strongly indicate the
 * piece is an event title/format rather than an artist name.
 *   "Climate Game Show Night"  → drop
 *   "Wednesday Panel Discussion" → drop
 *   "Ableton Workshop" → drop
 * Matches only when the word appears as a whole token (not inside another word)
 * so legit stage names like "Show Me Body" or "Panel Van" aren't false-positived.
 */
export const EVENT_WORD_PATTERNS: readonly RegExp[] = [
  /\bgame\s+show\b/i,
  /\bquiz\s+night\b/i,
  /\btrivia\b/i,
  /\bopen\s+(?:mic|decks)\b/i,
  /\bworkshop\b/i,
  /\bpanel(?:\s+discussion)?\b/i,
  /\bscreening\b/i,
  /\blistening\s+(?:session|party|bar)\b/i,
  /\bbook\s+(?:launch|release|reading)\b/i,
  /\bfilm\s+(?:screening|premiere)\b/i,
  /\bfundraiser\b/i,
  /\btalk\b(?!\s+box)/i, // "talk" but not "talk box"
];

export function looksLikeEventTitle(piece: string): boolean {
  for (const pat of EVENT_WORD_PATTERNS) {
    if (pat.test(piece)) return true;
  }
  return false;
}

/**
 * Strip live/dj/quote/release-tail noise from a raw artist piece and collapse
 * whitespace. Idempotent — running it on an already-cleaned string returns
 * the same string. Exported so audit.ts can use the same cleaning pass when
 * proposing punctuation-artifact repairs.
 */
export function cleanArtistPiece(piece: string): string {
  return piece
    .replace(LIVE_TAG, ' ')
    .replace(QUOTED_BLOCK, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(RELEASE_TAIL, '')
    .replace(ORPHAN_CONJ_TAIL, '')
    .replace(ORPHAN_CONJ_HEAD, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ClassifyReason =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'noise'
  | 'event_title';

export interface ClassifyResult {
  /** True if the cleaned name is plausibly an artist and should be kept. */
  valid: boolean;
  /**
   * Non-null when valid=false. Gives the audit category and the scraper a
   * machine-readable reject code.
   */
  reason: ClassifyReason | null;
  /** Cleaned version of the input (quotes / live tags / orphan conjunctions stripped). */
  cleaned: string;
}

/**
 * Central rule for "is this string an artist name we should keep?". Used by:
 *   - parseArtists() at scrape time (via the keep path below)
 *   - src/normalizer.ts at upsert time as forward-prevention
 *   - src/audit.ts at audit time to detect junk rows already in the DB
 *
 * One source of truth means: any new reject rule added here automatically
 * applies across all three call sites. That's the whole point of the refactor.
 */
export function classifyArtistName(
  raw: string | null | undefined,
): ClassifyResult {
  const cleaned = cleanArtistPiece(raw ?? '');
  if (!cleaned) return { valid: false, reason: 'empty', cleaned };
  if (cleaned.length < 2) return { valid: false, reason: 'too_short', cleaned };
  if (cleaned.length > 80) return { valid: false, reason: 'too_long', cleaned };
  if (NOISE_EXACT.has(cleaned.toLowerCase())) {
    return { valid: false, reason: 'noise', cleaned };
  }
  if (looksLikeEventTitle(cleaned)) {
    return { valid: false, reason: 'event_title', cleaned };
  }
  // Bare venue phrases like "the basement" — we can't reliably tell apart from
  // a DJ named "The Basement", so we let these through and let MB filter.
  return { valid: true, reason: null, cleaned };
}

/**
 * Collision key for audit duplicate detection. Case-insensitive, whitespace-
 * normalized, but preserves punctuation and unicode symbols — so symbol-only
 * artists remain distinct from each other. Per Christian: some legit artist
 * names are entirely symbols, so we do NOT strip punct for identity.
 */
export function artistCollisionKey(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function parseArtists(title: string): string[] {
  if (!title) return [];

  // Pre-clean: strip quoted album/track names globally so they don't confuse
  // the comma splitter.
  let working = title.replace(QUOTED_BLOCK, ' ').replace(/\s+/g, ' ').trim();

  // 1. Drop "Venue presents:" — only care about what's after.
  const presentsMatch = working.split(PRESENTS_SPLIT);
  if (presentsMatch.length > 1) {
    working = presentsMatch.slice(1).join(' ');
  }

  // 1b. "Series Name: artists…" — strip the prefix if it looks like a
  // series / showcase name (capitalized, short, followed by a list).
  const seriesMatch = working.match(SERIES_PREFIX);
  if (seriesMatch) {
    const afterColon = working.slice(seriesMatch[0].length);
    if (afterColon.includes(',') || COMMA_SPLIT.test(afterColon) || B2B_SPLIT.test(afterColon)) {
      working = afterColon;
    }
  }

  // 2. Pull off "support:" / "w/" tails as a separate bucket.
  const supportSplit = working.split(SUPPORT_SPLIT);
  const primary = supportSplit[0] ?? '';
  const support = supportSplit.slice(1).join(' ');

  // 3. Expand b2b chains.
  const b2bExpanded = [
    ...primary.split(B2B_SPLIT),
    ...(support ? support.split(B2B_SPLIT) : []),
  ];

  // 4. Split on commas / plus / slash / "and".
  const pieces: string[] = [];
  for (const chunk of b2bExpanded) {
    for (const piece of chunk.split(COMMA_SPLIT)) {
      pieces.push(piece);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of pieces) {
    const { valid, cleaned } = classifyArtistName(raw);
    if (!valid) continue;
    const k = cleaned.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cleaned);
  }
  return out;
}
