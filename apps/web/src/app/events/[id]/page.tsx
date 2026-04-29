// Event detail — the full single-event screen.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { Chip, toneForGenre } from '@/components/chip';
import { LineupList } from '@/components/lineup-list';
import { LocationCard } from '@/components/location-card';
import { SaveButton } from '@/components/save-button';
import { getEventById } from '@/lib/events';
import { isEventSaved } from '@/lib/saves';
import {
  getUserFollowedSoundcloudUsernames,
  getUserFollowedSpotifyArtistIds,
} from '@/lib/follows';
import { createClient } from '@/lib/supabase/server';
import { timeLabel, formatPrice, groupLabel, nycDayKey } from '@/lib/format';
import { resolveHero } from '@/lib/hero-image';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

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

  const supabase = createClient();
  const [
    savedForViewer,
    followedScUsernames,
    followedSpotifyArtistIds,
    {
      data: { user },
    },
  ] = await Promise.all([
    isEventSaved(params.id),
    getUserFollowedSoundcloudUsernames(),
    getUserFollowedSpotifyArtistIds(),
    supabase.auth.getUser(),
  ]);
  const signedIn = !!user;
  const followedScUsernameSet = new Set(followedScUsernames);
  const followedSpotifyArtistIdSet = new Set(followedSpotifyArtistIds);

  const price = formatPrice(event.price_min, event.price_max);
  const day = groupLabel(nycDayKey(event.starts_at));
  const hero = resolveHero(event);

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

        <section className="mt-6 animate-enter-up">
          <div className="relative aspect-[5/3] w-full overflow-hidden rounded-2xl shadow-card">
            {hero.kind !== 'none' ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={hero.url}
                  alt=""
                  loading="eager"
                  className={cn(
                    'h-full w-full object-cover',
                    hero.kind === 'artist' && 'object-top',
                  )}
                />
                {hero.kind !== 'event' && (
                  <>
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-bg-deep/70 to-transparent"
                    />
                    <span className="absolute bottom-3 left-3 rounded-pill bg-bg-deep/70 px-2.5 py-1 text-2xs font-medium uppercase tracking-widest text-fg-primary/90 backdrop-blur">
                      {hero.kind === 'artist' ? 'Featuring' : 'Venue'}
                    </span>
                  </>
                )}
              </>
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

          <div className="pt-2">
            <SaveButton
              eventId={event.id}
              initialSaved={savedForViewer}
              signedIn={signedIn}
              variant="inline"
              ariaLabel={event.title}
            />
          </div>
        </section>

        {event.lineup.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              Lineup
            </h2>
            <LineupList
              lineup={event.lineup}
              followedSoundcloudUsernames={followedScUsernameSet}
              followedSpotifyArtistIds={followedSpotifyArtistIdSet}
            />
          </section>
        )}

        {event.description && (
          <section className="mt-10">
            <h2 className="mb-3 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              About
            </h2>
            <div className="curi-glass rounded-2xl p-5 shadow-card">
              <p className="whitespace-pre-line text-sm leading-relaxed text-fg-muted">
                {event.description}
              </p>
            </div>
          </section>
        )}

        {event.venue && (
          <section className="mt-10">
            <h2 className="mb-3 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              Location
            </h2>
            <LocationCard venue={event.venue} />
          </section>
        )}

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
