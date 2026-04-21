'use client';

// Filter entry point on the home feed.
//
// Anatomy:
//   "Filter" pill button  — opens the sheet; shows a cyan count badge
//                           when filters are active
//   Active-filter chips   — quick visual summary of what's on; tapping
//                           any chip removes it (1-tap reset by facet)
//   "Clear" text button   — removes all filters in one tap
//
// The bar reads its state from `useSearchParams` on every render, so
// it stays in sync when the sheet commits new filters via router.push
// (Next auto-rerenders client components that read searchParams).

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  activeFilterCount,
  hasActiveFilters,
  labelForGenre,
  labelForSubgenre,
  labelForVibe,
  labelForWhen,
  parseFilters,
  serializeFilters,
  subgenresForParent,
  type FilterState,
} from '@/lib/filters';
import { FilterSheet } from '@/components/filter-sheet';

export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const filters = parseFilters(searchParams);
  const count = activeFilterCount(filters);
  const active = hasActiveFilters(filters);

  function commit(next: FilterState) {
    const qs = serializeFilters(next);
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function clearWhen() {
    commit({ ...filters, when: 'all' });
  }
  function removeGenre(slug: string) {
    // Mirror the filter-sheet's cascade: removing a parent also
    // clears any of its subgenres. Without this, the URL would
    // end up with orphaned subgenres whose parent disappeared.
    const childSlugs = new Set(subgenresForParent(slug).map((o) => o.slug));
    commit({
      ...filters,
      genres: filters.genres.filter((g) => g !== slug),
      subgenres: filters.subgenres.filter((s) => !childSlugs.has(s)),
    });
  }
  function removeVibe(slug: string) {
    commit({ ...filters, vibes: filters.vibes.filter((v) => v !== slug) });
  }
  function removeSubgenre(slug: string) {
    commit({ ...filters, subgenres: filters.subgenres.filter((s) => s !== slug) });
  }
  function clearAll() {
    commit({ when: 'all', genres: [], vibes: [], subgenres: [] });
  }

  return (
    <div className="-mx-5 overflow-x-auto px-5">
      {/* no-wrap horizontal row — chips overflow into a scroll region
          rather than wrapping, so the card list below stays vertically
          stable regardless of how many filters are on. */}
      <div className="flex items-center gap-2 whitespace-nowrap">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open filters"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-medium',
            'transition duration-micro ease-expo active:scale-[0.96]',
            active
              ? 'border-accent/40 bg-accent-chip text-accent shadow-glow-sm'
              : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filter
          {count > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-accent px-1 text-[10px] font-semibold text-bg-deep tabular">
              {count}
            </span>
          )}
        </button>

        {/* Active-filter chips. Order: when → genres → subgenres → vibes.
            Subgenres follow their parent genre in visual order to
            keep the chip row readable. */}
        {filters.when !== 'all' && (
          <ActiveChip onRemove={clearWhen}>
            {labelForWhen(filters.when)}
          </ActiveChip>
        )}
        {filters.genres.map((slug) => (
          <ActiveChip key={`g-${slug}`} onRemove={() => removeGenre(slug)}>
            {labelForGenre(slug)}
          </ActiveChip>
        ))}
        {filters.subgenres.map((slug) => (
          <ActiveChip key={`s-${slug}`} onRemove={() => removeSubgenre(slug)}>
            {labelForSubgenre(slug)}
          </ActiveChip>
        ))}
        {filters.vibes.map((slug) => (
          <ActiveChip key={`v-${slug}`} onRemove={() => removeVibe(slug)}>
            {labelForVibe(slug)}
          </ActiveChip>
        ))}

        {active && (
          <button
            type="button"
            onClick={clearAll}
            className="shrink-0 text-xs font-medium text-fg-muted transition hover:text-fg-primary"
          >
            Clear
          </button>
        )}
      </div>

      <FilterSheet
        open={open}
        onClose={() => setOpen(false)}
        initialFilters={filters}
      />
    </div>
  );
}

function ActiveChip({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-accent/30 bg-accent-chip py-1 pl-3 pr-1.5 text-xs font-medium text-accent">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${String(children)}`}
        className="inline-flex h-4 w-4 items-center justify-center rounded-pill hover:bg-accent/10"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
