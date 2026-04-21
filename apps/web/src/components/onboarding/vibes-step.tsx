'use client';

// Onboarding step 4 — pick vibes.
//
// Violet-tinted chip grid so "vibes" reads as a different semantic
// layer from "genres" (which uses cyan). Same toggle model as the
// genre chips — min 1 to continue, but soft-floor: if the user
// selects zero and taps Continue we still let them through. Vibes
// are a finer-grained taste signal; absence is fine.
//
// This step deliberately doesn't force a minimum the way genres
// does. The reasoning: genres control which events even *show up*
// in the feed bias; vibes are a ranking nudge within those events.
// A user who's clear on genre but fuzzy on vibe ("I don't know,
// just good music") should be able to flow through.

import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VIBE_OPTIONS } from '@/lib/filters';

type Props = {
  selectedVibes: string[];
  onToggleVibe: (slug: string) => void;
  onBack: () => void;
  onContinue: () => void;
};

export function VibesStep({
  selectedVibes,
  onToggleVibe,
  onBack,
  onContinue,
}: Props) {
  const hint =
    selectedVibes.length === 0
      ? 'Skip if nothing jumps out — vibes are optional.'
      : `${selectedVibes.length} selected. Add more if it fits.`;

  return (
    <div className="flex flex-col gap-5 px-5 pb-10 pt-4 animate-enter-up">
      <header className="space-y-2">
        <p className="font-display text-2xs uppercase tracking-widest text-violet">
          Step 4 of 5
        </p>
        <h2 className="font-display text-2xl font-semibold leading-tight tracking-display">
          How do you like
          <br />
          your nights?
        </h2>
        <p className="text-sm text-fg-muted">{hint}</p>
      </header>

      <div className="flex flex-wrap gap-2">
        {VIBE_OPTIONS.map((opt, idx) => {
          const active = selectedVibes.includes(opt.slug);
          return (
            <button
              key={opt.slug}
              type="button"
              onClick={() => onToggleVibe(opt.slug)}
              aria-pressed={active}
              style={{
                animationDelay: `${60 + idx * 40}ms`,
                animationFillMode: 'both',
              }}
              className={cn(
                'inline-flex items-center rounded-pill border px-4 py-2 text-sm font-medium',
                'transition duration-micro ease-expo active:scale-[0.96]',
                'animate-enter-up motion-reduce:animate-none',
                active
                  ? 'border-violet/50 bg-violet-chip text-violet'
                  : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

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
          className={cn(
            'inline-flex items-center justify-center gap-2 rounded-pill bg-accent px-6 py-3',
            'font-display text-sm font-semibold text-bg-deep shadow-glow',
            'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
          )}
        >
          Continue
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
