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
// Conservative: only strip if the first word isn't itself likely an artist
// handle (e.g. doesn't start with DJ, a lowercase handle, or obvious stage name).
const SERIES_PREFIX = /^([A-Z][\w'&\s]{1,60}?):\s+(?=\S)/;

// "X \"Album\" Release Show" — strip quoted album/track titles and trailing
// "Release Show" / "Album Release" / "EP Release" tails.
// Match both straight ASCII quotes and curly quotes (U+201C / U+201D, U+2018 / U+2019).
// Use explicit Unicode escapes so the regex doesn't depend on the file's quote bytes.
const QUOTED_BLOCK = /[\u201C\u201D\u2018\u2019"'][^\u201C\u201D\u2018\u2019"']+[\u201C\u201D\u2018\u2019"']/g;
const RELEASE_TAIL = /\s*(?:album release|ep release|release show|record release|single release)\s*$/i;

const NOISE_EXACT = new Set([
  'tbd',
  'tba',
  'special guest',
  'special guests',
  'more tba',
  'and more',
  'local support',
  'residents',
  'hosts',
]);

// Event-descriptor words that, when present in a piece, strongly indicate the
// piece is an event title/format rather than an artist name.
//   "Climate Game Show Night"  → drop
//   "Wednesday Panel Discussion" → drop
//   "Ableton Workshop" → drop
// Matches only when the word appears as a whole token (not inside another word)
// so legit stage names like "Show Me Body" or "Panel Van" aren't false-positived.
const EVENT_WORD_PATTERNS = [
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

function looksLikeEventTitle(piece: string): boolean {
  for (const pat of EVENT_WORD_PATTERNS) {
    if (pat.test(piece)) return true;
  }
  return false;
}

// Trailing orphan conjunctions — e.g. "Nikara Warren x" left after a quoted
// block next to it was stripped. Also handles leading orphans ("& Nikara").
const ORPHAN_CONJ_TAIL = /\s+(?:b2b|b3b|b4b|vs\.?|x|&|\+|\/)\s*$/i;
const ORPHAN_CONJ_HEAD = /^(?:b2b|b3b|b4b|vs\.?|x|&|\+|\/)\s+/i;

function clean(piece: string): string {
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

function keep(piece: string): boolean {
  if (!piece) return false;
  if (piece.length < 2) return false;
  if (piece.length > 80) return false;
  if (NOISE_EXACT.has(piece.toLowerCase())) return false;
  if (looksLikeEventTitle(piece)) return false;
  // Bare venue phrases like "the basement" — we can't reliably tell apart from a DJ
  // named "The Basement", so we let these through and let MB filter.
  return true;
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
  // Runs regardless of whether 1 matched: presenter titles can still have a
  // series prefix after the "presents", e.g. "X presents Take Two: A, B, C".
  const seriesMatch = working.match(SERIES_PREFIX);
  if (seriesMatch) {
    const afterColon = working.slice(seriesMatch[0].length);
    // Only strip if what's after the colon looks like a list of 2+ artists.
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
    const c = clean(raw);
    if (!keep(c)) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
