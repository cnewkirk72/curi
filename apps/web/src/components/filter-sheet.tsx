'use client';

// Bottom sheet for filter editing.
//
// Filter state is ultimately owned by the URL — that's what makes
// filter URLs shareable and makes the back button work. The sheet
// holds its own *draft* state while open so a user can tick/untick
// options without triggering a server round-trip on every change; on
// Apply we serialize the draft and `router.push` the new URL, which
// re-runs `getUpcomingEvents` on the server.
//
// We use `useTransition` so the Apply click feels responsive — the
// sheet closes immediately and the card list pulses via the returned
// `isPending` flag while the server refetches.

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarRange, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DATE_OPTIONS,
  SETTING_OPTIONS,
  displayDateForFilter,
  labelForDateRange,
  parentHasSubgenres,
  serializeFilters,
  sortGenresByPrefs,
  sortVibesByPrefs,
  subgenresForParent,
  type DateFilter,
  type FilterState,
  type FilterOption,
} from '@/lib/filters';
import { getSubgenresByParent } from '@/lib/taxonomy';
import { SubgenrePicker } from '@/components/subgenre-picker';
import { DatePicker, nycTodayDayKey, type SingleValue } from '@/components/date-picker';

type Props = {
  open: boolean;
  onClose: () => void;
  initialFilters: FilterState;
  /** Phase 3.18 — onboarding-time prefs used to bubble preferred
   *  genres/vibes to the front of their respective rows. Pass
   *  undefined for anon viewers. */
  userPrefs?: { genres: string[]; vibes: string[] };
};

