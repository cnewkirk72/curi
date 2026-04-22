'use client';

// Midnight + Cyan Glow date picker.
//
// A single component that handles both single-day selection and
// inclusive day ranges, tuned for dark-mode glass surfaces and the
// Curi brand (cyan accent, expo-out easing, rounded-pill day cells).
//
// Why a custom component:
//   The reference screenshots showed the browser-native mm/dd/yyyy
//   input, which is ugly, platform-specific, and impossible to theme.
//   react-day-picker / headlessui each ship 30-60kb and force a
//   styling fight. A 250-line bespoke calendar that owns its own
//   UX is cheaper, smaller, and matches MASTER.md token-for-token.
//
// Design notes:
//   - Uses NYC-local day math throughout. A day is a `YYYY-MM-DD`
//     string (a "dayKey"), matching the one we persist in FilterState
//     and the URL. We intentionally do NOT accept Date objects on
//     the boundary — JS Date + timezones is a well-documented
//     footgun, and keeping the wire format as dayKey strings lets
//     the caller stay timezone-agnostic.
//   - Keyboard nav: arrows to move focus, Enter to select, PageUp/Down
//     to jump months. Focus stays inside the grid. Matches WAI-ARIA
//     date-picker dialog pattern.
//   - prefers-reduced-motion is respected by the `transition-colors`
//     pattern — only color fades, no layout motion.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────

export type DayKey = string; // `YYYY-MM-DD`

export type DatePickerMode = 'single' | 'range';

/**
 * Single-mode value. `null` means "no date picked".
 */
export type SingleValue = DayKey | null;

/**
 * Range-mode value. Either end can be null while the user is mid-pick —
 * a `from` without `to` means "picked a start, waiting on end".
 */
export type RangeValue = { from: DayKey | null; to: DayKey | null };

type CommonProps = {
  /** Minimum selectable day (dayKey, inclusive). */
  minDate?: DayKey;
  /** Maximum selectable day (dayKey, inclusive). */
  maxDate?: DayKey;
  /** `YYYY-MM-DD` to highlight as "today" (usually the NYC day). */
  todayDayKey: DayKey;
  /** Optional: which month to open on first render. Defaults to
   *  the current selection, or today. */
  initialMonth?: { year: number; month0: number };
  className?: string;
  /** ARIA label for the grid — defaults to "Pick a date". */
  ariaLabel?: string;
};

type SingleProps = CommonProps & {
  mode: 'single';
  value: SingleValue;
  onChange: (v: SingleValue) => void;
};

type RangeProps = CommonProps & {
  mode: 'range';
  value: RangeValue;
  onChange: (v: RangeValue) => void;
};

export type DatePickerProps = SingleProps | RangeProps;

// ── dayKey helpers ──────────────────────────────────────────
// All dayKey math is pure-UTC. We never convert to a Date-with-local-
// timezone, because that's where DST bugs live.

function padMonth(n: number) {
  return String(n).padStart(2, '0');
}

function makeDayKey(y: number, m0: number, d: number): DayKey {
  return `${y}-${padMonth(m0 + 1)}-${padMonth(d)}`;
}

function parseDayKey(key: DayKey): { y: number; m0: number; d: number } {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return { y, m0: m - 1, d };
}

function daysInMonth(year: number, month0: number): number {
  // Day 0 of the next month → last day of current month.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Weekday of the 1st of the given month, 0=Sun…6=Sat. */
function firstWeekday(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0, 1)).getUTCDay();
}

function addMonths(year: number, month0: number, delta: number) {
  const d = new Date(Date.UTC(year, month0 + delta, 1));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
}

