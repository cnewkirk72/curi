// Date/time + price formatting helpers, NYC-locked.
//
// Events are stored in Postgres as UTC timestamptz. Every user-facing
// time on Curi is in NYC (America/New_York) — hardcoded rather than
// derived from the browser locale so a user in LA sees the same label
// as a user in NYC when chatting about the same event.

const NYC_TZ = 'America/New_York';

/**
 * Convert an ISO timestamp to a { year, month, day } tuple in NYC.
 * Using `Intl.DateTimeFormat` rather than math-on-UTC because DST
 * transitions matter (a midnight-local event one second before a DST
 * jump would land on the wrong day with naive arithmetic).
 */
function nycDateParts(iso: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NYC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);

  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Stable `YYYY-MM-DD` key for grouping events by NYC calendar day. */
export function nycDayKey(iso: string): string {
  const { year, month, day } = nycDateParts(iso);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Human-friendly label for a date group header.
 *  - "Tonight"             → today
 *  - "Tomorrow"            → tomorrow
 *  - "Friday"              → within the next 6 days
 *  - "Sat · May 3"         → further out
 */
export function groupLabel(dayKey: string, now: Date = new Date()): string {
  const today = nycDayKey(now.toISOString());
  const tomorrow = nycDayKey(new Date(now.getTime() + 86_400_000).toISOString());

  if (dayKey === today) return 'Tonight';
  if (dayKey === tomorrow) return 'Tomorrow';

  // Number of days between today and dayKey (positive for future).
  // destructure with `as [number, number, number]` so strict-mode doesn't
  // widen the components to `number | undefined` — the dayKey is always
  // produced by `nycDayKey`, so the shape is guaranteed.
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1, d));
  const todayUtc = (() => {
    const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(ty, tm - 1, td));
  })();
  const daysAway = Math.round((target.getTime() - todayUtc.getTime()) / 86_400_000);

  if (daysAway >= 2 && daysAway <= 6) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: NYC_TZ,
      weekday: 'long',
    }).format(new Date(`${dayKey}T12:00:00Z`));
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: NYC_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

/**
 * Compact time label: "11 PM", "10:30 PM", "Midnight".
 * "11:00 PM" → "11 PM" to save horizontal space in cramped cards.
 */
export function timeLabel(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NYC_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));

  // "11:00 PM" → "11 PM", but "10:30 PM" stays intact.
  return fmt.replace(/^(\d{1,2}):00 /, '$1 ');
}

/**
 * Price formatting — events can have either or both of price_min/max.
 * Returns null when neither is set, which the caller should use to show
 * "TBA" or hide the price slot entirely.
 */
export function formatPrice(
  min: number | null | undefined,
  max: number | null | undefined,
): string | null {
  if (min == null && max == null) return null;
  if (min === 0 && (max == null || max === 0)) return 'Free';
  if (min != null && max != null && min !== max) return `$${min}–${max}`;
  const single = min ?? max!;
  return single === 0 ? 'Free' : `$${single}`;
}
