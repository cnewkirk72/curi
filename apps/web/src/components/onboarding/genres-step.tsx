'use client';

// Onboarding step 3 — pick genres (min 2), with inline subgenre
// disclosure under each active parent.
//
// Visual model has two tiers:
//   1. Featured cards — the four parents we think cover the
//      overwhelming majority of NYC electronic nights. Rendered
//      as big tap-targets with their genre label and a subtle
//      bloom when selected.
//   2. Chip overflow row — every other parent, as filter-sheet-
//      style pills. Same 1-tap toggle semantics as the cards.
//
// Underneath the picker we embed the shared <SubgenrePicker> from
// Phase 5.4 so the disclosure behavior (animated reveal, keyed by
// parent) stays identical between onboarding and the filter sheet.
//
// The "Continue" CTA is disabled until the user has selected at
// least two parents — the rest of the onboarding experience
// depends on there being enough signal to bias the feed.

import { useMemo } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  GENRE_OPTIONS,
  subgenresForParent,
  parentHasSubgenres,
  type FilterOption,
} from '@/lib/filters';
import { SubgenrePicker } from '@/components/subgenre-picker';
import { getSubgenresByParent } from '@/lib/taxonomy';

// Featured set — hand-picked for NYC. Order matters: this is the
// grid-top-to-bottom sequence users see.
const FEATURED_SLUGS = ['techno', 'house', 'disco', 'jungle'] as const;

type Props = {
  selectedGenres: string[];
  selectedSubgenres: string[];
  onToggleGenre: (slug: string) => void;
  onToggleSubgenre: (slug: string) => void;
  onBack: () => void;
  onContinue: () => void;
};

