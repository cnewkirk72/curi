// Genre / vibe chip. Tone is chosen upstream (home feed picks from a
// deterministic tone map keyed on the first genre) so the same genre
// always lands on the same color across the app.

import { cn } from '@/lib/utils';

export type ChipTone = 'cyan' | 'violet' | 'pale' | 'amber' | 'neutral';

const TONE_CLASSES: Record<ChipTone, string> = {
  cyan: 'border-accent/20 bg-accent-chip text-accent',
  violet: 'border-violet/20 bg-violet-chip text-violet',
  pale: 'border-pale/20 bg-pale-chip text-pale',
  amber: 'border-amber/20 bg-amber-chip text-amber',
  neutral: 'border-border bg-bg-elevated text-fg-muted',
};

export function Chip({
  children,
  tone = 'cyan',
  className,
}: {
  children: React.ReactNode;
  tone?: ChipTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill border px-3 py-1 text-2xs font-medium tracking-tight',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Stable tone mapping for genres. The same genre should always render
 * in the same color across the app — this keeps visual identity
 * consistent when a user sees "jungle" on the feed and then on the
 * event detail screen. Unknown genres fall back to cyan.
 */
const GENRE_TONE_MAP: Record<string, ChipTone> = {
  // cyan — the brand's primary accent, goes to the "core" dance genres
  techno: 'cyan',
  house: 'cyan',
  'deep-house': 'cyan',
  minimal: 'cyan',

  // violet — heavier / rave-adjacent
  jungle: 'violet',
  'drum-and-bass': 'violet',
  'drum-n-bass': 'violet',
  'uk-bass': 'violet',
  dubstep: 'violet',
  breakcore: 'violet',
  hardcore: 'violet',

  // pale blue — mellower / ambient
  ambient: 'pale',
  downtempo: 'pale',
  breakbeat: 'pale',
  ukg: 'pale',
  garage: 'pale',
  electro: 'pale',

  // amber — disco / warm / retro
  disco: 'amber',
  'italo-disco': 'amber',
  funk: 'amber',
  boogie: 'amber',
};

export function toneForGenre(genre: string): ChipTone {
  return GENRE_TONE_MAP[genre.toLowerCase()] ?? 'cyan';
}
