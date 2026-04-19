// Full lineup list for the event detail screen.
//
// Layout: headliner(s) render first with a larger cyan-glow avatar and
// a "Headliner" tag; supporting acts follow as a denser grid. We use
// initials rather than a real image — our `artists` table doesn't
// store photos, and scraping them reliably per-artist is a Phase 4
// problem, not Phase 3.

import { cn } from '@/lib/utils';
import type { LineupArtist } from '@/lib/events';

// First two non-whitespace graphemes from an artist name. We use
// Array.from so non-Latin names (e.g. four-hero -> FH, or stylized
// names with emoji or CJK chars) yield sensible initials rather than
// split in the middle of a surrogate pair.
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    return Array.from(words[0]!).slice(0, 2).join('').toUpperCase();
  }
  return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}

// Deterministic tint for supporting-act avatars so a lineup of 8
// artists doesn't read as 8 identical gray circles. We rotate through
// the four brand tones — keyed on the artist name so the same name
// always lands on the same tint across the app.
const AVATAR_TONES = ['cyan', 'violet', 'pale', 'amber'] as const;
type AvatarTone = (typeof AVATAR_TONES)[number];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function avatarToneFor(name: string): AvatarTone {
  return AVATAR_TONES[hashString(name.toLowerCase()) % AVATAR_TONES.length]!;
}

const AVATAR_BG: Record<AvatarTone, string> = {
  cyan: 'bg-accent-chip text-accent border-accent/30',
  violet: 'bg-violet-chip text-violet border-violet/30',
  pale: 'bg-pale-chip text-pale border-pale/30',
  amber: 'bg-amber-chip text-amber border-amber/30',
};

export function LineupList({ lineup }: { lineup: LineupArtist[] }) {
  if (lineup.length === 0) return null;

  const headliners = lineup.filter((a) => a.is_headliner);
  const supporting = lineup.filter((a) => !a.is_headliner);

  return (
    <div className="space-y-5">
      {headliners.length > 0 && (
        <div className="space-y-3">
          {headliners.map((artist) => (
            <div
              key={artist.name}
              className="flex items-center gap-4 curi-glass rounded-2xl p-4 shadow-card"
            >
              <div
                className={cn(
                  'flex h-14 w-14 shrink-0 items-center justify-center rounded-full border',
                  'bg-accent-chip text-accent font-display text-base font-semibold',
                  // Headliner gets the cyan outer glow to set it apart
                  // from supporting acts without needing a separate label.
                  'ring-2 ring-accent/40 shadow-glow-sm',
                )}
              >
                {initialsFor(artist.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-base font-semibold text-fg-primary">
                  {artist.name}
                </div>
                <div className="mt-0.5 text-2xs uppercase tracking-widest text-accent">
                  Headliner
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {supporting.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          {supporting.map((artist) => {
            const tone = avatarToneFor(artist.name);
            return (
              <div key={artist.name} className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border',
                    'font-display text-xs font-semibold',
                    AVATAR_BG[tone],
                  )}
                >
                  {initialsFor(artist.name)}
                </div>
                <div className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                  {artist.name}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
