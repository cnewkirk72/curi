// Cyan gradient progress bar for the onboarding flow.
//
// Pure presentational — takes a 0..1 value and renders the filled
// portion over a faint track. Animation is via a CSS transition on
// `transform: scaleX(n)` rather than a width change, because scale
// transforms compose with the GPU layer and stay silky on lower-end
// phones that would otherwise paint on every width tick.
//
// The gradient uses the same cyan → violet mix that the home-feed
// filter badge uses, so the progress affordance reads as "belongs
// to the same product" even though onboarding is pre-app.

import { cn } from '@/lib/utils';

type Props = {
  /** 0..1 — clamped internally, so callers don't have to worry about
   * off-by-one on the final step (sending 1.0 at "ready" is fine). */
  value: number;
  /** Optional label — rendered beneath the bar in small eyebrow type.
   * Used to show "Step 3 of 5" on some steps; omit for a pure bar. */
  label?: string;
  className?: string;
};

export function ProgressBar({ value, label, className }: Props) {
  const clamped = Math.max(0, Math.min(1, value));

  return (
    <div className={cn('w-full', className)}>
      <div
        className="relative h-1 w-full overflow-hidden rounded-pill bg-border/50"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
      >
        <div
          // scaleX for GPU-composable animation. transform-origin
          // is left so the bar fills from the start edge.
          className="absolute inset-0 origin-left rounded-pill bg-gradient-to-r from-accent via-accent to-violet shadow-glow-sm transition-transform duration-[480ms] ease-expo"
          style={{ transform: `scaleX(${clamped})` }}
        />
      </div>
      {label && (
        <p className="mt-2 font-display text-2xs uppercase tracking-widest text-fg-muted tabular">
          {label}
        </p>
      )}
    </div>
  );
}
