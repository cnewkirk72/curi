'use client';

// Filter entry point on the home feed.
//
// Anatomy:
//   "Filter" pill button         — opens the sheet; cyan count badge
//                                  when any filters are active
//   Active-filter chips          — quick visual summary of what's on;
//                                  tapping any chip removes it
//                                  (1-tap reset by facet)
//     Generic facets (cyan)      — when, genres, subgenres, vibes,
//                                  settings.
//     Artist (violet, Phase 6.3) — set via the search dropdown's
//                                  "Show events with [X]" entity
//                                  button. Slug → display name is
//                                  resolved server-side and threaded
//                                  in via `artistLabel`.
//     Venue (amber, Phase 6.3)   — same pattern as artist.
//   "Clear" text button          — removes all filters in one tap
//
// The bar reads its state from `useSearchParams` on every render, so
// it stays in sync when the sheet commits new filters via router.push
// (Next auto-rerenders client components that read searchParams).

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  activeFilterCount,
  hasActiveFilters,
  labelForDateRange,
  labelForGenre,
  labelForSetting,
  labelForSubgenre,
  labelForVibe,
  labelForWhen,
  parseFilters,
  serializeFilters,
  subgenresForParent,
  type FilterState,
} from '@/lib/filters';
import { FilterSheet } from '@/components/filter-sheet';
import { ActiveChip } from '@/components/active-chip';

export function FilterBar({
  userPrefs,
  artistLabel,
  venueLabel,
}: {
  /** Phase 3.18 — onboarding-time prefs threaded through to the
   *  FilterSheet so the genre/vibe rows render in pref-aware order
   *  on mobile. Pass undefined for anon viewers. */
  userPrefs?: { genres: string[]; vibes: string[] };
  /** Phase 6.3 — resolved display name for `?artist=<slug>`. The URL
   *  has only the slug, but the chip needs the human-readable name
   *  ("Courtesy" not "courtesy"). Resolved server-side via
   *  `getActiveSearchLabels` and passed in. NULL when the URL has no
   *  artist filter or the slug is unresolvable (the feed already
   *  short-circuits to empty in that case). */
  artistLabel?: string | null;
  /** Phase 6.3 — same as artistLabel but for venues. */
  venueLabel?: string | null;
} = {}) {
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
    // Also nuke any custom range — removing the "when" chip is the
    // canonical "no time filter" action.
    commit({ ...filters, when: 'all', date_from: null, date_to: null });
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
  function removeSetting(slug: string) {
    commit({ ...filters, setting: filters.setting.filter((s) => s !== slug) });
  }
  function removeSubgenre(slug: string) {
    commit({ ...filters, subgenres: filters.subgenres.filter((s) => s !== slug) });
  }
  function removeArtist() {
    commit({ ...filters, artist: null });
  }
  function removeVenue() {
    commit({ ...filters, venue: null });
  }
  function clearAll() {
    commit({
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
    });
  }

  return (
    // Mobile-only: desktop sidebar takes over the filter UX at lg+,
    // so the inline chip row would just be redundant noise.
    <div className="-mx-5 overflow-x-auto px-5 lg:hidden">
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

        {/* Active-filter chips. Visual order:
              artist → venue → when → genres → subgenres → vibes → setting
            Search-driven chips (artist / venue) render first because
            they describe the strongest scope narrowing — the user
            tapped "events with X" and that intent dominates the row. */}
        {filters.artist && artistLabel && (
          <ActiveChip tone="violet" onRemove={removeArtist}>
            {artistLabel}
          </ActiveChip>
        )}
        {filters.venue && venueLabel && (
          <ActiveChip tone="amber" onRemove={removeVenue}>
            {venueLabel}
          </ActiveChip>
        )}
        {filters.when !== 'all' && (
          <ActiveChip onRemove={clearWhen}>
            {/* Custom range renders the formatted "Apr 25 – Apr 27"
                label so the chip is self-describing; presets fall
                back to labelForWhen ("Tonight", etc.). */}
            {labelForDateRange(filters) ?? labelForWhen(filters.when)}
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
        {filters.setting.map((slug) => (
          <ActiveChip key={`set-${slug}`} onRemove={() => removeSetting(slug)}>
            {labelForSetting(slug)}
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
        userPrefs={userPrefs}
      />
    </div>
  );
}
