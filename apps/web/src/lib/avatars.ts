// Shared avatar helpers for artist lineup rendering.
//
// Extracted from `components/lineup-list.tsx` when `components/event-card.tsx`
// also started needing the same initials + deterministic-tone logic. Keeping
// this in one place means the same artist always yields the same initials
// string and the same tint tone across the feed card and the detail screen.
//
// No React deps here on purpose — these are pure helpers so they can be
// imported from both server and client components without dragging the
// React runtime into server bundles.

// First two non-whitespace graphemes from an artist name. We use
// Array.from so non-Latin names (e.g. "four tet" -> FT, or stylized
// names with emoji or CJK chars) yield sensible initials rather than
// splitting in the middle of a surrogate pair.
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    return Array.from(words[0]!).slice(0, 2).join('').toUpperCase();
  }
  return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}

// Brand tones we rotate through for initials-only avatars so a lineup
// of 8 artists doesn't read as 8 identical gray circles.
export const AVATAR_TONES = ['cyan', 'violet', 'pale', 'amber'] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

// Cheap deterministic hash — good enough for bucketing names into four
// tones. Not cryptographic; don't use for anything that matters.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Keyed on the lowercased name so casing drift between data sources
// (e.g. "Four Tet" vs "four tet") still lands on the same tint.
export function avatarToneFor(name: string): AvatarTone {
  return AVATAR_TONES[hashString(name.toLowerCase()) % AVATAR_TONES.length]!;
}

// Tailwind class bundles per tone. Chip-bg for fill, matching text, and
// a low-alpha border so the circle reads against both light and dark
// surfaces in the app.
export const AVATAR_BG: Record<AvatarTone, string> = {
  cyan: 'bg-accent-chip text-accent border-accent/30',
  violet: 'bg-violet-chip text-violet border-violet/30',
  pale: 'bg-pale-chip text-pale border-pale/30',
  amber: 'bg-amber-chip text-amber border-amber/30',
};
