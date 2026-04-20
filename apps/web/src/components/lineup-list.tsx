// Full lineup list for the event detail screen.
//
// Layout: headliner(s) render first with a larger cyan-glow avatar and
// a "Headliner" tag; supporting acts follow as a denser 2-column grid.
//
// Avatar strategy: when Phase 4f enrichment has landed a Spotify image
// for the artist we render it inside the existing circle. When it
// hasn't (either the backfill hasn't reached this artist yet, or the
// artist had no confident Spotify match), we fall back to deterministic
// tinted initials. This means the screen works gracefully at every
// stage of the rolling backfill — no broken image icons, no empty
// circles.

import { cn } from '@/lib/utils';
import type { LineupArtist } from '@/lib/events';
import { initialsFor, avatarToneFor, AVATAR_BG } from '@/lib/avatars';

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
                  'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border',
                  'bg-accent-chip text-accent font-display text-base font-semibold',
                  // Headliner gets the cyan outer glow to set it apart
                  // from supporting acts without needing a separate label.
                  'ring-2 ring-accent/40 shadow-glow-sm',
                )}
              >
                {artist.image_url ? (
                  // Raw <img> matches the EventCard hero pattern — avoids
                  // having to maintain a remotePatterns allowlist for
                  // i.scdn.co (Spotify CDN).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={artist.image_url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  initialsFor(artist.name)
                )}
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
                    'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border',
                    'font-display text-xs font-semibold',
                    AVATAR_BG[tone],
                  )}
                >
                  {artist.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={artist.image_url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    initialsFor(artist.name)
                  )}
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
