// Event detail — the full single-event screen.
//
// Stack (top → bottom):
//   Back link
//   Hero image (or genre gradient fallback) + floating price pill
//   Meta strip          day · time
//   Title
//   Venue meta line     name · neighborhood
//   Genre chips         full list (not truncated like the card)
//   Lineup              headliners + supporting, via <LineupList />
//   Description         prose block, only if present
//   Location card       venue info + "Open in Maps" CTA
//   Get tickets CTA     pill button, in flow, only if ticket_url set
//
// Everything is `force-dynamic` because RLS evaluates per-request — a
// future "signed-in-only" event row should reflect the viewer without
// stale CDN caching.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { Chip, toneForGenre } from '@/components/chip';
import { LineupList } from '@/components/lineup-list';
import { LocationCard } from '@/components/location-card';
import { getEventById } from '@/lib/events';
import { timeLabel, formatPrice, groupLabel, nycDayKey } from '@/lib/format';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

// Same deterministic fallback palette as the feed EventCard — keep
// these in sync if you tweak one. (We'd lift into a shared helper
// once it's used in a third place.)
const GRADIENT_BY_GENRE: Record<string, string> = {
  techno: 'from-accent/35 via-accent/10 to-transparent',
  house: 'from-accent/35 via-accent/10 to-transparent',
  jungle: 'from-violet/35 via-violet/10 to-transparent',
  'drum-and-bass': 'from-violet/35 via-violet/10 to-transparent',
  dubstep: 'from-violet/35 via-violet/10 to-transparent',
  ambient: 'from-pale/35 via-pale/10 to-transparent',
  downtempo: 'from-pale/35 via-pale/10 to-transparent',
  disco: 'from-amber/35 via-amber/10 to-transparent',
};
const DEFAULT_GRADIENT = 'from-accent/25 via-accent/5 to-transparent';
function gradientFor(genres: string[]): string {
  for (const g of genres) {
    const hit = GRADIENT_BY_GENRE[g.toLowerCase()];
    if (hit) return hit;
  }
  return DEFAULT_GRADIENT;
}

export default async function EventDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const event = await getEventById(params.id);
  if (!event) notFound();

  const price = formatPrice(event.price_min, event.price_max);
  const day = groupLabel(nycDayKey(event.starts_at));

  return (
    <div className="relative min-h-dvh">
      <main className="relative mx-auto max-w-[430px] px-5 pb-28 pt-10">
        <AppHeader />

        <Link
          href="/"
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-fg-muted transition hover:text-fg-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to feed
        </Link>

        {/* ── Hero ──────────────────────────────────────────────── */}
        <section className="mt-6 animate-enter-up">
          <div className="relative aspect-[5/3] w-full overflow-hidden rounded-2xl shadow-card">
            {event.image_url ? (
              // Raw <img> — next/image requires a remotePatterns allowlist
              // for every CDN our scrapers might return, and we haven't
              // catalogued those yet. Loaded eagerly since it's the LCP
              // element for this route.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={event.image_url}
                alt=""
                loading="eager"
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                className={cn(
                  'h-full w-full bg-gradient-to-br',
                  gradientFor(event.genres),
                )}
              >
                <div className="flex h-full items-end p-6">
                  <span className="font-display text-4xl font-semibold text-fg-primary/25 tracking-display">
                    {event.genres[0] ?? 'curi'}
                  </span>
                </div>
              </div>
            )}

            {price && (
              <span className="absolute right-3 top-3 rounded-pill bg-bg-deep/80 px-3 py-1 text-xs font-medium text-fg-primary backdrop-blur tabular">
                {price}
              </span>
            )}
          </div>
        </section>

        {/* ── Meta + title ──────────────────────────────────────── */}
        <section className="mt-6 space-y-3">
          <div className="text-2xs uppercase tracking-widest text-fg-muted tabular">
            {day} · {timeLabel(event.starts_at)}
          </div>
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-display text-fg-primary">
            {event.title}
          </h1>
          {event.venue && (
            <div className="text-sm text-fg-muted">
              <span className="text-fg-primary">{event.venue.name}</span>
              {event.venue.neighborhood && (
                <>
                  <span className="mx-1.5 text-fg-dim">·</span>
                  <span>{event.venue.neighborhood}</span>
                </>
              )}
            </div>
          )}

          {event.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {event.genres.map((g) => (
                <Chip key={g} tone={toneForGenre(g)}>
                  {g}
                </Chip>
              ))}
            </div>
          )}
        </section>

        {/* ── Lineup ────────────────────────────────────────────── */}
        {event.lineup.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              Lineup
            </h2>
            <LineupList lineup={event.lineup} />
          </section>
        )}

        {/* ── Description ───────────────────────────────────────── */}
        {event.description && (
          <section className="mt-10">
            <h2 className="mb-3 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              About
            </h2>
            <div className="curi-glass rounded-2xl p-5 shadow-card">
              {/* whitespace-pre-line so scraped descriptions that
                  preserve \n paragraph breaks render as paragraphs,
                  without us having to run a markdown parser. */}
              <p className="whitespace-pre-line text-sm leading-relaxed text-fg-muted">
                {event.description}
              </p>
            </div>
          </section>
        )}

        {/* ── Location ──────────────────────────────────────────── */}
        {event.venue && (
          <section className="mt-10">
            <h2 className="mb-3 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              Location
            </h2>
            <LocationCard venue={event.venue} />
          </section>
        )}

        {/* ── Ticket CTA ────────────────────────────────────────── */}
        {event.ticket_url && (
          <a
            href={event.ticket_url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'mt-10 inline-flex w-full items-center justify-center gap-2',
              'rounded-pill bg-accent px-6 py-3.5 font-display text-sm font-semibold text-bg-deep',
              'shadow-glow transition duration-micro ease-expo',
              'hover:bg-accent-hover active:scale-[0.97]',
            )}
          >
            Get tickets
            <ArrowUpRight className="h-4 w-4" />
          </a>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
