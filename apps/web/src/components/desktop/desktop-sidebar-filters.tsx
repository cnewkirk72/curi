'use client';

// Persistent left sidebar for filters, shown at `lg` (≥1024px) and
// above. The desktop counterpart of <FilterBar + FilterSheet>.
//
// Semantic parity with mobile:
//   - URL is still the source of truth for filter state
//   - Same FilterState / serializeFilters roundtrip
//   - Same cascade: toggling a parent genre off clears its subgenres
//   - Same useTransition pattern for responsive Apply
//
// Desktop-specific additions:
//   - Custom date range picker (Phase 6.2) inline below the preset
//     "When" pills. Selecting a range sets `when='custom'` and kicks
//     any active preset off; selecting a preset clears the range.
//   - Sticky at top-24 so it stays visible while the feed scrolls —
//     matches Notion/Linear filter-sidebar UX.
//
// The sidebar commits filter changes *immediately* rather than via
// an Apply button. That's because at desktop, side-by-side with the
// feed, users can see their change take effect and expect direct
// manipulation — the mobile Apply pattern is there to batch changes
// behind a modal that hides the feed.

import { Fragment, useMemo, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarRange } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DATE_OPTIONS,
  GENRE_OPTIONS,
  VIBE_OPTIONS,
  labelForDateRange,
  parentHasSubgenres,
  parseFilters,
  serializeFilters,
  subgenresForParent,
  hasActiveFilters,
  type DateFilter,
  type FilterState,
  type FilterOption,
} from '@/lib/filters';
import { getSubgenresByParent } from '@/lib/taxonomy';
import { SubgenrePicker } from '@/components/subgenre-picker';
import { DatePicker, nycTodayDayKey, type RangeValue } from '@/components/date-picker';

