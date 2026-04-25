'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────

export type DayKey = string; // `YYYY-MM-DD`

export type DatePickerMode = 'single' | 'range';

export type SingleValue = DayKey | null;

export type RangeValue = { from: DayKey | null; to: DayKey | null };

type CommonProps = {
  minDate?: DayKey;
  maxDate?: DayKey;
  todayDayKey: DayKey;
  initialMonth?: { year: number; month0: number };
  className?: string;
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

function padTwo(n: number) {
  return String(n).padStart(2, '0');
}

function makeDayKey(y: number, m0: number, d: number): DayKey {
  return `${y}-${padTwo(m0 + 1)}-${padTwo(d)}`;
}

function parseDayKey(key: DayKey): { y: number; m0: number; d: number } {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return { y, m0: m - 1, d };
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function firstWeekday(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0, 1)).getUTCDay();
}

function addMonths(year: number, month0: number, delta: number) {
  const d = new Date(Date.UTC(year, month0 + delta, 1));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
}

function compareKey(a: DayKey, b: DayKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function monthLabel(year: number, month0: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month0, 1)));
}

function cellsForMonth(year: number, month0: number) {
  const firstW = firstWeekday(year, month0);
  const daysThis = daysInMonth(year, month0);
  const prev = addMonths(year, month0, -1);
  const daysPrev = daysInMonth(prev.year, prev.month0);
  const next = addMonths(year, month0, 1);

  const out: { key: DayKey; inMonth: boolean; day: number }[] = [];

  for (let i = firstW - 1; i >= 0; i--) {
    const d = daysPrev - i;
    out.push({ key: makeDayKey(prev.year, prev.month0, d), inMonth: false, day: d });
  }
  for (let d = 1; d <= daysThis; d++) {
    out.push({ key: makeDayKey(year, month0, d), inMonth: true, day: d });
  }
  let dNext = 1;
  while (out.length < 42) {
    out.push({ key: makeDayKey(next.year, next.month0, dNext), inMonth: false, day: dNext });
    dNext++;
  }
  return out;
}

// ── Component ────────────────────────────────────────────────

