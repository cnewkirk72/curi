'use client';

// Phase 6.3 v2 — extracted from filter-bar.tsx so the same chip can be
// reused for the new artist/venue active-search chips. The original
// chip was hard-coded cyan; this version takes a `tone` prop that
// pairs with the existing chip color tokens (`bg-{cyan,violet,amber,
// pale}-chip` + matching border + text colors).
//
// Tone semantics for the active-filter row:
//   cyan    — generic filter facets (when, genres, vibes, settings,
//             subgenres). Same look as before — keeps the existing
//             feed visually identical.
//   violet  — artist filter chip. Picked because the lineup color
//             system already leans violet for artist surfaces (see
//             chip.tsx GENRE_TONE_MAP / lineup-list.tsx).
//   amber   — venue filter chip. Pairs with the disco/warm tone
//             reserved for venue-level surfaces in the design system.
//   pale    — reserved for the "search query" chip if we ever add one;
//             currently unused here but kept in the union for parity
//             with the broader Chip tone palette.

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ActiveChipTone = 'cyan' | 'violet' | 'amber' | 'pale';

// Tailwind doesn't see dynamically built class strings, so each tone's
// classes are spelled out statically. The remove button's hover ramp
// uses the same tone family so the chip reads as one unit rather than
// a label + a glued-on button.
const TONE_CONTAINER: Record<ActiveChipTone, string> = {
  cyan: 'border-accent/30 bg-accent-chip text-accent',
  violet: 'border-violet/30 bg-violet-chip text-violet',
  amber: 'border-amber/30 bg-amber-chip text-amber',
  pale: 'border-pale/30 bg-pale-chip text-pale',
};

const TONE_REMOVE_HOVER: Record<ActiveChipTone, string> = {
  cyan: 'hover:bg-accent/10',
  violet: 'hover:bg-violet/10',
  amber: 'hover:bg-amber/10',
  pale: 'hover:bg-pale/10',
};

export function ActiveChip({
  children,
  onRemove,
  tone = 'cyan',
  ariaLabel,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  tone?: ActiveChipTone;
  /**
   * Override for the remove button's aria-label. Falls back to
   * `Remove ${children}` when children is a plain string. Pass this
   * explicitly when children is a ReactNode (e.g. an icon + text)
   * so screen readers get a clean label.
   */
  ariaLabel?: string;
}) {
  const fallbackLabel =
    typeof children === 'string' ? `Remove ${children}` : 'Remove filter';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border py-1 pl-3 pr-1.5 text-xs font-medium',
        TONE_CONTAINER[tone],
      )}
    >
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={ariaLabel ?? fallbackLabel}
        className={cn(
          'inline-flex h-4 w-4 items-center justify-center rounded-pill transition-colors duration-micro',
          TONE_REMOVE_HOVER[tone],
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