function addDaysToKey(key: DayKey, delta: number): DayKey {
  const { y, m0, d } = parseDayKey(key);
  const next = new Date(Date.UTC(y, m0, d + delta));
  return makeDayKey(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
}

function compareKey(a: DayKey, b: DayKey): number {
  // ISO dayKeys sort lexically → chronologically.
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Component ────────────────────────────────────────────────

export function DatePicker(props: DatePickerProps) {
  const { mode, minDate, maxDate, todayDayKey, initialMonth, className, ariaLabel } = props;

  // ── Pick the initial visible month ────────────────────────
  // Priority: explicit `initialMonth` prop → current selection →
  // today. Using the selection keeps the picker "sticky" — if a
  // user last picked April 25 and re-opens, they land on April.
  const initial = useMemo(() => {
    if (initialMonth) return initialMonth;
    let anchor: DayKey | null = null;
    if (mode === 'single') anchor = props.value ?? null;
    else anchor = props.value.from ?? props.value.to ?? null;
    const key = anchor ?? todayDayKey;
    const { y, m0 } = parseDayKey(key);
    return { year: y, month0: m0 };
  }, [initialMonth, mode, props, todayDayKey]);

  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth0, setViewMonth0] = useState(initial.month0);
  const [focusedKey, setFocusedKey] = useState<DayKey | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // ── Derived: all day cells for the 6-row grid ──────────────
  // We always render 6 rows (42 cells) regardless of month length
  // — matches iOS/Material convention and stops the grid from
  // reflowing vertically as you page between months.
  const cells = useMemo(() => {
    const firstW = firstWeekday(viewYear, viewMonth0);
    const daysThis = daysInMonth(viewYear, viewMonth0);
    const prev = addMonths(viewYear, viewMonth0, -1);
    const daysPrev = daysInMonth(prev.year, prev.month0);

    const out: { key: DayKey; inMonth: boolean; day: number }[] = [];
    // Leading days (from previous month)
    for (let i = firstW - 1; i >= 0; i--) {
      const d = daysPrev - i;
      out.push({ key: makeDayKey(prev.year, prev.month0, d), inMonth: false, day: d });
    }
    // Current month
    for (let d = 1; d <= daysThis; d++) {
      out.push({ key: makeDayKey(viewYear, viewMonth0, d), inMonth: true, day: d });
    }
    // Trailing days until we hit 42
    const next = addMonths(viewYear, viewMonth0, 1);
    let dNext = 1;
    while (out.length < 42) {
      out.push({ key: makeDayKey(next.year, next.month0, dNext), inMonth: false, day: dNext });
      dNext++;
    }
    return out;
  }, [viewYear, viewMonth0]);

  // ── Range hover preview ────────────────────────────────
  // When the user has picked a `from` but not a `to`, we preview
  // the range as they hover. This matches Airbnb/Linear's date
  // pickers and helps users see the range before committing.
  const [hoverKey, setHoverKey] = useState<DayKey | null>(null);

  // ── Selection predicates ───────────────────────────────
  const isDisabled = (key: DayKey) => {
    if (minDate && compareKey(key, minDate) < 0) return true;
    if (maxDate && compareKey(key, maxDate) > 0) return true;
    return false;
  };

  const isSelected = (key: DayKey): 'none' | 'single' | 'start' | 'end' | 'both' => {
    if (mode === 'single') {
      return props.value === key ? 'single' : 'none';
    }
    const { from, to } = props.value;
    const isFrom = from === key;
    const isTo = to === key;
    if (isFrom && isTo) return 'both';
    if (isFrom) return 'start';
    if (isTo) return 'end';
    return 'none';
  };

  const isInRange = (key: DayKey): boolean => {
    if (mode !== 'range') return false;
    const { from, to } = props.value;
    // Committed range.
    if (from && to && compareKey(key, from) > 0 && compareKey(key, to) < 0) {
      return true;
    }
    // Hover preview range (from committed, hovering an end).
    if (from && !to && hoverKey) {
      const lo = compareKey(hoverKey, from) < 0 ? hoverKey : from;
      const hi = compareKey(hoverKey, from) < 0 ? from : hoverKey;
      return compareKey(key, lo) > 0 && compareKey(key, hi) < 0;
    }
    return false;
  };

  // ── Click handler ─────────────────────────────────────
  function onCellClick(key: DayKey) {
    if (isDisabled(key)) return;
    if (mode === 'single') {
      props.onChange(key);
      return;
    }
    // Range: first click sets `from`, clears `to`. Second click
    // sets `to` (swapping if necessary so from ≤ to). Third click
    // resets to a new `from` — common pattern across Airbnb, Notion,
    // Linear.
    const { from, to } = props.value;
    if (!from || (from && to)) {
      props.onChange({ from: key, to: null });
      return;
    }
    // from is set, to is null → this click commits the end.
    if (compareKey(key, from) < 0) {
      props.onChange({ from: key, to: from });
    } else {
      props.onChange({ from, to: key });
    }
  }

  // ── Keyboard navigation ───────────────────────────────
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const handle = (e: KeyboardEvent) => {
      if (!focusedKey) return;
      let next: DayKey | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          next = addDaysToKey(focusedKey, -1);
          break;
        case 'ArrowRight':
          next = addDaysToKey(focusedKey, 1);
          break;
        case 'ArrowUp':
          next = addDaysToKey(focusedKey, -7);
          break;
        case 'ArrowDown':
          next = addDaysToKey(focusedKey, 7);
          break;
        case 'PageUp':
          next = (() => {
            const { y, m0, d } = parseDayKey(focusedKey);
            const prev = addMonths(y, m0, -1);
            const cap = Math.min(d, daysInMonth(prev.year, prev.month0));
            return makeDayKey(prev.year, prev.month0, cap);
          })();
          break;
        case 'PageDown':
          next = (() => {
            const { y, m0, d } = parseDayKey(focusedKey);
            const nx = addMonths(y, m0, 1);
            const cap = Math.min(d, daysInMonth(nx.year, nx.month0));
            return makeDayKey(nx.year, nx.month0, cap);
          })();
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          onCellClick(focusedKey);
          return;
        default:
          return;
      }
      if (next) {
        e.preventDefault();
        setFocusedKey(next);
        // Page the view if the focused key fell out of it.
        const { y, m0 } = parseDayKey(next);
        if (y !== viewYear || m0 !== viewMonth0) {
          setViewYear(y);
          setViewMonth0(m0);
        }
      }
    };
    grid.addEventListener('keydown', handle);
    return () => grid.removeEventListener('keydown', handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedKey, viewYear, viewMonth0, mode, props]);

  // Focus the cell matching focusedKey — uses data-daykey as the
  // selector so we don't need a ref per cell.
  useEffect(() => {
    if (!focusedKey) return;
    const grid = gridRef.current;
    if (!grid) return;
    const el = grid.querySelector<HTMLButtonElement>(`[data-daykey="${focusedKey}"]`);
    el?.focus();
  }, [focusedKey]);

  // ── Month label ────────────────────────────────────────
  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'long',
        year: 'numeric',
      }).format(new Date(Date.UTC(viewYear, viewMonth0, 1))),
    [viewYear, viewMonth0],
  );

  function prevMonth() {
    const p = addMonths(viewYear, viewMonth0, -1);
    setViewYear(p.year);
    setViewMonth0(p.month0);
  }
  function nextMonth() {
    const n = addMonths(viewYear, viewMonth0, 1);
    setViewYear(n.year);
    setViewMonth0(n.month0);
  }

  return (
    <div
      className={cn(
        'curi-glass rounded-2xl p-4 shadow-card',
        'w-full max-w-[320px]',
        className,
      )}
    >
      {/* ── Header: month label + nav chevrons ─────────── */}
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={prevMonth}
          aria-label="Previous month"
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-pill text-fg-muted',
            'transition duration-micro ease-expo hover:bg-bg-elevated-hover hover:text-fg-primary active:scale-[0.96]',
          )}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="font-display text-sm font-semibold tracking-display text-fg-primary">
          {monthLabel}
        </div>
        <button
          type="button"
          onClick={nextMonth}
          aria-label="Next month"
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-pill text-fg-muted',
            'transition duration-micro ease-expo hover:bg-bg-elevated-hover hover:text-fg-primary active:scale-[0.96]',
          )}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* ── Weekday row ──────────────────────────────────── */}
      <div
        className="mb-1 grid grid-cols-7 text-center"
        aria-hidden
      >
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
          <span
            key={i}
            className="py-1 font-display text-[10px] font-medium uppercase tracking-widest text-fg-dim"
          >
            {w}
          </span>
        ))}
      </div>

      {/* ── Day grid ──────────────────────────────────────── */}
      <div
        ref={gridRef}
        role="grid"
        aria-label={ariaLabel ?? 'Pick a date'}
        className="grid grid-cols-7 gap-y-0.5"
      >
        {cells.map(({ key, inMonth, day }) => {
          const sel = isSelected(key);
          const between = isInRange(key);
          const disabled = isDisabled(key);
          const isToday = key === todayDayKey;
          const selected = sel !== 'none';
          const isRangeEdge = sel === 'start' || sel === 'end' || sel === 'both';

          // Tabindex: only the current month's today (or the first
          // in-month day on months without today) is tab-focusable.
          // That makes Tab land a sensible place; arrow keys then
          // take over.
          const isTabStop =
            (focusedKey
              ? focusedKey === key
              : isToday && inMonth) ||
            (!focusedKey && !cells.some((c) => c.key === todayDayKey) && inMonth && day === 1);

          return (
            <div
              key={key}
              role="gridcell"
              className={cn(
                // Range-between cells stretch edge-to-edge so the
                // cyan wash reads as a continuous band.
                'relative flex items-center justify-center',
                between && !selected && 'bg-accent/12',
                // Round off the ends of a range visually:
                (between || isRangeEdge) && 'first:rounded-l-pill',
                sel === 'start' && 'bg-accent/12 rounded-l-pill',
                sel === 'end' && 'bg-accent/12 rounded-r-pill',
              )}
            >
              <button
                type="button"
                disabled={disabled}
                tabIndex={isTabStop ? 0 : -1}
                data-daykey={key}
                aria-pressed={selected}
                aria-label={labelForCell(key, inMonth)}
                aria-disabled={disabled || undefined}
                onClick={() => onCellClick(key)}
                onMouseEnter={() => mode === 'range' && setHoverKey(key)}
                onMouseLeave={() => mode === 'range' && setHoverKey(null)}
                onFocus={() => setFocusedKey(key)}
                className={cn(
                  'relative z-10 inline-flex h-9 w-9 items-center justify-center rounded-pill',
                  'font-display text-xs font-medium tabular',
                  'transition-colors duration-micro ease-expo',
                  // Base state
                  !selected && !disabled && inMonth && 'text-fg-primary hover:bg-bg-elevated-hover',
                  !selected && !disabled && !inMonth && 'text-fg-dim hover:bg-bg-elevated-hover',
                  // Today ring (only when not selected)
                  isToday && !selected && 'ring-1 ring-accent/60',
                  // Selected (single or range edge)
                  selected && 'bg-accent text-bg-deep font-semibold shadow-glow-sm',
                  // Disabled
                  disabled && 'text-fg-dim/50 cursor-not-allowed',
                )}
              >
                {day}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Aria label helper ────────────────────────────────────

function labelForCell(key: DayKey, inMonth: boolean): string {
  const { y, m0, d } = parseDayKey(key);
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m0, d)));
  return inMonth ? formatted : `${formatted} (outside current month)`;
}

// ── Helpers for consumers ─────────────────────────────────

/**
 * Convenience: produce the NYC-local dayKey for "today", so callers
 * don't have to reimplement the timezone dance just to seed the
 * picker's `todayDayKey` prop.
 */
export function nycTodayDayKey(now: Date = new Date()): DayKey {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}