export function DesktopSidebarFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const filters = parseFilters(searchParams);
  const active = hasActiveFilters(filters);

  // Shared subgenre Map — computed once, same as the mobile sheet.
  const subgenresByParent = useMemo(() => getSubgenresByParent(), []);
  // NYC today, computed client-side on render. Fine for a feed that
  // already forces `dynamic` — any re-render will refresh it and the
  // date picker doesn't rely on it for correctness, only for the
  // "today" ring.
  const todayDayKey = useMemo(() => nycTodayDayKey(), []);

  function commit(next: FilterState) {
    const qs = serializeFilters(next);
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  // ── Preset "When" selection ────────────────────────
  function selectPreset(slug: Exclude<DateFilter, 'custom'>) {
    commit({
      ...filters,
      when: slug,
      date_from: null,
      date_to: null,
    });
  }

  // ── Custom range selection ─────────────────────────
  function onRangeChange(value: RangeValue) {
    // First click (from only, no to) — apply provisional state but
    // don't navigate yet; we wait for the second click to avoid
    // filtering the feed on a half-picked range. We encode the
    // half-state in the URL anyway so shareable links work; the
    // dateWindowFor() guard degrades to 'all' if the range is
    // incomplete.
    if (!value.from || !value.to) {
      if (!value.from && !value.to) {
        // Cleared entirely
        commit({ ...filters, when: 'all', date_from: null, date_to: null });
        return;
      }
      // Partial range — reflect it in URL so the picker stays sticky
      // on reload, but dateWindowFor will no-op.
      commit({
        ...filters,
        when: 'custom',
        date_from: value.from,
        date_to: value.to,
      });
      return;
    }
    commit({
      ...filters,
      when: 'custom',
      date_from: value.from,
      date_to: value.to,
    });
  }

  function clearRange() {
    commit({ ...filters, when: 'all', date_from: null, date_to: null });
  }

  // ── Genre / subgenre / vibe toggles ─────────────────────
  function toggle(list: string[], slug: string): string[] {
    return list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
  }

  function toggleGenre(slug: string) {
    const turningOn = !filters.genres.includes(slug);
    const nextGenres = toggle(filters.genres, slug);
    if (turningOn) {
      commit({ ...filters, genres: nextGenres });
      return;
    }
    // Turning off — cascade: clear any subgenres under this parent.
    const childSlugs = new Set(subgenresForParent(slug).map((o) => o.slug));
    commit({
      ...filters,
      genres: nextGenres,
      subgenres: filters.subgenres.filter((s) => !childSlugs.has(s)),
    });
  }

  function toggleSubgenre(slug: string) {
    commit({ ...filters, subgenres: toggle(filters.subgenres, slug) });
  }

  function toggleVibe(slug: string) {
    commit({ ...filters, vibes: toggle(filters.vibes, slug) });
  }

  function clearAll() {
    commit({
      when: 'all',
      date_from: null,
      date_to: null,
      genres: [],
      vibes: [],
      subgenres: [],
    });
  }

  const rangeLabel = labelForDateRange(filters);

  return (
    <aside
      aria-label="Event filters"
      className={cn(
        // Sticky just below the top nav (nav is py-4 ~72px), giving
        // the sidebar room while feed scrolls. max-h accounts for
        // the nav bar + some padding so long sidebars can scroll
        // internally without chopping off vibes.
        'sticky top-24 self-start',
        'max-h-[calc(100dvh-8rem)] overflow-y-auto',
        // Subtle pending shimmer — signals a filter change is inflight.
        isPending && 'opacity-80',
        'transition-opacity duration-micro ease-expo',
      )}
    >
      <div className="space-y-7 pr-2">
        {/* Header row — title + Clear affordance */}
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-sm font-semibold tracking-display text-fg-primary">
            Filters
          </h2>
          {active && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium text-fg-muted transition hover:text-fg-primary"
            >
              Clear all
            </button>
          )}
        </div>

        {/* ── When: presets + custom range picker ────────── */}
        <Section label="When">
          <div className="flex flex-wrap gap-2">
            {DATE_OPTIONS.map((opt) => {
              const presetActive = filters.when === opt.slug;
              return (
                <SingleSelectPill
                  key={opt.slug}
                  active={presetActive}
                  onClick={() => selectPreset(opt.slug)}
                >
                  {opt.label}
                </SingleSelectPill>
              );
            })}
          </div>

          {/* Custom range picker. Always rendered — the picker is the
              primary affordance for "specific dates" and showing it
              up front (vs behind a disclosure) is the main ergonomic
              win at desktop. */}
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-2xs text-fg-muted">
                <CalendarRange className="h-3 w-3" />
                {rangeLabel ?? 'Or pick a range'}
              </span>
              {filters.when === 'custom' && (
                <button
                  type="button"
                  onClick={clearRange}
                  className="text-2xs font-medium text-fg-muted transition hover:text-fg-primary"
                >
                  Reset
                </button>
              )}
            </div>
            <DatePicker
              mode="range"
              value={{ from: filters.date_from, to: filters.date_to }}
              onChange={onRangeChange}
              todayDayKey={todayDayKey}
              minDate={todayDayKey}
              ariaLabel="Pick a date range"
            />
          </div>
        </Section>

        {/* ── Genre + inline Subgenre picker ─────────────── */}
        <Section label="Genre" hint="Multi-select">
          <div className="flex flex-wrap gap-2">
            {GENRE_OPTIONS.map((opt) => {
              const parentActive = filters.genres.includes(opt.slug);
              const showSubPicker = parentActive && parentHasSubgenres(opt.slug);
              return (
                <Fragment key={opt.slug}>
                  <GenrePill
                    active={parentActive}
                    hasChildren={parentHasSubgenres(opt.slug)}
                    onClick={() => toggleGenre(opt.slug)}
                  >
                    {opt.label}
                  </GenrePill>
                  {showSubPicker && (
                    <SubgenrePicker
                      parents={[opt.slug]}
                      selectedParents={[opt.slug]}
                      subgenresByParent={subgenresByParent}
                      selectedSubgenres={filters.subgenres}
                      onToggle={toggleSubgenre}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
          {filters.genres.length === 0 && (
            <p className="mt-2 text-[11px] text-fg-dim">
              Pick a genre to reveal subgenres.
            </p>
          )}
        </Section>

        {/* ── Vibe ─────────────────────────────── */}
        <Section label="Vibe" hint="Multi-select">
          <OptionGrid
            options={VIBE_OPTIONS}
            selected={filters.vibes}
            onToggle={toggleVibe}
          />
        </Section>
      </div>
    </aside>
  );
}

// ── Subcomponents (mirror filter-sheet for visual parity) ──────

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          {label}
        </span>
        {hint && <span className="text-2xs text-fg-dim">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SingleSelectPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center rounded-pill border px-3.5 py-1.5 text-xs font-medium',
        'transition duration-micro ease-expo active:scale-[0.96]',
        active
          ? 'border-accent/40 bg-accent-chip text-accent shadow-glow-sm'
          : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}

function OptionGrid({
  options,
  selected,
  onToggle,
}: {
  options: FilterOption[];
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = selected.includes(opt.slug);
        return (
          <button
            key={opt.slug}
            type="button"
            onClick={() => onToggle(opt.slug)}
            aria-pressed={active}
            className={cn(
              'inline-flex items-center rounded-pill border px-3.5 py-1.5 text-xs font-medium',
              'transition duration-micro ease-expo active:scale-[0.96]',
              active
                ? 'border-accent/40 bg-accent-chip text-accent'
                : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function GenrePill({
  active,
  hasChildren,
  onClick,
  children,
}: {
  active: boolean;
  hasChildren: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-medium',
        'transition duration-micro ease-expo active:scale-[0.96]',
        active
          ? 'border-accent/40 bg-accent-chip text-accent'
          : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
      )}
    >
      {children}
      {hasChildren && (
        <span
          aria-hidden
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-pill transition',
            active ? 'bg-accent' : 'bg-border-strong',
          )}
        />
      )}
    </button>
  );
}
