'use client';

// Onboarding step 6 (terminal) — "You're in" moment.
//
// Visually this is a bloom: three concentric cyan rings that expand
// out from the center, a centered sparkle dot, and a first-name
// greeting. The rings run once on mount via the `ring-bloom`
// keyframe (see tailwind.config.ts). Under prefers-reduced-motion
// we fall back to three static rings at rest — still recognizable
// as the same composition.
//
// Firing order:
//   mount → completeOnboarding() runs in an effect → bloom animates
//   → on animation end, the "See my feed" CTA is enabled.
//
// We kick off completeOnboarding from here so the stamp lands even
// if the user bounces away before tapping the CTA — the onboarding
// gate in Task #6 checks `onboarding_completed_at`, and the user
// has effectively finished the flow by reaching this screen.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { completeOnboarding } from '@/app/onboarding/actions';

type Props = {
  /** Display name (from profiles.display_name) or null if the user
   * skipped sign-in. Determines whether we greet them by first name
   * or with the neutral "You're in". */
  displayName: string | null;
};

export function ReadyStep({ displayName }: Props) {
  const router = useRouter();
  const [completing, setCompleting] = useState(true);
  const [completionError, setCompletionError] = useState<string | null>(null);

  // Fire completeOnboarding once on mount. Unauth users (Skip path)
  // get `unauth` back — that's fine; the redirect gate is only active
  // for signed-in users, so there's nothing to stamp.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await completeOnboarding();
      if (cancelled) return;
      setCompleting(false);
      if (!result.ok && result.reason === 'failed') {
        setCompletionError('Saving finished, but one last write failed. Retry?');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function goToFeed() {
    router.push('/events');
  }

  function retry() {
    setCompleting(true);
    setCompletionError(null);
    completeOnboarding().then((result) => {
      setCompleting(false);
      if (!result.ok && result.reason === 'failed') {
        setCompletionError('Still failing. Head to the feed; you can re-run from Profile.');
      }
    });
  }

  const firstName = displayName?.trim().split(/\s+/)[0] ?? null;
  const greeting = firstName ? `You're in, ${firstName}.` : "You're in.";

  return (
    <div className="relative flex min-h-[calc(100dvh-8rem)] flex-col items-center justify-center px-5 text-center">
      {/* Concentric ring bloom. Three rings, staggered by 120ms. */}
      <div
        aria-hidden
        className="relative mb-8 flex h-48 w-48 items-center justify-center"
      >
        <Ring delay={0} />
        <Ring delay={120} />
        <Ring delay={240} />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-accent/10 shadow-glow-lg animate-enter-scale motion-reduce:animate-none">
          <Sparkles className="h-8 w-8 text-accent" strokeWidth={2} />
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <h2
          className="font-display text-3xl font-semibold tracking-display animate-enter-up motion-reduce:animate-none"
          style={{ animationDelay: '260ms', animationFillMode: 'both' }}
        >
          {greeting}
        </h2>
        <p
          className="max-w-sm text-sm text-fg-muted animate-enter-up motion-reduce:animate-none"
          style={{ animationDelay: '360ms', animationFillMode: 'both' }}
        >
          Your feed is tuned. We&apos;ll keep refining as you save events
          and tap around.
        </p>
      </div>

      <button
        type="button"
        onClick={goToFeed}
        disabled={completing}
        className={cn(
          'mt-8 inline-flex items-center justify-center gap-2 rounded-pill bg-accent px-7 py-3.5',
          'font-display text-sm font-semibold text-bg-deep shadow-glow',
          'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
          'animate-enter-up motion-reduce:animate-none',
          'disabled:pointer-events-none disabled:opacity-60 disabled:shadow-none',
        )}
        style={{ animationDelay: '500ms', animationFillMode: 'both' }}
      >
        {completing ? 'Tuning…' : 'See my feed'}
        <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
      </button>

      {completionError && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-amber/30 bg-amber-chip px-4 py-3 text-xs text-amber">
          <span>{completionError}</span>
          <button
            type="button"
            onClick={retry}
            className="font-semibold text-amber underline decoration-dotted underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ── Ring ─────────────────────────────────────────────────────────────

function Ring({ delay }: { delay: number }) {
  return (
    <span
      aria-hidden
      style={{ animationDelay: `${delay}ms` }}
      className={cn(
        'absolute inset-0 rounded-full border border-accent/40',
        // prefers-reduced-motion: hold at rest state (scale 1, opacity .3)
        'motion-reduce:animate-none',
        'animate-ring-bloom motion-reduce:animate-none',
      )}
    />
  );
}
