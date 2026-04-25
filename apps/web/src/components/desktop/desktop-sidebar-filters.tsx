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
//   - Custom single-date picker (Phase 6.2) inline below the preset
//     "When" pills. Selecting a date sets `when='custom'` with
//     `date_from = picked day` and `date_to = null` (open-ended
//     "from X onward"); selecting a preset clears the custom date.
//   - Sticky at top-24 so it stays visible while the feed scrolls —
//     matches Notion/Linear filter-sidebar UX.
//
// The sidebar commits filter changes *immediately* rather than via
// an Apply button. That's because at desktop, side-by-side with the
// feed, users can see their change take effect and expect direct
// manipulation — the mobile Apply pattern is there to batch changes
// behind a modal that hides the feed.

import { Fragment, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarRange, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DATE_OPTIONS,
  SETTING_OPTIONS,
  displayDateForFilter,
  labelForDateRange,
  parentHasSubgenres,
  parseFilters,
  serializeFilters,
  sortGenresByPrefs,
  sortVibesByPrefs,
  subgenresForParent,
  hasActiveFilters,
  type DateFilter,
  type FilterState,
  type FilterOption,
} from '@/lib/filters';
import { getSubgenresByParent } from '@/lib/taxonomy';
import { SubgenrePicker } from '@/components/subgenre-picker';
import { DatePicker, nycTodayDayKey, type SingleValue } from '@/components/date-picker';

