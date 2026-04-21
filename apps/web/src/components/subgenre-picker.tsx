'use client';

// Shared dynamic subgenre picker.
//
// Renders an inline row of subgenre chips that appears beneath each
// selected parent genre — the same visual pattern used in the
// filter sheet and onboarding flow. Keeping it in one component is
// deliberate: both surfaces share expectations around animation
// timing, reduced-motion handling, and accessible semantics, and
// drift between them would feel jarring.
//
// The picker is controlled — the parent component owns
// `selectedParents` and `selectedSubgenres` state. This component
// just renders, reveals, and toggles.
//
// Rendering model:
//   For each parent slug in `parents` (order preserved) we render
//   the subgenre row if that parent is in `selectedParents` AND has
//   at least one curated subgenre. Parents without subgenres are
//   silently skipped so the picker is opt-in.
//
// Motion:
//   Enter: height 0 → auto, opacity 0 → 1, translateY(4px) → 0,
//          duration 200ms, expo-out (matches design-system MASTER.md).
//   Exit:  reverse, duration ~140ms.
//   We hand-roll the animation with CSS transitions + a
//   `useReducedMotion` gate rather than pulling in framer-motion —
//   the motion is simple enough that adding ~40KB of JS would be
//   overkill for Phase 5.4.

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { FilterOption } from '@/lib/filters';

type Props = {
  /** Ordered parent slugs. Determines sub-row ordering. */
  parents: readonly string[];
  /** Which parents are toggled on — only those get a sub-row. */
  selectedParents: readonly string[];
  /** Map: parent-slug → its curated subgenre options. Parents
   * missing from the map or mapped to empty arrays are skipped. */
  subgenresByParent: Map<string, FilterOption[]>;
  /** Currently-selected subgenre slugs (flat across parents). */
  selectedSubgenres: readonly string[];
  /** Called when a subgenre chip is toggled. The parent component
   * owns the array — we don't maintain internal state. */
  onToggle: (subgenreSlug: string) => void;
  /** Optional override — when omitted, the picker renders one row
   * per selected parent. Rare to override; exposed for onboarding's
   * layout variants. */
  className?: string;
};

export function SubgenrePicker({
  parents,
  selectedParents,
  subgenresByParent,
  selectedSubgenres,
  onToggle,
  className,
}: Props) {
  // Compute the list of (parent, subgenres) pairs to render, in
  // parent-list order. Only include selected parents that actually
  // have subgenres — an empty list means the picker renders nothing.
  const rows = useMemo(() => {
    const selectedSet = new Set(selectedParents);
    return parents
      .filter((p) => selectedSet.has(p))
      .map((p) => ({ parent: p, options: subgenresByParent.get(p) ?? [] }))
      .filter((row) => row.options.length > 0);
  }, [parents, selectedParents, subgenresByParent]);

  if (rows.length === 0) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {rows.map(({ parent, options }) => (
        <SubgenreRow
          key={parent}
          parent={parent}
          options={options}
          selectedSubgenres={selectedSubgenres}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

// ── SubgenreRow ────────────────────────────────────────────────────
//
// One parent's worth of subgenres. Animates in on mount with a
// height + opacity transition. We measure the scrollHeight off the
// content element and set an inline max-height during the enter
// transition to animate from 0 → auto without the usual CSS
// "height:auto doesn't animate" pitfall.

function SubgenreRow({
  parent,
  options,
  selectedSubgenres,
  onToggle,
}: {
  parent: string;
  options: FilterOption[];
  selectedSubgenres: readonly string[];
  onToggle: (slug: string) => void;
}) {
  const prefersReduced = usePrefersReducedMotion();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Next-frame toggle so the initial render is at max-height: 0,
    // and the transition sees a state change to animate through.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Resolve to the actual content height for the enter animation.
  // We measure once on mount — the options list is static per row
  // and we don't want a resize observer just for this.
  const targetHeight =
    contentRef.current?.scrollHeight ?? /* safe upper bound */ 200;

  return (
    <div
      role="group"
      aria-label={`${parent} subgenres`}
      style={{
        maxHeight: prefersReduced ? undefined : mounted ? targetHeight : 0,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(4px)',
        transition: prefersReduced
          ? 'none'
          : [
              'max-height 200ms cubic-bezier(0.16, 1, 0.3, 1)',
              'opacity 200ms cubic-bezier(0.16, 1, 0.3, 1)',
              'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            ].join(', '),
      }}
      className="basis-full overflow-hidden"
    >
      <div
        ref={contentRef}
        className="ml-1 flex flex-wrap gap-1.5 border-l-2 border-accent/30 pb-1 pl-3 pt-1"
      >
        {options.map((opt) => {
          const active = selectedSubgenres.includes(opt.slug);
          return (
            <button
              key={`${parent}:${opt.slug}`}
              type="button"
              onClick={() => onToggle(opt.slug)}
              aria-pressed={active}
              className={cn(
                'inline-flex items-center rounded-pill border px-3 py-1 text-[11px] font-medium',
                'transition duration-micro ease-expo active:scale-[0.96]',
                active
                  ? 'border-accent/40 bg-accent-chip text-accent'
                  : 'border-border/60 bg-bg-elevated/60 text-fg-muted hover:border-border-strong hover:text-fg-primary',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── useReducedMotion ──────────────────────────────────────────────
//
// Reads `prefers-reduced-motion: reduce` once on mount and listens
// for live changes. When true, the picker skips the height/opacity
// transition so everything just appears — matches the design-system
// rule "respect prefers-reduced-motion" (MASTER.md, Ambient blobs
// section).

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handle = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handle);
    return () => mq.removeEventListener('change', handle);
  }, []);

  return reduced;
}