export function GenresStep({
  selectedGenres,
  selectedSubgenres,
  onToggleGenre,
  onToggleSubgenre,
  onBack,
  onContinue,
}: Props) {
  const { featured, overflow } = useMemo(() => {
    // Widen the literal tuple to a plain string set so `.has(string)`
    // typechecks cleanly against `o.slug: string` from GENRE_OPTIONS.
    const featuredSet = new Set<string>(FEATURED_SLUGS);
    const feat: FilterOption[] = [];
    for (const slug of FEATURED_SLUGS) {
      const opt = GENRE_OPTIONS.find((o) => o.slug === slug);
      if (opt) feat.push(opt);
    }
    const over = GENRE_OPTIONS.filter((o) => !featuredSet.has(o.slug));
    return { featured: feat, overflow: over };
  }, []);

  // Parent list order for the SubgenrePicker — featured first, then
  // overflow, so the inline subgenre rows appear in the same vertical
  // cadence the user scrolled through selecting them.
  const orderedParents = useMemo(
    () => [...featured.map((o) => o.slug), ...overflow.map((o) => o.slug)],
    [featured, overflow],
  );

  const subgenresByParent = useMemo(() => getSubgenresByParent(), []);

  const canContinue = selectedGenres.length >= 2;
  const selectionHint =
    selectedGenres.length === 0
      ? 'Pick at least two to tune your feed.'
      : selectedGenres.length === 1
      ? 'Pick one more to continue.'
      : `${selectedGenres.length} selected — keep going or continue.`;

  // Overflow parents with subgenres get a sub-row too, but the
  // SubgenrePicker already gates on `selectedParents`, so we just
  // pass the whole list and let it handle the filter.

  return (
    <div className="flex flex-col gap-5 px-5 pb-10 pt-4 animate-enter-up">
      <header className="space-y-2">
        <p className="font-display text-2xs uppercase tracking-widest text-accent">
          Step 3 of 5
        </p>
        <h2 className="font-display text-2xl font-semibold leading-tight tracking-display">
          What are you into?
        </h2>
        <p className="text-sm text-fg-muted">{selectionHint}</p>
      </header>

      {/* Featured cards */}
      <div className="grid grid-cols-2 gap-2.5">
        {featured.map((opt, idx) => {
          const active = selectedGenres.includes(opt.slug);
          return (
            <FeaturedCard
              key={opt.slug}
              label={opt.label}
              active={active}
              onClick={() => onToggleGenre(opt.slug)}
              delay={80 + idx * 60}
            />
          );
        })}
      </div>

      {/* Overflow chips */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-2xs uppercase tracking-widest text-fg-muted">
          <Sparkles className="h-3 w-3 text-accent" />
          <span className="font-display font-medium">More styles</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {overflow.map((opt) => {
            const active = selectedGenres.includes(opt.slug);
            return (
              <button
                key={opt.slug}
                type="button"
                onClick={() => onToggleGenre(opt.slug)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center rounded-pill border px-3.5 py-1.5 text-xs font-medium',
                  'transition duration-micro ease-expo active:scale-[0.96]',
                  active
                    ? 'border-accent/40 bg-accent-chip text-accent shadow-glow-sm'
                    : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Inline subgenre picker — only rows for selected parents render. */}
      {selectedGenres.some(parentHasSubgenres) && (
        <div>
          <div className="mb-2 text-2xs uppercase tracking-widest font-display font-medium text-fg-muted">
            Dial it in
          </div>
          <SubgenrePicker
            parents={orderedParents}
            selectedParents={selectedGenres}
            subgenresByParent={subgenresByParent}
            selectedSubgenres={selectedSubgenres}
            onToggle={onToggleSubgenre}
          />
        </div>
      )}

      {/* Helper hint for parents with no curated subgenres */}
      {selectedGenres.length > 0 &&
        !selectedGenres.some(parentHasSubgenres) && (
          <p className="text-2xs text-fg-dim">
            We&apos;ll add more detail options here as the taxonomy fills out.
          </p>
        )}

      {/* Footer CTA bar */}
      <div className="sticky bottom-3 z-10 mt-auto flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="text-sm font-medium text-fg-muted transition hover:text-fg-primary"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className={cn(
            'inline-flex items-center justify-center gap-2 rounded-pill bg-accent px-6 py-3',
            'font-display text-sm font-semibold text-bg-deep shadow-glow',
            'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
            'disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none',
          )}
        >
          Continue
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>

      {/* Helper to read out exactly what picks remain */}
      {!canContinue && (
        <p className="-mt-1 text-center text-2xs text-fg-dim">
          {selectedGenres.length === 0
            ? 'Tap any tile to get started.'
            : 'One more genre unlocks Continue.'}
        </p>
      )}
    </div>
  );
}

// ── FeaturedCard ─────────────────────────────────────────────────────
//
// A larger, visually-weighted tap target for the top four parents.
// Active state uses the cyan bloom ring + filled chip; inactive uses
// border-border-strong for a subtle affordance.

function FeaturedCard({
  label,
  active,
  onClick,
  delay,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  delay: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both' }}
      className={cn(
        'relative overflow-hidden rounded-2xl border p-4 text-left',
        'transition duration-micro ease-expo active:scale-[0.98]',
        'animate-enter-up motion-reduce:animate-none',
        active
          ? 'border-accent/50 bg-accent-chip shadow-glow-sm'
          : 'border-border-strong bg-bg-elevated hover:border-accent/30',
      )}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full blur-2xl transition duration-[320ms]',
          active ? 'bg-accent/30' : 'bg-accent/0 group-hover:bg-accent/10',
        )}
      />
      <div className="relative flex flex-col gap-2">
        <span
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded-pill border text-[10px] font-semibold',
            active
              ? 'border-accent bg-accent text-bg-deep'
              : 'border-border text-fg-dim',
          )}
          aria-hidden
        >
          {active ? '✓' : '+'}
        </span>
        <span
          className={cn(
            'font-display text-lg font-semibold tracking-display',
            active ? 'text-accent' : 'text-fg-primary',
          )}
        >
          {label}
        </span>
      </div>
    </button>
  );
}