export function DesktopSidebarFilters({
  userPrefs,
}: {
  /** Phase 3.18 — onboarding-time preferences used to bubble preferred
   *  genres/vibes to the front of their respective rows on the home
   *  feed. Pass undefined for anon viewers — falls back to default
   *  ordering. */
  userPrefs?: { genres: string[]; vibes: string[] };
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // "More genres" reveal — collapsed by default, resets to collapsed
  // on each visit (per the Phase 3.18 spec). We don't persist this
  // because user-pref ordering already promotes the user's most-cared-
  // about genres into the always-visible row, so the More disclosure
  // is for genuine exploration ("what else is out there") rather than
  // permanent navigation.
  const [showMoreGenres, setShowMoreGenres] = useState(false);

  const filters = parseFilters(searchParams);
  const active = hasActiveFilters(filters);

  // Pref-aware genre split: user's preferred genres bubble to the
  // front of the visible-by-default 14, default order fills the rest.
  // Recomputed only on prefs change (effectively never within a
  // session) — useMemo guards against unnecessary churn.
  const { visible: visibleGenres, more: moreGenres } = useMemo(
    () => sortGenresByPrefs(userPrefs?.genres ?? []),
    [userPrefs?.genres],
  );
  const sortedVibes = useMemo(
    () => sortVibesByPrefs(userPrefs?.vibes ?? []),
    [userPrefs?.vibes],
  );

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

  // ── Preset "When" selection ─────────────────────────────
  function selectPreset(slug: Exclude<DateFilter, 'custom'>) {
    commit({
      ...filters,
      when: slug,
      date_from: null,
      date_to: null,
    });
  }

  // ── Custom single-date selection ────────────────────────────
  // Picking a day sets `when='custom'` with `date_from = day` and
  // `date_to = null` — i.e. "from this day onward". Re-tapping the
  // same day in the picker clears it (handled by DatePicker's single
  // mode returning null) and we demote back to 'all'.
  function onDateChange(value: SingleValue) {
    if (!value) {
      commit({ ...filters, when: 'all', date_from: null, date_to: null });
      return;
    }
    commit({
      ...filters,
      when: 'custom',
      date_from: value,
      date_to: null,
    });
  }

  function clearDate() {
    commit({ ...filters, when: 'all', date_from: null, date_to: null });
  }

  // ── Genre / subgenre / vibe toggles ─────────────────────────────
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

  function toggleSetting(slug: string) {
    commit({ ...filters, setting: toggle(filters.setting, slug) });
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

        {/* ── When: presets + custom range picker ─────────── */}
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

          {/* Custom single-date picker. Always rendered — the picker
              is the primary affordance for "specific dates" and
              showing it up front (vs behind a disclosure) is the main
              ergonomic win at desktop. */}
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-2xs text-fg-muted">
                <CalendarRange className="h-3 w-3" />
                {rangeLabel ?? 'Or pick a specific date'}
              </span>
              {filters.when === 'custom' && (
                <button
                  type="button"
                  onClick={clearDate}
                  className="text-2xs font-medium text-fg-muted transition hover:text-fg-primary"
                >
                  Reset
                </button>
              )}
            </div>
            {/* The picker's `value` reflects the active preset's
                implied day (e.g., `tomorrow` → tomorrow's dayKey) so
                the calendar shows visual feedback even when the user
                is in preset mode rather than custom. Tapping the
                highlighted day promotes the preset's window to a
                "from this day onward" custom range. */}
            <DatePicker
              mode="single"
              value={displayDateForFilter(filters)}
              onChange={onDateChange}
              todayDayKey={todayDayKey}
              minDate={todayDayKey}
              ariaLabel="Pick a specific date"
            />
          </div>
        </Section>

        {/* ── Genre + inline Subgenre picker ─────────────── */}
        <Section label="Genre" hint="Multi-select">
          <div className="flex flex-wrap gap-2">
            {visibleGenres.map((opt) => (
              <GenreWithSubs
                key={opt.slug}
                opt={opt}
                filters={filters}
                subgenresByParent={subgenresByParent}
                onToggleGenre={toggleGenre}
                onToggleSubgenre={toggleSubgenre}
              />
            ))}
            {showMoreGenres &&
              moreGenres.map((opt) => (
                <GenreWithSubs
                  key={opt.slug}
                  opt={opt}
                  filters={filters}
                  subgenresByParent={subgenresByParent}
                  onToggleGenre={toggleGenre}
                  onToggleSubgenre={toggleSubgenre}
                />
              ))}
          </div>
          {moreGenres.length > 0 && (
            <button
              type="button"
              onClick={() => setShowMoreGenres((v) => !v)}
              aria-expanded={showMoreGenres}
              className={cn(
                'mt-3 inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-widest text-fg-muted',
                'transition hover:text-fg-primary',
              )}
            >
              <ChevronDown
                className={cn(
                  'h-3 w-3 transition-transform duration-micro ease-expo',
                  showMoreGenres && 'rotate-180',
                )}
              />
              {showMoreGenres ? 'Fewer genres' : `More genres (+${moreGenres.length})`}
            </button>
          )}
          {filters.genres.length === 0 && (
            <p className="mt-2 text-[11px] text-fg-dim">
              Pick a genre to reveal subgenres.
            </p>
          )}
        </Section>

        {/* ── Vibe (artist-mood) ──────────────────────────── */}
        <Section label="Vibe" hint="Multi-select">
          <OptionGrid
            options={sortedVibes}
            selected={filters.vibes}
            onToggle={toggleVibe}
          />
        </Section>

        {/* ── Setting (event context, optional) ────────────
             Phase 3.18 — rendered below Vibe per the spec. Backed
             by events.setting (migration 0017), populated by the
             SQL derivation in migration 0018. Optional filter:
             empty selection means "all settings."
         */}
        <Section label="Setting" hint="Optional">
          <OptionGrid
            options={SETTING_OPTIONS}
            selected={filters.setting}
            onToggle={toggleSetting}
          />
        </Section>
      </div>
    </aside>
  );
}

// Helper component — renders a single genre pill plus its inline
// subgenre picker when the parent is selected. Factored out so the
// "default-visible" and "more genres" rows can share the same render
// logic without copy-pasting the Fragment/picker dance.
function GenreWithSubs({
  opt,
  filters,
  subgenresByParent,
  onToggleGenre,
  onToggleSubgenre,
}: {
  opt: FilterOption;
  filters: FilterState;
  subgenresByParent: Map<string, FilterOption[]>;
  onToggleGenre: (slug: string) => void;
  onToggleSubgenre: (slug: string) => void;
}) {
  const parentActive = filters.genres.includes(opt.slug);
  const showSubPicker = parentActive && parentHasSubgenres(opt.slug);
  return (
    <Fragment>
      <GenrePill
        active={parentActive}
        hasChildren={parentHasSubgenres(opt.slug)}
        onClick={() => onToggleGenre(opt.slug)}
      >
        {opt.label}
      </GenrePill>
      {showSubPicker && (
        <SubgenrePicker
          parents={[opt.slug]}
          selectedParents={[opt.slug]}
          subgenresByParent={subgenresByParent}
          selectedSubgenres={filters.subgenres}
          onToggle={onToggleSubgenre}
        />
      )}
    </Fragment>
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
