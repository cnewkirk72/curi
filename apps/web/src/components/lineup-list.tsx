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
//
// Phase 5.6.6 — accepts an optional `followedSoundcloudUsernames` Set.
// Any artist whose `soundcloud_username` is in the set gets a small
// amber presence dot at the bottom-right of their avatar — same
// indicator vocabulary as the EventCard avatar dot and the
// ConnectedSummary on /profile, so the SC-follow signal reads
// consistently across the app. Anon viewers and signed-in users who
// haven't connected SC pass undefined or empty Set; no dots render.

import { useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LineupArtist } from '@/lib/events';
import { initialsFor, avatarToneFor, AVATAR_BG } from '@/lib/avatars';

// ── embed helpers ─────────────────────────────────────────────────

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

// ── sub-components ────────────────────────────────────────────────

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
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
        loading="lazy"
        className="block w-full border-0"
      />
    </div>
  );
}

// ── main component ───────────────────────────────────────────────

export function LineupList({
  lineup,
  followedSoundcloudUsernames,
}: {
  lineup: LineupArtist[];
  /** Phase 5.6.6 — lowercased SoundCloud usernames the signed-in user
   *  follows. Same array-on-the-wire / Set-in-the-component pattern as
   *  EventCard receives it. Undefined or empty Set → no follow dots
   *  render (anon viewers + signed-in-but-not-SC-connected). */
  followedSoundcloudUsernames?: Set<string>;
}) {
  const [activeArtist, setActiveArtist] = useState<string | null>(null);
  // Track artist names whose <img> failed to load. SC's i1.sndcdn.com
  // and BC's f4.bcbits.com URLs are hot-linked (no Supabase Storage
  // mirror) so a missing file → broken icon. Add to the set on error
  // and re-render with the initials fallback. Per-artist set so one
  // bad URL doesn't blank out the whole lineup.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());

  // Phase 5.6.6 — pre-compute "any follows at all?" once per render so
  // the per-row check below short-circuits on anon paths without
  // touching the Set on every iteration. Memoize so a parent re-render
  // with a stable Set ref doesn't recompute.
  const hasFollows = useMemo(
    () =>
      !!followedSoundcloudUsernames && followedSoundcloudUsernames.size > 0,
    [followedSoundcloudUsernames],
  );

  if (lineup.length === 0) return null;

  function toggleArtist(name: string) {
    setActiveArtist((prev) => (prev === name ? null : name));
  }

  function markBroken(name: string) {
    setBrokenImages((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  }

  // Per-row predicate. Hoisted so both the headliner branch and the
  // supporting-grid branch share the same check without re-typing the
  // null-guards. Inline-able if the prop ever becomes required.
  function isFollowed(artist: LineupArtist): boolean {
    return (
      hasFollows &&
      !!artist.soundcloud_username &&
      followedSoundcloudUsernames!.has(artist.soundcloud_username)
    );
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
                  {/* Avatar wrapper — `relative` so the follow-dot can
                      absolute-position outside the avatar's
                      `overflow-hidden` clip without disturbing the
                      flex-row layout. The wrapper still occupies the
                      14×14 footprint so the gap-4 between avatar and
                      name stays consistent. */}
                  <div className="relative shrink-0">
                    <div
                      className={cn(
                        'flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border',
                        'bg-accent-chip text-accent font-display text-base font-semibold',
                        'ring-2 ring-accent/40 shadow-glow-sm',
                      )}
                    >
                      {artist.image_url && !brokenImages.has(artist.name) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={artist.image_url}
                          alt=""
                          loading="lazy"
                          onError={() => markBroken(artist.name)}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        initialsFor(artist.name)
                      )}
                    </div>
                    {isFollowed(artist) && (
                      <span
                        role="img"
                        aria-label={`You follow ${artist.name}`}
                        className={cn(
                          'pointer-events-none absolute bottom-0 right-0',
                          // Phase 5.6.6 — same amber follow-dot
                          // vocabulary as the EventCard avatar dot
                          // and the ConnectedSummary indicator. Sized
                          // 2.5×2.5 (vs EventCard's 2×2) so the dot
                          // stays visually proportional on the larger
                          // 14×14 headliner avatar without becoming a
                          // smudge.
                          'h-2.5 w-2.5 rounded-full bg-amber',
                          // Inset ring matches the card surface
                          // (curi-glass over bg-base) so the dot
                          // reads as separated from the avatar even
                          // on busy photo backgrounds.
                          'ring-2 ring-bg-base',
                          'shadow-glow-amber-sm',
                        )}
                      />
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
                  {/* Avatar wrapper for the follow-dot positioning —
                      same pattern as the headliner branch above. */}
                  <div className="relative shrink-0">
                    <div
                      className={cn(
                        'flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border',
                        'font-display text-xs font-semibold',
                        AVATAR_BG[tone],
                      )}
                    >
                      {artist.image_url && !brokenImages.has(artist.name) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={artist.image_url}
                          alt=""
                          loading="lazy"
                          onError={() => markBroken(artist.name)}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        initialsFor(artist.name)
                      )}
                    </div>
                    {isFollowed(artist) && (
                      <span
                        role="img"
                        aria-label={`You follow ${artist.name}`}
                        className={cn(
                          'pointer-events-none absolute -bottom-0.5 -right-0.5',
                          // Phase 5.6.6 — same dot vocabulary as the
                          // headliner branch and the EventCard. 2×2
                          // matches the EventCard's lineup-cluster
                          // dot since the supporting-act avatar is
                          // 10×10 (vs the 6×6 cluster avatars on the
                          // card; the 10×10 supports the same dot
                          // without needing scaling).
                          'h-2 w-2 rounded-full bg-amber',
                          'ring-2 ring-bg-base',
                          'shadow-glow-amber-sm',
                        )}
                      />
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
