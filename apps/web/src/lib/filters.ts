// Filter state for the home feed. Source of truth is the URL search
// params — `?when=weekend&genres=techno,house&vibes=groovy&setting=warehouse`
// — so filter URLs are shareable ("here's all the techno this weekend")
// and back-button navigation works with no extra glue.
//
// `parseFilters` (server-side & client-side) converts searchParams
// into a FilterState; `serializeFilters` goes the other way. The
// sheet keeps a local draft state and only commits via router.push
// on Apply — that's why we need the round-trip.
//
// ── Phase 3.18 vocabulary rebuild ─────────────────────────────────
//
// Genres: rebuilt from the post-Phase-3.15 NYC-wide data. Default-14
// visible row + 10 in "More genres" (collapse/expand). Slugs match
// `events.genres` byte-for-byte.
//
// Vibes: now exclusively the artist-mood vocabulary the LLM enrichment
// already produces (groovy, hypnotic, dark, soulful, driving, ...).
// The original "event-context" vibes (warehouse / peak-time / basement)
// moved to a dedicated Setting filter, because they're produced by a
// different pipeline (deterministic venue+time derivation, not LLM).
//
// Setting: new filter dimension backed by `events.setting` (migration
// 0017). Vocabulary: warehouse, basement, outdoor, daytime, peak-time,
// late-night, underground. Optional — most users won't touch it.

import { nycDayKey } from './format';

// ── Types ─────────────────────────────────────────────────

export type DateFilter =
  | 'all'
  | 'tonight'
  | 'tomorrow'
  | 'weekend'
  | 'week'
  // Phase 6.2 — user picked a specific start day (and optional end
  // day) from the date picker. `date_from` is required when this is
  // set; `date_to` is optional — when only `date_from` is set the
  // filter is open-ended ("from X onward"), which is how a
  // single-click in range mode commits.
  | 'custom';

export type FilterState = {
  when: DateFilter;
  /**
   * Phase 6.2 — inclusive start day for a custom range, as a
   * `YYYY-MM-DD` NYC-local dayKey. Non-null only when `when === 'custom'`.
   */
  date_from: string | null;
  /**
   * Phase 6.2 — inclusive end day for a custom range, as a
   * `YYYY-MM-DD` NYC-local dayKey. Non-null only when
   * `when === 'custom'` AND the user has picked the second endpoint;
   * a null `date_to` while `when === 'custom'` means the filter is
   * open-ended ("from `date_from` onward").
   */
  date_to: string | null;
  genres: string[];
  vibes: string[];
  /**
   * Phase 3.18 — event-context tags from a fixed vocabulary. See
   * `SETTING_OPTIONS` below + migration 0017 + the SQL derivation
   * comment on events.setting. Distinct from `vibes` (artist-mood)
   * — keeps the "the show feels like X" signal separate from the
   * "the artist sounds like Y" signal.
   */
  setting: string[];
  /**
   * Subgenre slugs selected under the currently-active parent genres.
   * These filter the feed via `artists.subgenres` overlap (see
   * `lib/events.ts` — events don't carry subgenres directly; we
   * resolve through event_artists → artists).
   *
   * Invariant: when a parent genre is deselected, any subgenres
   * registered to that parent are also cleared. The filter sheet
   * enforces this on toggle; `parseFilters` does NOT re-enforce it,
   * so a hand-crafted URL can technically keep `?subgenres=` without
   * its parent — the feed query just won't return anything for
   * orphaned subgenres (no parent means no overlap constraint
   * widening). That's fine for correctness; we don't try to fix
   * hand-crafted URLs.
   */
  subgenres: string[];
  q: string;
  /**
   * Phase 6.3 v2 — single artist scope filter, surfaced when the user
   * taps a "Show events with [Artist]" entity button in the search
   * dropdown. Stored as `artists.slug` (already unique from migration
   * 0001). Lookup at query time joins through `event_artists` →
   * `artists.slug = state.artist`. Renders as a violet active chip.
   *
   * Single-value (string | null) rather than an array because the UX
   * intent is a focus/scope filter — "show me Courtesy's events" is
   * unambiguous; "Courtesy OR Surusinghe" doesn't have a natural
   * surface in the current dropdown spec.
   */
  artist: string | null;
  /**
   * Phase 6.3 v2 — single venue scope filter, parallel to `artist`.
   * Stored as `venues.slug`. Renders as an amber active chip.
   */
  venue: string | null;
};

export const EMPTY_FILTERS: FilterState = {
  when: 'all',
  date_from: null,
  date_to: null,
  genres: [],
  vibes: [],
  setting: [],
  subgenres: [],
  q: '',
  artist: null,
  venue: null,
};

// ── URL ↔ FilterState ─────────────────────────────────────────

