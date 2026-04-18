// Convert NYC wallclock datetimes into ISO-8601 strings with proper offset.
// Handles DST correctly (America/New_York switches between EST/EDT).

/**
 * Given a wallclock time in America/New_York, return the ISO string.
 * Example: nycWallclockToIso(2026, 4, 18, 18, 0) → "2026-04-18T22:00:00.000Z" (EDT)
 * Example: nycWallclockToIso(2026, 1, 15, 18, 0) → "2026-01-15T23:00:00.000Z" (EST)
 */
export function nycWallclockToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(guess));

  const bag: Record<string, string> = {};
  for (const p of parts) bag[p.type] = p.value;

  // Intl occasionally returns "24" for midnight — normalize to 0.
  const hh = bag.hour === '24' ? '0' : bag.hour;
  const nyAsUtc = Date.UTC(
    Number(bag.year),
    Number(bag.month) - 1,
    Number(bag.day),
    Number(hh),
    Number(bag.minute),
  );
  const offset = nyAsUtc - guess;
  return new Date(guess - offset).toISOString();
}

/**
 * Given a month/day in the future (MM.DD format from Public Records' calendar),
 * figure out which year it belongs to. Rule: pick whichever of {current year,
 * next year} produces a date that is today or later, in NYC local time.
 *
 * If both are in the past (unlikely — calendar shows upcoming only), return
 * the current year as a last resort.
 */
export function inferYear(
  monthIdx: number,
  day: number,
  now: Date = new Date(),
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const bag: Record<string, string> = {};
  for (const p of parts) bag[p.type] = p.value;
  const todayYear = Number(bag.year);
  const todayMonth = Number(bag.month);
  const todayDay = Number(bag.day);

  const monthMD = monthIdx * 100 + day;
  const todayMD = todayMonth * 100 + todayDay;
  return monthMD >= todayMD ? todayYear : todayYear + 1;
}
