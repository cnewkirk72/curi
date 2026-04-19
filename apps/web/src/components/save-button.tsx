'use client';

// Bookmark toggle.
//
// Two-tier behavior:
//   - signed out → one-tap sends them to /login?next=<current>
//   - signed in  → optimistic flip locally, server action in the
//                  background, revalidatePath keeps /saved +
//                  /profile counts honest
//
// We use `useTransition` + a locally-held `saved` state rather
// than `useOptimistic` because the state needs to survive beyond
// the transition — `useOptimistic` resets when the server action
// resolves, which would briefly snap the icon back to its old
// value before revalidatePath completes.
//
// `stopPropagation` on the click handler is load-bearing: the
// button lives inside an <a>/<Link> event card, and without it
// every tap on the bookmark would also navigate to the detail
// page.

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bookmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { saveEvent, unsaveEvent } from '@/lib/save-actions';

type Props = {
  eventId: string;
  initialSaved: boolean;
  /** Whether the current viewer is signed in. False → tapping
   *  redirects to /login rather than firing the server action. */
  signedIn: boolean;
  /** Size + surface tuning. `hero` is the card-hero variant (dark
   *  backdrop pill), `inline` is the detail-page variant (sits in
   *  normal flow with a subtle border). */
  variant?: 'hero' | 'inline';
  /** Screen-reader fallback label. */
  ariaLabel?: string;
};

export function SaveButton({
  eventId,
  initialSaved,
  signedIn,
  variant = 'hero',
  ariaLabel = 'Save event',
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [saved, setSaved] = useState(initialSaved);
  const [isPending, startTransition] = useTransition();

  function handleClick(e: React.MouseEvent) {
    // Keep the card underneath from swallowing this tap into a
    // navigation to /events/:id.
    e.preventDefault();
    e.stopPropagation();

    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    const next = !saved;
    setSaved(next);
    startTransition(async () => {
      const result = next
        ? await saveEvent(eventId)
        : await unsaveEvent(eventId);
      if (!result.ok) {
        // Roll back the optimistic flip. `unauth` shouldn't happen
        // here (signedIn was true when the click fired), but we
        // handle it defensively — likely the session expired mid-
        // click, so bounce to login.
        setSaved(!next);
        if (result.reason === 'unauth') {
          router.push(`/login?next=${encodeURIComponent(pathname)}`);
        }
      }
    });
  }

  const isHero = variant === 'hero';
  const label = saved ? 'Saved' : 'Save';

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={saved}
      aria-label={`${label} event: ${ariaLabel}`}
      disabled={isPending}
      className={cn(
        'inline-flex items-center justify-center rounded-pill transition duration-micro ease-expo',
        'active:scale-[0.92] disabled:opacity-80',
        isHero
          ? // Card hero: dark glassy pill sitting over the image
            [
              'h-9 w-9 backdrop-blur',
              saved
                ? 'bg-accent text-bg-deep shadow-glow-sm'
                : 'bg-bg-deep/70 text-fg-primary hover:bg-bg-deep/85',
            ]
          : // Inline: sits alongside text, subtle bordered pill
            [
              'gap-1.5 border px-3.5 py-2 text-xs font-medium',
              saved
                ? 'border-accent/40 bg-accent-chip text-accent shadow-glow-sm'
                : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
            ],
      )}
    >
      <Bookmark
        className={cn(
          isHero ? 'h-4 w-4' : 'h-3.5 w-3.5',
          // Filled when saved — `fill-current` uses the text color so
          // we get cyan-on-cyan in the inline variant and bg-deep-on-
          // accent in the hero variant without a separate color prop.
          saved ? 'fill-current' : 'fill-none',
        )}
        strokeWidth={2}
      />
      {!isHero && <span>{label}</span>}
    </button>
  );
}
