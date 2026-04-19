// The glass event card used in the home feed and (later) Saved.
//
// Anatomy (top → bottom):
//   Hero      — image if available, else a genre-colored gradient backdrop
//   Meta row  — venue name · neighborhood · time
//   Title     — event title (display font, semibold)
//   Lineup    — up to 3 artists, "+N more" when clipped
//   Chips row — up to 3 genre chips
//
// The card is a <Link> so the whole surface is tappable. Press feedback
// is the standard active:scale-[0.98] from MASTER.md.

import Link from 'next/link';
import { Chip, toneForGenre } from '@/components/chip';
import { SaveButton } from '@/components/save-button';
import { timeLabel, formatPrice } from '@/lib/format';
import type { FeedEvent } from '@/lib/events';
import { cn } from '@/lib/utils';

// Deterministic gradient picker for image-less events. Picks based on
// the first genre so a jungle event always gets the violet gradient,
// techno always cyan, etc. — matches our chip tone map.
const GRADIENT_BY_GENRE: Record<string, string> = {
  techno: 'from-accent/30 via-accent/10 to-transparent',
  house: 'from-accent/30 via-accent/10 to-transparent',
  jungle: 'from-violet/30 via-violet/10 to-transparent',
  'drum-and-bass': 'from-violet/30 via-violet/10 to-transparent',
  dubstep: 'from-violet/30 via-violet/10 to-transparent',
  ambient: 'from-pale/30 via-pale/10 to-transparent',
  downtempo: 'from-pale/30 via-pale/10 to-transparent',
  disco: 'from-amber/30 via-amber/10 to-transparent',
};
const DEFAULT_GRADIENT = 'from-accent/25 via-accent/5 to-transparent';

function gradientFor(genres: string[]): string {
  for (const g of genres) {
    const hit = GRADIENT_BY_GENRE[g.toLowerCase()];
    if (hit) return hit;
  }
  return DEFAULT_GRADIENT;
}

export function EventCard({
  event,
  saved = false,
  signedIn = false,
}: {
  event: FeedEvent;
  /** Whether the viewer has this event in their saves. */
  saved?: boolean;
  /** Whether the viewer is signed in. Threaded in so the
   *  SaveButton can route unauth taps to /login instead of
   *  silently failing against RLS. */
  signedIn?: boolean;
}) {
  const price = formatPrice(event.price_min, event.price_max);
  const genres = event.genres.slice(0, 3);
  const lineup = event.lineup.slice(0, 3);
  const moreCount = Math.max(0, event.lineup.length - lineup.length);

  return (
    <Link
      href={`/events/${event.id}`}
      className={cn(
        'curi-glass block overflow-hidden rounded-2xl shadow-card',
        'transition duration-micro ease-expo active:scale-[0.98]',
      )}
    >
      {/* Hero */}
      <div className="relative aspect-[5/3] w-full overflow-hidden">
        {event.image_url ? (
          // Raw <img> for now; Phase 3.7 will introduce next/image with
          // the remotePatterns allowlist once we've catalogued the image
          // CDNs our scrapers actually return.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.image_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className={cn(
              'h-full w-full bg-gradient-to-br',
              gradientFor(event.genres),
            )}
          >
            <div className="flex h-full items-end p-5">
              <span className="font-display text-3xl font-semibold text-fg-primary/30 tracking-display">
                {event.genres[0] ?? 'curi'}
              </span>
            </div>
          </div>
        )}
        {/* Price pill — now top-LEFT to make room for the bookmark. */}
        {price && (
          <span className="absolute left-3 top-3 rounded-pill bg-bg-deep/80 px-2.5 py-1 text-2xs font-medium text-fg-primary backdrop-blur tabular">
            {price}
          </span>
        )}
        {/* Bookmark — top-right. Click handler stops propagation so
            tapping the bookmark doesn't navigate to the detail page. */}
        <div className="absolute right-3 top-3">
          <SaveButton
            eventId={event.id}
            initialSaved={saved}
            signedIn={signedIn}
            variant="hero"
            ariaLabel={event.title}
          />
        </div>
      </div>

      {/* Body */}
      <div className="space-y-2.5 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-2xs text-fg-muted tabular">
            <span className="truncate font-medium text-fg-primary">
              {event.venue?.name ?? 'TBA'}
            </span>
            {event.venue?.neighborhood && (
              <>
                <span className="text-fg-dim">·</span>
                <span className="truncate">{event.venue.neighborhood}</span>
              </>
            )}
          </div>
          <span className="shrink-0 text-2xs text-fg-muted tabular">
            {timeLabel(event.starts_at)}
          </span>
        </div>

        <h3 className="font-display text-lg font-semibold leading-tight tracking-display text-fg-primary">
          {event.title}
        </h3>

        {lineup.length > 0 && (
          <p className="text-sm text-fg-muted">
            {lineup.map((a) => a.name).join(' · ')}
            {moreCount > 0 && (
              <span className="text-fg-dim"> +{moreCount} more</span>
            )}
          </p>
        )}

        {genres.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {genres.map((g) => (
              <Chip key={g} tone={toneForGenre(g)}>
                {g}
              </Chip>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
