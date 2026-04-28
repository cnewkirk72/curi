'use client';

// Phase 6.3 v2 — desktop placement for the artist/venue search chips.
//
// At lg+ the regular filter UX lives in the left sidebar — but the
// sidebar has no "active filters" row, since each filter facet is
// represented by its own toggle that's already highlighted when on.
// Search-driven filters (artist / venue) don't have a sidebar toggle:
// they get set by clicking a row in the GlobalSearch dropdown.
//
// Without a visible chip, a user who's just clicked "Show events with
// Courtesy" on desktop would see the feed change but no obvious
// "Courtesy filter is on" affordance. This chip row sits above the
// page title in the feed column, mirroring the mobile chip row's
// cyan/violet/amber palette so the same intent reads the same way
// across breakpoints.

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  parseFilters,
  serializeFilters,
  type FilterState,
} from '@/lib/filters';
import { ActiveChip } from '@/components/active-chip';

export function DesktopActiveSearchChip({
  artistLabel,
  venueLabel,
}: {
  artistLabel?: string | null;
  venueLabel?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const filters = parseFilters(searchParams);

  // Render nothing when no search-driven filters are active. The page
  // continues to show its eyebrow + title without any extra row, so
  // there's no awkward empty container in the layout.
  const hasArtist = !!filters.artist && !!artistLabel;
  const hasVenue = !!filters.venue && !!venueLabel;
  if (!hasArtist && !hasVenue) return null;

  function commit(next: FilterState) {
    const qs = serializeFilters(next);
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  function removeArtist() {
    commit({ ...filters, artist: null });
  }
  function removeVenue() {
    commit({ ...filters, venue: null });
  }

  return (
    <div
      role="group"
      aria-label="Active search filters"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      {hasArtist && (
        <ActiveChip tone="violet" onRemove={removeArtist}>
          {artistLabel}
        </ActiveChip>
      )}
      {hasVenue && (
        <ActiveChip tone="amber" onRemove={removeVenue}>
          {venueLabel}
        </ActiveChip>
      )}
    </div>
  );
}