// `URLSearchParams` (server page props) and `ReadonlyURLSearchParams`
// (Next's client hook) share `.get()`, which is all we read — so we
// accept both via a structural type and avoid dragging the
// next/navigation type into a server-friendly module.
type ParamsLike = { get: (key: string) => string | null };

function isDateFilter(v: string | null): v is DateFilter {
  return (
    v === 'tonight' ||
    v === 'tomorrow' ||
    v === 'weekend' ||
    v === 'week' ||
    v === 'custom'
  );
}

// Validates a `YYYY-MM-DD` dayKey. We don't want a hand-crafted URL
// with `?from=banana` to blow up the server render — just fall back
// to null and the query will ignore the broken range.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDayKey(v: string | null): string | null {
  if (!v || !DAY_KEY_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  // Round-trip through Date to reject impossible calendar days like
  // 2026-02-31 — UTC construction auto-rolls, so comparing components
  // catches the rewrite.
  const test = new Date(Date.UTC(y, m - 1, d));
  if (
    test.getUTCFullYear() !== y ||
    test.getUTCMonth() !== m - 1 ||
    test.getUTCDate() !== d
  ) {
    return null;
  }
  return v;
}

export function parseFilters(sp: ParamsLike): FilterState {
  const when = sp.get('when');
  const from = parseDayKey(sp.get('from'));
  const to = parseDayKey(sp.get('to'));

  // Custom range discipline:
  //   - `when=custom` requires at least `from` (`to` is optional —
  //     first click in the range picker commits as "from X onward"
  //     with an open-ended upper bound; second click narrows to a
  //     closed range). If neither is set we demote to 'all'.
  //   - If only `to` is set (unusual — callers shouldn't do this),
  //     promote it to `from` so the filter still makes sense.
  //   - If from > to, swap — lets a user click end-first and still
  //     land on a sane closed window without a correctness pop-up.
  let resolvedWhen: DateFilter = isDateFilter(when) ? when : 'all';
  let date_from = from;
  let date_to = to;
  if (resolvedWhen === 'custom') {
    if (!date_from && !date_to) {
      resolvedWhen = 'all';
    } else if (!date_from && date_to) {
      date_from = date_to;
      date_to = null;
    } else if (date_from && date_to && date_from > date_to) {
      const tmp = date_from;
      date_from = date_to;
      date_to = tmp;
    }
    // date_from alone is valid — open-ended "from X onward" filter.
  } else {
    // Preset 'when' + from/to shouldn't coexist — the preset wins,
    // drop the orphan days.
    date_from = null;
    date_to = null;
  }

  return {
    when: resolvedWhen,
    date_from,
    date_to,
    genres: (sp.get('genres') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    vibes: (sp.get('vibes') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    setting: (sp.get('setting') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Subgenres are stored as-is rather than lowercased/dashed because
    // the underlying `artists.subgenres` values are inconsistent —
    // some hyphenated (`hard-techno`), some space-separated
    // (`dark techno`). We match the DB strings byte-for-byte on the
    // filter overlap, so URL normalization stops at trim + filter.
    subgenres: (sp.get('subgenres') ?? '')
      .split(',')
      .map((s) => decodeURIComponent(s).trim())
      .filter(Boolean),
    q: (sp.get('q') ?? '').trim().slice(0, 200),
    // Slug params from search dropdown entity-button taps. Lowercased
    // for consistency with how slugs are stored, length-capped so a
    // hand-crafted URL can't blow up the query, and rejected if they
    // contain anything outside the safe `[a-z0-9-]` slug alphabet.
    artist: parseSlugParam(sp.get('artist')),
    venue: parseSlugParam(sp.get('venue')),
  };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
function parseSlugParam(v: string | null): string | null {
  if (!v) return null;
  const normalized = v.trim().toLowerCase();
  return SLUG_RE.test(normalized) ? normalized : null;
}

/**
 * Returns a query string (no leading `?`) — empty string when no
 * filters are active. Callers typically do
 * `router.push(pathname + (qs ? '?' + qs : ''))`.
 */
export function serializeFilters(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.when !== 'all') params.set('when', state.when);
  if (state.when === 'custom' && state.date_from) {
    // `to` is optional — the first click in a range-mode picker
    // commits just `from` for an open-ended "from X onward" filter.
    params.set('from', state.date_from);
    if (state.date_to) params.set('to', state.date_to);
  }
  if (state.genres.length) params.set('genres', state.genres.join(','));
  if (state.vibes.length) params.set('vibes', state.vibes.join(','));
  if (state.setting.length) params.set('setting', state.setting.join(','));
  if (state.subgenres.length) params.set('subgenres', state.subgenres.join(','));
  if (state.q) params.set('q', state.q);
  if (state.artist) params.set('artist', state.artist);
  if (state.venue) params.set('venue', state.venue);
  return params.toString();
}

export function hasActiveFilters(state: FilterState): boolean {
  return (
    state.when !== 'all' ||
    state.genres.length > 0 ||
    state.vibes.length > 0 ||
    state.setting.length > 0 ||
    state.subgenres.length > 0 ||
    state.q.length > 0 ||
    state.artist !== null ||
    state.venue !== null
  );
}

export function activeFilterCount(state: FilterState): number {
  return (
    (state.when !== 'all' ? 1 : 0) +
    state.genres.length +
    state.vibes.length +
    state.setting.length +
    state.subgenres.length +
    (state.artist ? 1 : 0) +
    (state.venue ? 1 : 0)
  );
}

// ── Curated option lists ──────────────────────────────────────

export type FilterOption = { slug: string; label: string };

/**
 * Genre vocabulary (Phase 3.18). 24 parents, ordered as:
 *
 *   - First 14: default-visible row in the filter sidebar / sheet.
 *     Order chosen to surface the densest NYC-electronic genres first
 *     (techno, house, bass, dnb, ...) so the most-used filters are
 *     immediately tappable. (See `DEFAULT_VISIBLE_GENRES_COUNT` —
 *     `sortGenresByPrefs` uses this constant to slice.)
 *
 *   - Last 10: "More genres" — revealed by an expand toggle. These
 *     are real NYC-relevant genres with sparse-but-real coverage
 *     (hip-hop, latin, indie, jazz, etc.) that we don't want to
 *     surface by default but absolutely should be filterable.
 *
 * Slugs match `events.genres` byte-for-byte. If you add or rename
 * here, also update the data — not the other way around.
 */
export const GENRE_OPTIONS: FilterOption[] = [
  // Default-visible 14 (high-density NYC electronic + adjacent)
  { slug: 'techno', label: 'Techno' },
  { slug: 'house', label: 'House' },
  { slug: 'bass', label: 'Bass' },
  { slug: 'dnb', label: 'Drum & Bass' },
  { slug: 'disco', label: 'Disco' },
  { slug: 'electronic', label: 'Electronic' },
  { slug: 'indie', label: 'Indie' },
  { slug: 'breaks', label: 'Breaks' },
  { slug: 'garage', label: 'Garage' },
  { slug: 'experimental', label: 'Experimental' },
  { slug: 'funk', label: 'Funk' },
  { slug: 'electro', label: 'Electro' },
  { slug: 'trance', label: 'Trance' },
  { slug: 'pop', label: 'Pop' },
  // "More genres" — revealed via expand toggle
  { slug: 'hip-hop', label: 'Hip-Hop' },
  { slug: 'latin', label: 'Latin' },
  { slug: 'ambient', label: 'Ambient' },
  { slug: 'world', label: 'World' },
  { slug: 'soul', label: 'Soul' },
  { slug: 'rock', label: 'Rock' },
  { slug: 'r&b', label: 'R&B' },
  { slug: 'jazz', label: 'Jazz' },
  { slug: 'reggae', label: 'Reggae' },
  { slug: 'classical', label: 'Classical' },
];

/** Index where "More genres" starts. The first N items in
 * GENRE_OPTIONS are the always-visible default; the rest are
 * revealed by the More toggle. */
export const DEFAULT_VISIBLE_GENRES_COUNT = 14;

/**
 * Vibe vocabulary (Phase 3.18). Artist-mood descriptors only —
 * the LLM enrichment pipeline is the source of these values
 * (see `packages/ingestion/src/llm-enrichment.ts:177-178`).
 *
 * Renamed/dropped vs. the MVP list:
 *   - `experimental` → renamed to `adventurous`. The genre filter
 *     already exposes `experimental`; the Vibe variant captures
 *     "this artist's character is adventurous" which is a different
 *     dimension and benefits from a distinct label.
 *   - `industrial` → dropped. The genre filter covers "industrial as
 *     a sound" via the techno parent + industrial subgenre, and the
 *     Setting filter covers "industrial as a venue type" via
 *     warehouse/basement.
 *
 * The original event-context vibes (warehouse / peak-time / basement /
 * daytime / queer / underground) moved to SETTING_OPTIONS — they were
 * never producible by the artist-enrichment pipeline.
 */
export const VIBE_OPTIONS: FilterOption[] = [
  { slug: 'groovy', label: 'Groovy' },
  { slug: 'hypnotic', label: 'Hypnotic' },
  { slug: 'eclectic', label: 'Eclectic' },
  { slug: 'dark', label: 'Dark' },
  { slug: 'melodic', label: 'Melodic' },
  { slug: 'energetic', label: 'Energetic' },
  { slug: 'driving', label: 'Driving' },
  { slug: 'soulful', label: 'Soulful' },
  { slug: 'euphoric', label: 'Euphoric' },
  { slug: 'ethereal', label: 'Ethereal' },
  { slug: 'adventurous', label: 'Adventurous' },
  { slug: 'cinematic', label: 'Cinematic' },
];

/**
 * Setting vocabulary (Phase 3.18, NEW). Event-context tags derived
 * deterministically from venue + start_at + lineup follower totals.
 * See migration 0017 + the SQL derivation in the cleanup migration
 * for the exact mapping rules.
 *
 * Optional filter — most users will never touch it. Renders below
 * Vibe in the sidebar / sheet.
 */
export const SETTING_OPTIONS: FilterOption[] = [
  { slug: 'daytime', label: 'Daytime' },
  { slug: 'peak-time', label: 'Peak Time' },
  { slug: 'late-night', label: 'Late Night' },
  { slug: 'outdoor', label: 'Outdoor' },
  { slug: 'underground', label: 'Underground' },
  { slug: 'warehouse', label: 'Warehouse' },
  { slug: 'basement', label: 'Basement' },
];

// Preset options rendered in the filter sheet/sidebar "When" section.
// 'custom' is intentionally excluded — it's selected implicitly when
// the user picks a range in the date picker, not via a pill.
export const DATE_OPTIONS: { slug: Exclude<DateFilter, 'custom'>; label: string }[] = [
  { slug: 'all', label: 'All upcoming' },
  { slug: 'tonight', label: 'Tonight' },
  { slug: 'tomorrow', label: 'Tomorrow' },
  { slug: 'weekend', label: 'This weekend' },
  { slug: 'week', label: 'This week' },
];

// ── Subgenres (Phase 3.18 update) ─────────────────────────────
//
// Curated map from parent-genre slug → recognizable subgenres. The
// slugs here match the raw strings stored in `artists.subgenres[]`
// byte-for-byte (that's what the feed query overlaps on), which is
// why some are hyphenated (`hard-techno`) and some are space-
// separated (`dark techno`) — we match whatever the taxonomy ingest
// actually wrote.
//
// Curation rationale:
//   (1) ≥8 upcoming events show this subgenre in their lineup
//       (meaningful recall — picking the filter actually returns
//       a non-trivial result set)
//   (2) reads as a coherent subgenre under the parent
//   (3) isn't the parent itself
//
// Phase 3.18 changes:
//   - `breakbeat` parent renamed to `breaks` (matches data)
//   - `deep-house` removed as parent (data only stored it as a
//     subgenre under house)
//   - new `industrial` subgenre under techno (was a parent, now
//     correctly a subgenre per migration 0018)
//   - new `hardcore-techno`, `hardgroove-techno` under techno
//   - new `psychedelic-rock` under rock
//   - new parents now seeded with their high-density subgenres:
//     experimental, hip-hop, latin, pop, indie, jazz, rock
export const SUBGENRES_BY_PARENT: Record<string, FilterOption[]> = {
  techno: [
    { slug: 'hard-techno', label: 'Hard' },
    { slug: 'dark techno', label: 'Dark' },
    { slug: 'melodic techno', label: 'Melodic' },
    { slug: 'deep techno', label: 'Deep' },
    { slug: 'experimental techno', label: 'Experimental' },
    { slug: 'dub-techno', label: 'Dub' },
    { slug: 'acid techno', label: 'Acid' },
    { slug: 'hardgroove techno', label: 'Hardgroove' },
    { slug: 'hardcore-techno', label: 'Hardcore' },
    { slug: 'industrial', label: 'Industrial' },
    { slug: 'minimal', label: 'Minimal' },
  ],
  house: [
    { slug: 'deep-house', label: 'Deep House' },
    { slug: 'tech-house', label: 'Tech House' },
    { slug: 'afro-house', label: 'Afro House' },
    { slug: 'melodic house', label: 'Melodic House' },
    { slug: 'disco-house', label: 'Disco House' },
    { slug: 'soul-house', label: 'Soulful House' },
    { slug: 'progressive house', label: 'Progressive' },
    { slug: 'latin house', label: 'Latin House' },
    { slug: 'organic house', label: 'Organic' },
    { slug: 'garage house', label: 'Garage House' },
    { slug: 'ballroom house', label: 'Ballroom' },
    { slug: 'chicago-house', label: 'Chicago' },
    { slug: 'left-field house', label: 'Left-Field' },
    { slug: 'ghetto house', label: 'Ghetto' },
    { slug: 'lo-fi house', label: 'Lo-Fi' },
  ],
  bass: [
    { slug: 'uk bass', label: 'UK Bass' },
    { slug: 'deep dubstep', label: 'Deep Dubstep' },
  ],
  breaks: [
    { slug: 'breaks', label: 'Breaks' },
    { slug: 'jersey-club', label: 'Jersey Club' },
    { slug: 'footwork', label: 'Footwork' },
  ],
  disco: [
    { slug: 'nu disco', label: 'Nu Disco' },
    { slug: 'italo-disco', label: 'Italo' },
  ],
  electro: [
    { slug: 'indie dance', label: 'Indie Dance' },
  ],
  garage: [
    { slug: 'two-step-garage', label: 'Two-Step' },
    { slug: 'uk bass', label: 'UK Bass' },
  ],
  ambient: [
    { slug: 'ambient electronic', label: 'Electronic' },
    { slug: 'dark-ambient', label: 'Dark' },
    { slug: 'drone ambient', label: 'Drone' },
    { slug: 'ambient house', label: 'Ambient House' },
  ],
  experimental: [
    { slug: 'experimental electronic', label: 'Electronic' },
    { slug: 'experimental club', label: 'Club' },
    { slug: 'experimental techno', label: 'Techno' },
    { slug: 'deconstructed club', label: 'Deconstructed' },
    { slug: 'experimental pop', label: 'Pop' },
    { slug: 'noise', label: 'Noise' },
  ],
  pop: [
    { slug: 'experimental pop', label: 'Experimental' },
    { slug: 'synth-pop', label: 'Synth-Pop' },
    { slug: 'indie-pop', label: 'Indie' },
    { slug: 'dream pop', label: 'Dream' },
    { slug: 'hyperpop', label: 'Hyperpop' },
    { slug: 'dance-pop', label: 'Dance' },
  ],
  indie: [
    { slug: 'indie electronic', label: 'Electronic' },
    { slug: 'indie-pop', label: 'Pop' },
    { slug: 'indie-rock', label: 'Rock' },
  ],
  rock: [
    { slug: 'indie-rock', label: 'Indie' },
    { slug: 'alternative rock', label: 'Alternative' },
    { slug: 'experimental rock', label: 'Experimental' },
    { slug: 'psychedelic-rock', label: 'Psychedelic' },
    { slug: 'dance-punk', label: 'Dance-Punk' },
  ],
  latin: [
    { slug: 'latin pop', label: 'Pop' },
    { slug: 'latin house', label: 'House' },
    { slug: 'alternative reggaeton', label: 'Alt-Reggaeton' },
    { slug: 'reggaeton', label: 'Reggaeton' },
    { slug: 'baile-funk', label: 'Baile Funk' },
  ],
  'hip-hop': [
    { slug: 'east coast hip hop', label: 'East Coast' },
  ],
  jazz: [
    { slug: 'nu jazz', label: 'Nu Jazz' },
  ],
  // Families without curated subgenres yet (sparse ingest data):
  //   dnb, electronic, funk, soul, r&b, world, reggae, classical, trance.
  // Picker shows "no subgenres yet" / hides the row in those cases.
};

/** Subgenre options available for a single parent. Empty array if
 * the parent has no curated subgenres. */
export function subgenresForParent(parentSlug: string): FilterOption[] {
  return SUBGENRES_BY_PARENT[parentSlug] ?? [];
}

/** Has at least one curated subgenre — drives whether the picker
 * bothers rendering a sub-row for this parent. */
export function parentHasSubgenres(parentSlug: string): boolean {
  return (SUBGENRES_BY_PARENT[parentSlug]?.length ?? 0) > 0;
}

/** All curated subgenre slugs, flattened. Used by the upsert-prefs
 * server action's sanitize() to validate the writeable vocabulary. */
export const ALL_SUBGENRE_SLUGS: string[] = Array.from(
  new Set(Object.values(SUBGENRES_BY_PARENT).flatMap((opts) => opts.map((o) => o.slug))),
);

// ── Preference-aware genre ordering ────────────────────────────
//
// Phase 3.18 — the home feed sorts the genre row so that genres a
// user explicitly picked at onboarding bubble to the top of the
// always-visible default-14 slot. Default order fills the rest.
// Anything that doesn't fit goes into "More genres."
//
// Onboarding itself does NOT call this — there's no preference signal
// yet at that stage. It uses the raw `GENRE_OPTIONS` order.

export type SortedGenreOptions = {
  /** Genres shown in the always-visible row (length === DEFAULT_VISIBLE_GENRES_COUNT). */
  visible: FilterOption[];
  /** Genres revealed by the "More genres" expand toggle. */
  more: FilterOption[];
};

/**
 * Sort the GENRE_OPTIONS list by the user's onboarding-time
 * preferences:
 *
 *   1. User-preferred genres (in the order they appear in `prefs`)
 *      go first, capped at DEFAULT_VISIBLE_GENRES_COUNT.
 *   2. Remaining visible slots fill from the default GENRE_OPTIONS
 *      order, skipping anything already promoted.
 *   3. Anything left over goes into `more`.
 *
 * Stable across renders — same input always produces the same order.
 *
 * Pass an empty `prefs` array (or call without it) to get the default
 * order back.
 */
export function sortGenresByPrefs(
  prefs: string[] = [],
  options: FilterOption[] = GENRE_OPTIONS,
): SortedGenreOptions {
  const VISIBLE = DEFAULT_VISIBLE_GENRES_COUNT;
  const bySlug = new Map(options.map((o) => [o.slug, o]));
  const seen = new Set<string>();
  const visible: FilterOption[] = [];

  // (1) Promote prefs first, in pref order.
  for (const slug of prefs) {
    if (visible.length >= VISIBLE) break;
    const opt = bySlug.get(slug);
    if (opt && !seen.has(slug)) {
      visible.push(opt);
      seen.add(slug);
    }
  }
  // (2) Fill remaining slots from default order.
  for (const opt of options) {
    if (visible.length >= VISIBLE) break;
    if (!seen.has(opt.slug)) {
      visible.push(opt);
      seen.add(opt.slug);
    }
  }
  // (3) The rest → "More genres."
  const more = options.filter((o) => !seen.has(o.slug));

  return { visible, more };
}

/**
 * Lighter-weight pref-aware sort for vibes (no hidden "more" row —
 * all 12 vibes are always visible, but user-preferred ones bubble to
 * the front).
 */
export function sortVibesByPrefs(
  prefs: string[] = [],
  options: FilterOption[] = VIBE_OPTIONS,
): FilterOption[] {
  const bySlug = new Map(options.map((o) => [o.slug, o]));
  const seen = new Set<string>();
  const sorted: FilterOption[] = [];
  for (const slug of prefs) {
    const opt = bySlug.get(slug);
    if (opt && !seen.has(slug)) {
      sorted.push(opt);
      seen.add(slug);
    }
  }
  for (const opt of options) {
    if (!seen.has(opt.slug)) {
      sorted.push(opt);
      seen.add(opt.slug);
    }
  }
  return sorted;
}

// ── Label helpers ──────────────────────────────────────────────

export function labelForGenre(slug: string): string {
  return GENRE_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

export function labelForVibe(slug: string): string {
  return VIBE_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

export function labelForSetting(slug: string): string {
  return SETTING_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

export function labelForWhen(slug: DateFilter): string {
  if (slug === 'custom') return 'Custom range';
  return DATE_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

/**
 * Short, chip-friendly label for a `when === 'custom'` window.
 * Examples:
 *   "Apr 25"              (single-day range)
 *   "Apr 25 – Apr 27"     (same-year range)
 *   "Dec 28 – Jan 3"      (same-year range across month boundary)
 *   "Dec 28, 2026 – Jan 3, 2027" (cross-year range)
 *
 * Returns null when the state isn't a valid custom range — callers
 * should fall back to labelForWhen() in that case.
 */
export function labelForDateRange(state: FilterState): string | null {
  if (state.when !== 'custom' || !state.date_from) {
    return null;
  }
  const [fy, fm, fd] = state.date_from.split('-').map(Number) as [number, number, number];
  const from = new Date(Date.UTC(fy, fm - 1, fd));
  const nowYear = new Date().getUTCFullYear();

  const shortOpts: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  };
  const longOpts: Intl.DateTimeFormatOptions = {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };

  // Open-ended "from X onward" — no `to` set yet (first click in a
  // range picker, or user deliberately picked a single-day start).
  if (!state.date_to) {
    const opts = fy === nowYear ? shortOpts : longOpts;
    return `From ${new Intl.DateTimeFormat('en-US', opts).format(from)}`;
  }

  const [ty, tm, td] = state.date_to.split('-').map(Number) as [number, number, number];
  const to = new Date(Date.UTC(ty, tm - 1, td));
  const sameYear = fy === ty;
  const sameDay = state.date_from === state.date_to;

  if (sameDay) {
    // Single-day closed range — drop the year when it's the current year.
    const opts = fy === nowYear ? shortOpts : longOpts;
    return new Intl.DateTimeFormat('en-US', opts).format(from);
  }
  if (sameYear && fy === nowYear) {
    // Most common case: both ends in the current year.
    return `${new Intl.DateTimeFormat('en-US', shortOpts).format(from)} – ${new Intl.DateTimeFormat('en-US', shortOpts).format(to)}`;
  }
  // Cross-year or future-year range — spell out years on both ends
  // so the chip stays unambiguous.
  return `${new Intl.DateTimeFormat('en-US', longOpts).format(from)} – ${new Intl.DateTimeFormat('en-US', longOpts).format(to)}`;
}

/** Display label for a subgenre slug. Used in active-filter chips.
 * First match across all parents wins — subgenres like `uk bass`
 * that live under multiple parents will render the same label
 * regardless of which parent surfaced it. */
export function labelForSubgenre(slug: string): string {
  for (const opts of Object.values(SUBGENRES_BY_PARENT)) {
    const hit = opts.find((o) => o.slug === slug);
    if (hit) return hit.label;
  }
  return slug;
}

/**
 * Compute the calendar-display date for the current filter state — i.e.
 * which day the date picker should highlight given the active filter.
 *
 * Distinct from `dateWindowFor`, which returns the actual filter window
 * used to scope the SQL query: this helper is for *visual feedback* in
 * the date picker only. The mapping mirrors how a user thinks about
 * each preset:
 *
 *   - `tonight`  → today (the night IS the current calendar day)
 *   - `tomorrow` → tomorrow
 *   - `weekend`  → upcoming Friday (start of the Fri-Mon window per
 *                  `dateWindowFor`)
 *   - `week`     → today (start of the now → next-Mon window)
 *   - `custom`   → date_from (or null if not set yet)
 *   - `all`      → null (no highlight)
 *
 * Clicking the highlighted day in the picker still switches the state
 * to `when='custom'` with that date as `date_from` — an intentional
 * promotion from "the preset's 24-hour window" to "from this day
 * onward" — so the visual highlight is a stable signal that flows
 * cleanly into custom-range mode if the user wants more control.
 *
 * Implementation note: this helper duplicates a small amount of date
 * math from `dateWindowFor` rather than calling into it. That's
 * deliberate — `dateWindowFor` returns ISO timestamps tied to the 4am
 * day boundary, while the picker wants `YYYY-MM-DD` calendar dayKeys.
 * The two flavors of "what day is the start of this window" are close
 * but not identical (the 4am boundary can shift by one calendar day
 * for late-night events), and the picker's user-facing semantic is
 * the calendar day, not the technical window-start instant.
 */
export function displayDateForFilter(
  state: FilterState,
  now: Date = new Date(),
): string | null {
  // Custom: use the user's explicit pick (null when they haven't
  // picked yet, e.g., entered custom mode via the picker disclosure
  // before tapping a day).
  if (state.when === 'custom') {
    return state.date_from;
  }

  const todayKey = nycDayKey(now.toISOString());

  switch (state.when) {
    case 'tonight':
      return todayKey;
    case 'tomorrow':
      return addDays(todayKey, 1);
    case 'week':
      return todayKey;
    case 'weekend': {
      // Mirrors dateWindowFor's 'weekend' branch: this Friday, even
      // when we're already mid-weekend (Sat/Sun in the current week).
      const wd = nycWeekday(now);
      let daysToFri: number;
      if (wd >= 1 && wd <= 5) daysToFri = 5 - wd;
      else if (wd === 6) daysToFri = -1;
      else daysToFri = -2;
      return addDays(todayKey, daysToFri);
    }
    case 'all':
    default:
      return null;
  }
}

// ── Date window math (NYC-aware) ───────────────────────────────────
//
// We treat "the day" as running 4am NYC → next 4am NYC, not midnight
// → midnight. A club night starting at 11pm Fri spills into 3am Sat
// in clock time, but in a user's mental model it's still a Friday
// event — this 4am boundary keeps late-night shows grouped with the
// night they belong to.

const NYC_TZ = 'America/New_York';
const DAY_BOUNDARY_HOUR = 4;

/**
 * Returns NYC's UTC offset in hours for `moment`. Uses
 * `shortOffset` format to pick up DST transitions automatically.
 * Examples: -5 (EST), -4 (EDT).
 */
function nycOffsetHours(moment: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NYC_TZ,
    timeZoneName: 'shortOffset',
  });
  const part = fmt.formatToParts(moment).find((p) => p.type === 'timeZoneName');
  const match = part?.value.match(/([+-]\d+)/);
  return match ? parseInt(match[1]!, 10) : -5;
}

/**
 * Convert a `YYYY-MM-DD` NYC dayKey + hour to a UTC ISO string.
 *
 * Sample a mid-day moment on the target date to pick the correct DST
 * offset, then construct the UTC instant that corresponds to
 * `hourNYC:00` local time. This is robust to DST transitions — on
 * "spring forward" days, 4am NYC still exists (no gap at that hour)
 * and on "fall back" days we take the first occurrence (standard
 * behavior for the `America/New_York` DB entry).
 */
function nycToUtcIso(dayKey: string, hourNYC: number): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const sample = new Date(Date.UTC(y, m - 1, d, 12));
  const offset = nycOffsetHours(sample);
  return new Date(Date.UTC(y, m - 1, d, hourNYC - offset)).toISOString();
}

/** Shift a `YYYY-MM-DD` dayKey by N calendar days (UTC arithmetic is
 * safe here since we're only manipulating the date label, not a
 * clock-time instant). */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** NYC-local weekday for a UTC moment. 0=Sun, 1=Mon, …, 6=Sat. */
function nycWeekday(moment: Date): number {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: NYC_TZ,
    weekday: 'short',
  }).format(moment);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
}

export type DateWindow = {
  /** Inclusive lower bound, ISO UTC. */
  startIso: string;
  /** Exclusive upper bound, ISO UTC, or null for "no cap". */
  endIso: string | null;
};

/**
 * Compute the `[start, end)` window for a FilterState's date filter.
 *
 * - `all`:      now → ∞
 * - `tonight`:  now → tomorrow 4am NYC
 * - `tomorrow`: tomorrow 4am NYC → day-after 4am NYC
 * - `weekend`:  Fri 6pm NYC → Mon 4am NYC (clamped to `now` if we're
 *               already inside the window — avoids filtering out
 *               events currently happening on a Saturday)
 * - `week`:     now → next Mon 4am NYC
 * - `custom`:   date_from 4am NYC → (date_to + 1 day) 4am NYC, so a
 *               single-day range (`from === to`) still captures all
 *               events starting that NYC evening through to 4am the
 *               next morning (matching the 4am day-boundary used
 *               throughout). If only `date_from` is set (first click
 *               in a range-mode picker), `endIso` is null — "from X
 *               onward". If the start is in the past relative to
 *               `now`, we clamp `startIso` to `now` — there's no point
 *               querying for events that already happened.
 *
 * Accepts either a bare `DateFilter` (preserves the old call-site
 * shape) or a FilterState (needed for the 'custom' case which depends
 * on date_from/date_to).
 */
export function dateWindowFor(
  input: DateFilter | FilterState,
  now: Date = new Date(),
): DateWindow {
  const when = typeof input === 'string' ? input : input.when;
  const state: FilterState | null = typeof input === 'string' ? null : input;
  const nowIso = now.toISOString();
  const todayKey = nycDayKey(nowIso);

  switch (when) {
    case 'all':
      return { startIso: nowIso, endIso: null };

    case 'tonight':
      return {
        startIso: nowIso,
        endIso: nycToUtcIso(addDays(todayKey, 1), DAY_BOUNDARY_HOUR),
      };

    case 'tomorrow':
      return {
        startIso: nycToUtcIso(addDays(todayKey, 1), DAY_BOUNDARY_HOUR),
        endIso: nycToUtcIso(addDays(todayKey, 2), DAY_BOUNDARY_HOUR),
      };

    case 'weekend': {
      // Find "this weekend" as Fri→Mon, even if we're already inside it.
      const wd = nycWeekday(now);
      // Days from today to the Friday of this weekend.
      //   Mon(1)..Thu(4) → upcoming Fri is (5 - wd) days away
      //   Fri(5) → 0 (today)
      //   Sat(6) → -1 (yesterday)
      //   Sun(0) → -2 (two days ago)
      let daysToFri: number;
      if (wd >= 1 && wd <= 5) daysToFri = 5 - wd;
      else if (wd === 6) daysToFri = -1;
      else daysToFri = -2;

      const friKey = addDays(todayKey, daysToFri);
      const monKey = addDays(friKey, 3);
      const startFriIso = nycToUtcIso(friKey, 18); // 6pm
      return {
        // Clamp to now when we're already past Fri 6pm of this weekend.
        startIso: startFriIso > nowIso ? startFriIso : nowIso,
        endIso: nycToUtcIso(monKey, DAY_BOUNDARY_HOUR),
      };
    }

    case 'week': {
      const wd = nycWeekday(now);
      // Days until next Mon. If today is Mon, want next Mon (7 days),
      // not today. Otherwise: Tue(2)→6, Wed(3)→5, …, Sun(0)→1.
      const daysToMon = wd === 1 ? 7 : (8 - wd) % 7 || 7;
      return {
        startIso: nowIso,
        endIso: nycToUtcIso(addDays(todayKey, daysToMon), DAY_BOUNDARY_HOUR),
      };
    }

    case 'custom': {
      // Guard: custom demands at least `date_from`. parseFilters
      // already demotes a truly empty custom to 'all', but if a
      // caller hands us a bare 'custom' string we can't honor it —
      // fall back to 'all'.
      if (!state || !state.date_from) {
        return { startIso: nowIso, endIso: null };
      }
      const startIso = nycToUtcIso(state.date_from, DAY_BOUNDARY_HOUR);
      // Open-ended "from X onward" when only `date_from` is set.
      const endIso = state.date_to
        ? nycToUtcIso(addDays(state.date_to, 1), DAY_BOUNDARY_HOUR)
        : null;
      return {
        // Clamp: asking for 2026-03-01 → 03-03 on March 2nd should
        // still only show events that haven't already ended.
        startIso: startIso > nowIso ? startIso : nowIso,
        endIso,
      };
    }
  }
}