export function DatePicker(props: DatePickerProps) {
  const { mode, minDate, maxDate, todayDayKey, className, ariaLabel } = props;
  const { y: todayY, m0: todayM0 } = parseDayKey(todayDayKey);

  // Fixed window: current month through current month + 12
  const months: { year: number; month0: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    months.push(addMonths(todayY, todayM0, i));
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const todayMonthRef = useRef<HTMLDivElement>(null);

  const [hoverKey, setHoverKey] = useState<DayKey | null>(null);

  // Scroll to today's month on mount
  useEffect(() => {
    const container = scrollRef.current;
    const todayEl = todayMonthRef.current;
    if (!container || !todayEl) return;
    container.scrollTop = todayEl.offsetTop - container.offsetTop;
  }, []);

  // ── Selection helpers ──────────────────────────────────────

  const isDisabled = (key: DayKey) => {
    if (minDate && compareKey(key, minDate) < 0) return true;
    if (maxDate && compareKey(key, maxDate) > 0) return true;
    return false;
  };

  const isSelected = (key: DayKey): 'none' | 'single' | 'start' | 'end' | 'both' => {
    if (mode === 'single') return props.value === key ? 'single' : 'none';
    const { from, to } = props.value;
    if (from === key && to === key) return 'both';
    if (from === key) return 'start';
    if (to === key) return 'end';
    return 'none';
  };

  const isInRange = (key: DayKey): boolean => {
    if (mode !== 'range') return false;
    const { from, to } = props.value;
    if (from && to && compareKey(key, from) > 0 && compareKey(key, to) < 0) return true;
    if (from && !to && hoverKey) {
      const lo = compareKey(hoverKey, from) < 0 ? hoverKey : from;
      const hi = compareKey(hoverKey, from) < 0 ? from : hoverKey;
      return compareKey(key, lo) > 0 && compareKey(key, hi) < 0;
    }
    return false;
  };

  function onCellClick(key: DayKey) {
    if (isDisabled(key)) return;
    if (mode === 'single') {
      props.onChange(key);
      return;
    }
    const { from, to } = props.value;
    if (!from || (from && to)) {
      props.onChange({ from: key, to: null });
      return;
    }
    if (compareKey(key, from) < 0) {
      props.onChange({ from: key, to: from });
    } else {
      props.onChange({ from, to: key });
    }
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div
      className={cn(
        'curi-glass rounded-2xl shadow-card',
        'w-full max-w-[320px] overflow-hidden',
        className,
      )}
    >
      {/* Sticky weekday header */}
      <div className="sticky top-0 z-10 grid grid-cols-7 border-b border-white/5 bg-bg-deep/80 px-4 py-2 backdrop-blur-sm">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
          <span
            key={i}
            className="text-center font-display text-[10px] font-medium uppercase tracking-widest text-fg-dim"
          >
            {w}
          </span>
        ))}
      </div>

      {/* Scrollable month list */}
      <div
        ref={scrollRef}
        className="max-h-[340px] overflow-y-auto overscroll-contain px-4 pb-4"
        role="grid"
        aria-label={ariaLabel ?? 'Pick a date'}
      >
        {months.map(({ year, month0 }) => {
          const isCurrentMonth = year === todayY && month0 === todayM0;
          const cells = cellsForMonth(year, month0);

          return (
            <div
              key={`${year}-${month0}`}
              ref={isCurrentMonth ? todayMonthRef : undefined}
              className="mb-4"
            >
              {/* Month label */}
              <div className="py-3 font-display text-sm font-semibold tracking-display text-fg-primary">
                {monthLabel(year, month0)}
              </div>

              {/* Day grid */}
              <div className="grid grid-cols-7 gap-y-0.5">
                {cells.map(({ key, inMonth, day }) => {
                  if (!inMonth) {
                    return <div key={key} role="gridcell" aria-hidden />;
                  }

                  const sel = isSelected(key);
                  const between = isInRange(key);
                  const disabled = isDisabled(key);
                  const isToday = key === todayDayKey;
                  const selected = sel !== 'none';
                  const isRangeEdge = sel === 'start' || sel === 'end' || sel === 'both';

                  return (
                    <div
                      key={key}
                      role="gridcell"
                      className={cn(
                        'relative flex items-center justify-center',
                        between && !selected && 'bg-accent/12',
                        (between || isRangeEdge) && 'first:rounded-l-pill',
                        sel === 'start' && 'bg-accent/12 rounded-l-pill',
                        sel === 'end' && 'bg-accent/12 rounded-r-pill',
                      )}
                    >
                      <button
                        type="button"
                        disabled={disabled}
                        data-daykey={key}
                        aria-pressed={selected}
                        aria-label={ariaLabelForCell(key)}
                        aria-disabled={disabled || undefined}
                        onClick={() => onCellClick(key)}
                        onMouseEnter={() => mode === 'range' && setHoverKey(key)}
                        onMouseLeave={() => mode === 'range' && setHoverKey(null)}
                        className={cn(
                          'relative z-10 inline-flex h-9 w-9 items-center justify-center rounded-pill',
                          'font-display text-xs font-medium tabular',
                          'transition-colors duration-micro ease-expo',
                          !selected && !disabled && 'text-fg-primary hover:bg-bg-elevated-hover',
                          isToday && !selected && 'ring-1 ring-accent/60',
                          selected && 'bg-accent text-bg-deep font-semibold shadow-glow-sm',
                          disabled && 'cursor-not-allowed text-fg-dim/50',
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
        })}

      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────

function ariaLabelForCell(key: DayKey): string {
  const { y, m0, d } = parseDayKey(key);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m0, d)));
}

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
