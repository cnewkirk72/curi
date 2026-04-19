// Filter state for the home feed. Source of truth is the URL search
// params — `?when=weekend&genres=techno,house&vibes=warehouse` — so
// filter URLs are shareable ("here's all the techno this weekend")
// and back-button navigation works with no extra glue.
//
// `parseFilters` (server-side & client-side) converts searchParams
// into a FilterState; `serializeFilters` goes the other way. The
// sheet keeps a local draft state and only commits via router.push
// on Apply — that's why we need the round-trip.

import { nycDayKey } from './format';

// ── Types ────────────────────────────────────────────────────────

export type DateFilter = 'all' | 'tonight' | 'tomorrow' | 'weekend' | 'week';

export type FilterState = {
  when: DateFilter;
  genres: string[];
  vibes: string[];
};

export const EMPTY_FILTERS: FilterState = {
  when: 'all',
  genres: [],
  vibes: [],
};

// ── URL ↔ FilterState ────────────────────────────────────────────

// `URLSearchParams` (server page props) and `ReadonlyURLSearchParams`
// (Next's client hook) share `.get()`, which is all we read — so we
// accept both via a structural type and avoid dragging the
// next/navigation type into a server-friendly module.
type ParamsLike = { get: (key: string) => string | null };

function isDateFilter(v: string | null): v is DateFilter {
  return (
    v === 'tonight' || v === 'tomorrow' || v === 'weekend' || v === 'week'
  );
}

export function parseFilters(sp: ParamsLike): FilterState {
  const when = sp.get('when');
  return {
    when: isDateFilter(when) ? when : 'all',
    genres: (sp.get('genres') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    vibes: (sp.get('vibes') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Returns a query string (no leading `?`) — empty string when no
 * filters are active. Callers typically do
 * `router.push(pathname + (qs ? '?' + qs : ''))`.
 */
export function serializeFilters(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.when !== 'all') params.set('when', state.when);
  if (state.genres.length) params.set('genres', state.genres.join(','));
  if (state.vibes.length) params.set('vibes', state.vibes.join(','));
  return params.toString();
}

export function hasActiveFilters(state: FilterState): boolean {
  return (
    state.when !== 'all' || state.genres.length > 0 || state.vibes.length > 0
  );
}

export function activeFilterCount(state: FilterState): number {
  return (
    (state.when !== 'all' ? 1 : 0) + state.genres.length + state.vibes.length
  );
}

// ── Curated option lists ────────────────────────────────────────
//
// Grounded in the tags that actually appear in supabase/seed.sql
// and the 2b ingestion output. A proper "show me the long tail"
// view is a Phase 4 concern — these are the 12 genres and 8 vibes
// that cover the overwhelming majority of NYC electronic nights.
//
// NOTE: `slug` is the value we filter on (matches the `events.genres`
// / `events.vibes` text[] values); `label` is what users see.

export type FilterOption = { slug: string; label: string };

export const GENRE_OPTIONS: FilterOption[] = [
  { slug: 'techno', label: 'Techno' },
  { slug: 'house', label: 'House' },
  { slug: 'deep-house', label: 'Deep House' },
  { slug: 'jungle', label: 'Jungle' },
  { slug: 'dnb', label: 'Drum & Bass' },
  { slug: 'dubstep', label: 'Dubstep' },
  { slug: 'garage', label: 'Garage' },
  { slug: 'breakbeat', label: 'Breakbeat' },
  { slug: 'ambient', label: 'Ambient' },
  { slug: 'downtempo', label: 'Downtempo' },
  { slug: 'disco', label: 'Disco' },
  { slug: 'electro', label: 'Electro' },
];

export const VIBE_OPTIONS: FilterOption[] = [
  { slug: 'warehouse', label: 'Warehouse' },
  { slug: 'daytime', label: 'Daytime' },
  { slug: 'peak-time', label: 'Peak Time' },
  { slug: 'basement', label: 'Basement' },
  { slug: 'underground', label: 'Underground' },
  { slug: 'queer', label: 'Queer' },
  { slug: 'melodic', label: 'Melodic' },
  { slug: 'experimental', label: 'Experimental' },
];

export const DATE_OPTIONS: { slug: DateFilter; label: string }[] = [
  { slug: 'all', label: 'All upcoming' },
  { slug: 'tonight', label: 'Tonight' },
  { slug: 'tomorrow', label: 'Tomorrow' },
  { slug: 'weekend', label: 'This weekend' },
  { slug: 'week', label: 'This week' },
];

export function labelForGenre(slug: string): string {
  return GENRE_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

export function labelForVibe(slug: string): string {
  return VIBE_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

export function labelForWhen(slug: DateFilter): string {
  return DATE_OPTIONS.find((o) => o.slug === slug)?.label ?? slug;
}

// ── Date window math (NYC-aware) ─────────────────────────────────
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
 * Compute the `[start, end)` window for a DateFilter.
 *
 * - `all`:      now → ∞
 * - `tonight`:  now → tomorrow 4am NYC
 * - `tomorrow`: tomorrow 4am NYC → day-after 4am NYC
 * - `weekend`:  Fri 6pm NYC → Mon 4am NYC (clamped to `now` if we're
 *               already inside the window — avoids filtering out
 *               events currently happening on a Saturday)
 * - `week`:     now → next Mon 4am NYC
 */
export function dateWindowFor(
  when: DateFilter,
  now: Date = new Date(),
): DateWindow {
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
  }
}
