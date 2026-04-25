'use client';

// Full lineup list for the event detail screen.
//
// Layout: headliner(s) render first with a larger cyan-glow avatar and
// a "Headliner" tag; supporting acts follow as a denser 2-column grid.
//
// Each artist row that has a Spotify or SoundCloud URL gets a play
// button; tapping it expands an inline iframe preview (Spotify artist
// player preferred, SoundCloud fallback). Only one preview is open at
// a time — tapping a second artist collapses the first.

import { useState } from 'react';
import { Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LineupArtist } from '@/lib/events';
import { initialsFor, avatarToneFor, AVATAR_BG } from '@/lib/avatars';

// ── embed helpers ────────────────────────────────────────────────────

function spotifyArtistId(spotifyUrl: string | null): string | null {
  if (!spotifyUrl) return null;
  const m = spotifyUrl.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/);
  return m?.[1] ?? null;
}

function embedUrl(artist: LineupArtist): string | null {
  const sid = spotifyArtistId(artist.spotify_url);
  if (sid) return `https://open.spotify.com/embed/artist/${sid}?utm_source=generator`;
  if (artist.soundcloud_url) {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(artist.soundcloud_url)}&color=%2300e5ff&auto_play=false&hide_related=true&show_comments=false&show_user=false&show_reposts=false&show_teaser=false`;
  }
  return null;
}

// ── sub-components ───────────────────────────────────────────────────

function PlayButton({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? 'Close preview' : 'Preview tracks'}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition',
        'border border-accent/30 bg-accent/10 text-accent',
        'hover:bg-accent/20 active:scale-95',
      )}
    >
      {open ? <X className="h-3.5 w-3.5" /> : <Play className="h-3 w-3 fill-accent" />}
    </button>
  );
}

function EmbedPanel({ url }: { url: string }) {
  const isSoundCloud = url.includes('soundcloud.com');
  return (
    <div className="mt-3 overflow-hidden rounded-xl">
      <iframe
        src={url}
        width="100%"
        height={isSoundCloud ? 166 : 352}
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
        className="block w-full border-0"
      />
    </div>
  );
}

// ── main component ───────────────────────────────────────────────────

export function LineupList({ lineup }: { lineup: LineupArtist[] }) {
  const [activeArtist, setActiveArtist] = useState<string | null>(null);

  if (lineup.length === 0) return null;

  function toggleArtist(name: string) {
    setActiveArtist((prev) => (prev === name ? null : name));
  }

  const headliners = lineup.filter((a) => a.is_headliner);
  const supporting = lineup.filter((a) => !a.is_headliner);

  return (
    <div className="space-y-5">
      {headliners.length > 0 && (
        <div className="space-y-3">
          {headliners.map((artist) => {
            const url = embedUrl(artist);
            const open = activeArtist === artist.name;
            return (
              <div
                key={artist.name}
                className="curi-glass rounded-2xl p-4 shadow-card"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={cn(
                      'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border',
                      'bg-accent-chip text-accent font-display text-base font-semibold',
                      'ring-2 ring-accent/40 shadow-glow-sm',
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
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-base font-semibold text-fg-primary">
                      {artist.name}
                    </div>
                    <div className="mt-0.5 text-2xs uppercase tracking-widest text-accent">
                      Headliner
                    </div>
                  </div>
                  {url && <PlayButton open={open} onClick={() => toggleArtist(artist.name)} />}
                </div>
                {open && url && <EmbedPanel url={url} />}
              </div>
            );
          })}
        </div>
      )}

      {supporting.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          {supporting.map((artist) => {
            const tone = avatarToneFor(artist.name);
            const url = embedUrl(artist);
            const open = activeArtist === artist.name;
            return (
              <div key={artist.name} className={cn(url && open && 'col-span-2')}>
                <div className="flex items-center gap-3">
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
                  {url && <PlayButton open={open} onClick={() => toggleArtist(artist.name)} />}
                </div>
                {open && url && <EmbedPanel url={url} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