export function FilterSheet({ open, onClose, initialFilters, userPrefs }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState<FilterState>(initialFilters);
  // "More genres" reveal — collapsed on each open, matching the
  // desktop sidebar.
  const [showMoreGenres, setShowMoreGenres] = useState(false);

  // Pref-aware genre/vibe ordering. Recomputed only when prefs
  // change (basically never within a session) so the sort isn't
  // doing extra work on every keystroke inside the sheet.
  const { visible: visibleGenres, more: moreGenres } = useMemo(
    () => sortGenresByPrefs(userPrefs?.genres ?? []),
    [userPrefs?.genres],
  );
  const sortedVibes = useMemo(
    () => sortVibesByPrefs(userPrefs?.vibes ?? []),
    [userPrefs?.vibes],
  );

  // Re-seed the draft whenever the sheet opens — the URL might have
  // changed since the last open (e.g. user hit "Clear" on the bar),
  // and we want the sheet to reflect the current URL, not the draft
  // the user abandoned last time. Also reset the More-genres
  // disclosure to collapsed (per Phase 3.18 spec — power users still
  // get their picks via pref ordering).
  useEffect(() => {
    if (open) {
      setDraft(initialFilters);
      setShowMoreGenres(false);
    }
  }, [open, initialFilters]);

  // Scroll lock while the sheet is open — keeps the feed beneath
  // from scrolling when a user drags inside the sheet.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC to close (keyboard a11y for anyone using a Bluetooth keyboard
  // with the PWA, and for the web-desktop fallback).
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [open, onClose]);

  function toggle(list: string[], slug: string): string[] {
    return list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
  }

  function apply() {
    const qs = serializeFilters(draft);
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
      onClose();
    });
  }

  function clearAll() {
    setDraft({
      when: 'all',
      date_from: null,
      date_to: null,
      genres: [],
      vibes: [],
      setting: [],
      subgenres: [],
      q: '',
      // Phase 6.3 — search-driven filters cleared by Clear-all too,
      // so the URL doesn't keep an invisible artist/venue scope after
      // the user empties every visible facet.
      artist: null,
      venue: null,
    });
  }

  // Custom date <-> preset handoff.
  //   Picking a preset clears the custom date; picking a specific day
  //   sets when='custom' with date_from = day / date_to = null (open-
  //   ended "from X onward") and clears the preset. Either action is
  //   one-way — no ambiguous "both set" state.
  function selectPreset(slug: Exclude<DateFilter, 'custom'>) {
    setDraft((d) => ({ ...d, when: slug, date_from: null, date_to: null }));
  }
  function onDateChange(value: SingleValue) {
    if (!value) {
      // Cleared from inside the picker (re-tap of the selected day).
      setDraft((d) => ({ ...d, when: 'all', date_from: null, date_to: null }));
      return;
    }
    setDraft((d) => ({
      ...d,
      when: 'custom',
      date_from: value,
      date_to: null,
    }));
  }

  // Toggling a parent genre cascades to its subgenres: if the
  // parent is being turned OFF, any subgenres registered to that
  // parent get cleared too. Otherwise the user would see a ghost
  // "?subgenres=dark+techno" active chip with no parent to anchor it.
  function toggleGenre(slug: string) {
    setDraft((d) => {
      const turningOn = !d.genres.includes(slug);
      const nextGenres = toggle(d.genres, slug);
      if (turningOn) return { ...d, genres: nextGenres };
      const childSlugs = new Set(
        subgenresForParent(slug).map((o) => o.slug),
      );
      return {
        ...d,
        genres: nextGenres,
        subgenres: d.subgenres.filter((s) => !childSlugs.has(s)),
      };
    });
  }

  function toggleSubgenre(slug: string) {
    setDraft((d) => ({ ...d, subgenres: toggle(d.subgenres, slug) }));
  }

  // Shared Map<parent, subgenre[]> for the picker. Computed once;
  // the curated table is static, so memoization keeps us from
  // re-allocating the Map on every open/toggle.
  const subgenresByParent = useMemo(() => getSubgenresByParent(), []);
  // NYC today, computed once per sheet mount. Safe to freeze — the
  // sheet's lifetime is shorter than a day boundary in any realistic
  // session.
  const todayDayKey = useMemo(() => nycTodayDayKey(), []);
  const rangeLabel = labelForDateRange(draft);

  return (
    <>
      {/* Backdrop ─────────────────────────────────────────────────────── */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-bg-deep/70 backdrop-blur-sm',
          'transition-opacity duration-sheet ease-expo',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      {/* Sheet ─────────────────────────────────────────────────────── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filter events"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[430px]',
          'transition-transform duration-sheet ease-expo',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="curi-glass rounded-t-2xl border-t border-border shadow-card">
          {/* Handle — visual affordance that this panel is drag-up / tap-out.
              Not actually draggable; adding a real drag gesture is overkill for
              v1. Keyboard users get ESC, tap users get the backdrop + X. */}
          <div className="flex justify-center pt-2">
            <div className="h-1 w-10 rounded-pill bg-border-strong" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pb-2 pt-3">
            <h2 className="font-display text-base font-semibold tracking-display text-fg-primary">
              Filter events
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close filters"
              className="inline-flex h-8 w-8 items-center justify-center rounded-pill text-fg-muted transition hover:bg-bg-elevated-hover hover:text-fg-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Scrollable body — capped at ~70vh so the Apply/Clear row
              never scrolls out of reach on short phones. */}
          <div className="max-h-[70dvh] space-y-6 overflow-y-auto px-5 pb-4 pt-2">
            {/* When — presets + optional custom range picker. The
                range picker is collapsed behind a disclosure on mobile
                to keep the sheet short; expanding it swaps `when` to
                'custom' and the preset pills go inactive. */}
            <Section label="When">
              <div className="flex flex-wrap gap-2">
                {DATE_OPTIONS.map((opt) => (
                  <SingleSelectPill
                    key={opt.slug}
                    active={draft.when === opt.slug}
                    onClick={() => selectPreset(opt.slug)}
                  >
                    {opt.label}
                  </SingleSelectPill>
                ))}
              </div>

              {/* Custom date disclosure. When a custom date is already
                  set we render the picker expanded by default so the
                  user can see what they chose. Otherwise we start
                  collapsed and let them tap to expand. The `value`
                  passed to the picker reflects the active preset's
                  implied day (e.g., `tomorrow` → tomorrow's dayKey)
                  so the calendar shows visual feedback even when the
                  user hasn't entered custom mode yet. Tapping the
                  highlighted day promotes the preset's 24-hour window
                  to a "from this day onward" custom range — a
                  one-click escape hatch from preset semantics. */}
              <CustomDateDisclosure
                expanded={draft.when === 'custom'}
                rangeLabel={rangeLabel}
                value={displayDateForFilter(draft)}
                todayDayKey={todayDayKey}
                onChange={onDateChange}
              />
            </Section>

            {/* Genre + inline Subgenre picker.
                When a parent has curated subgenres AND is selected,
                its subgenre row appears immediately below it in the
                flex-wrap grid (basis-full forces the line break).
                This mirrors the in-app pattern used by onboarding,
                so a user learns one interaction and gets it
                everywhere. */}
            <Section label="Genre" hint="Multi-select">
              <div className="flex flex-wrap gap-2">
                {visibleGenres.map((opt) => (
                  <SheetGenreWithSubs
                    key={opt.slug}
                    opt={opt}
                    draft={draft}
                    subgenresByParent={subgenresByParent}
                    onToggleGenre={toggleGenre}
                    onToggleSubgenre={toggleSubgenre}
                  />
                ))}
                {showMoreGenres &&
                  moreGenres.map((opt) => (
                    <SheetGenreWithSubs
                      key={opt.slug}
                      opt={opt}
                      draft={draft}
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
              {/* Hint — surfaced only when no parents are selected,
                  to tell users subgenres will appear. Fades out as
                  soon as any parent is on. */}
              {draft.genres.length === 0 && (
                <p className="mt-2 text-[11px] text-fg-dim">
                  Pick a genre to reveal subgenres.
                </p>
              )}
            </Section>

            {/* Vibe (artist-mood). Phase 3.18 — pref-sorted so the
                user's onboarding picks bubble to the front. */}
            <Section label="Vibe" hint="Multi-select">
              <OptionGrid
                options={sortedVibes}
                selected={draft.vibes}
                onToggle={(slug) =>
                  setDraft((d) => ({
                    ...d,
                    vibes: toggle(d.vibes, slug),
                  }))
                }
              />
            </Section>

            {/* Setting (event context, optional). Phase 3.18 —
                rendered below Vibe per the spec; backed by
                events.setting (migration 0017). */}
            <Section label="Setting" hint="Optional">
              <OptionGrid
                options={SETTING_OPTIONS}
                selected={draft.setting}
                onToggle={(slug) =>
                  setDraft((d) => ({
                    ...d,
                    setting: toggle(d.setting, slug),
                  }))
                }
              />
            </Section>
          </div>

          {/* Footer — safe-area aware so the Apply button doesn't get
              eaten by the iPhone home indicator. */}
          <div className="flex items-center gap-3 border-t border-border px-5 pb-[max(env(safe-area-inset-bottom),16px)] pt-4">
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium text-fg-muted transition hover:text-fg-primary"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={isPending}
              className={cn(
                'ml-auto inline-flex items-center justify-center rounded-pill bg-accent px-6 py-2.5',
                'font-display text-xs font-semibold text-bg-deep shadow-glow',
                'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
                'disabled:opacity-60',
              )}
            >
              {isPending ? 'Applying…' : 'Apply filters'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Subcomponents ───────────────────────────────────────────────

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
        {hint && (
          <span className="text-2xs text-fg-dim">{hint}</span>
        )}
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
        'inline-flex items-center rounded-pill border px-4 py-2 text-xs font-medium',
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

// Custom-date disclosure + inline DatePicker.
// The picker is lazily revealed (click-to-expand) rather than always
// on display; a typical mobile user picks a preset ("Tonight") more
// often than a specific date, so we don't want the picker eating
// vertical space by default.
function CustomDateDisclosure({
  expanded,
  rangeLabel,
  value,
  todayDayKey,
  onChange,
}: {
  expanded: boolean;
  rangeLabel: string | null;
  value: string | null;
  todayDayKey: string;
  onChange: (v: SingleValue) => void;
}) {
  const [open, setOpen] = useState(expanded);
  // Re-sync if the parent flipped `when=custom` after mount (e.g. a
  // hand-crafted URL landed already-custom) — we want the picker
  // visible so the user sees what's selected.
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill border px-4 py-2 text-xs font-medium',
          'transition duration-micro ease-expo active:scale-[0.96]',
          expanded
            ? 'border-accent/40 bg-accent-chip text-accent shadow-glow-sm'
            : // Inactive state gets a very soft cyan glow + accent-tinted
              // border so the "custom date" option reads as discoverable
              // without competing with the preset pills for primacy. Hover
              // escalates subtly.
              'border-accent/25 bg-bg-elevated text-fg-muted shadow-[0_0_14px_rgba(34,211,238,0.12)] hover:border-accent/40 hover:text-fg-primary hover:shadow-[0_0_18px_rgba(34,211,238,0.18)]',
        )}
      >
        <CalendarRange
          className={cn('h-3.5 w-3.5', !expanded && 'text-accent/80')}
        />
        {rangeLabel ?? 'Pick a specific date'}
      </button>

      {open && (
        <div className="mt-3 animate-fade-in">
          <DatePicker
            mode="single"
            value={value}
            onChange={onChange}
            todayDayKey={todayDayKey}
            minDate={todayDayKey}
            ariaLabel="Pick a specific date"
            className="mx-auto"
          />
          <p className="mt-2 text-center text-[11px] text-fg-dim">
            Tap a day to filter the feed from that date onward.
          </p>
        </div>
      )}
    </div>
  );
}

// Renders a single genre pill plus its inline subgenre picker when
// the parent is selected. Mirror of GenreWithSubs in the desktop
// sidebar — separate copy because the sheet uses draft state via
// setDraft instead of immediate router.push.
function SheetGenreWithSubs({
  opt,
  draft,
  subgenresByParent,
  onToggleGenre,
  onToggleSubgenre,
}: {
  opt: FilterOption;
  draft: FilterState;
  subgenresByParent: Map<string, FilterOption[]>;
  onToggleGenre: (slug: string) => void;
  onToggleSubgenre: (slug: string) => void;
}) {
  const parentActive = draft.genres.includes(opt.slug);
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
          selectedSubgenres={draft.subgenres}
          onToggle={onToggleSubgenre}
        />
      )}
    </Fragment>
  );
}

// GenrePill — same shape as the OptionGrid chip, with a subtle
// chevron-dot indicator when the parent has curated subgenres. The
// dot flips to a filled cyan marker when the parent is active, so
// it doubles as a "you can reveal more here" affordance.
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
