// Home feed. Server component — fetches upcoming events via the
// server-side Supabase client (RLS applies; anon readers see the
// public feed). Events are grouped by NYC calendar day.
//
// Filters (genre / vibe / date) live in the URL search params —
// `parseFilters(searchParams)` produces the FilterState we hand to
// both the server-side fetcher (so filtering happens in Postgres,
// not in the browser) and the client-side FilterBar (so the chips
// reflect the same state without a prop-drill).

import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { FilterBar } from '@/components/filter-bar';
import { DesktopTopNav } from '@/components/desktop/desktop-top-nav';
import { DesktopSidebarFilters } from '@/components/desktop/desktop-sidebar-filters';
import { DesktopActiveSearchChip } from '@/components/desktop/desktop-active-search-chip';
import { InfiniteFeed } from '@/components/infinite-feed';
import { getUpcomingEvents } from '@/lib/events';
import { getSavedEventIds } from '@/lib/saves';
import {
  getUserFollowedSoundcloudUsernames,
  getFollowedEventsInWindow,
  getUserFollowedSpotifyArtistIds,
  getFollowedSpotifyEventsInWindow,
} from '@/lib/follows';
import { getUserPrefs } from '@/lib/preferences';
import { getActiveSearchLabels } from '@/lib/active-search-labels';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import {
  hasActiveFilters,
  parseFilters,
  serializeFilters,
  labelForDateRange,
  labelForWhen,
} from '@/lib/filters';
import { GlobalSearch } from '@/components/global-search';

const INITIAL_PAGE_SIZE = 100;

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function searchParamsAdapter(sp: SearchParams): { get(key: string): string | null } {
  return {
    get(key: string) {
      const v = sp[key];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    },
  };
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const filters = parseFilters(searchParamsAdapter(searchParams));

  const supabase = createClient();
  const [followedScUsernames, followedSpotifyArtistIds] = await Promise.all([
    getUserFollowedSoundcloudUsernames(),
    getUserFollowedSpotifyArtistIds(),
  ]);
  const [
    events,
    followedScExtras,
    followedSpotifyExtras,
    savedIds,
    prefs,
    {
      data: { user },
    },
    searchLabels,
  ] = await Promise.all([
    getUpcomingEvents({ limit: INITIAL_PAGE_SIZE, filters }),
    getFollowedEventsInWindow(filters, followedScUsernames),
    getFollowedSpotifyEventsInWindow(filters, followedSpotifyArtistIds),
    getSavedEventIds(),
    getUserPrefs(),
    supabase.auth.getUser(),
    getActiveSearchLabels(filters.artist, filters.venue),
  ]);

  const signedIn = !!user;
  const sidebarPrefs = signedIn
    ? { genres: prefs.preferred_genres, vibes: prefs.preferred_vibes }
    : undefined;
  const active = hasActiveFilters(filters);
  const feedKey = serializeFilters(filters) || 'all';

  const whenLabel =
    filters.when === 'all'
      ? 'Upcoming in NYC'
      : `${labelForDateRange(filters) ?? labelForWhen(filters.when)} in NYC`;

  return (
    <div className="relative min-h-dvh">
      <DesktopTopNav />

      <main
        className={cn(
          'relative mx-auto max-w-[430px] px-5 pb-28 pt-10',
          'lg:grid lg:max-w-7xl lg:grid-cols-[260px_1fr] lg:gap-10 lg:px-8 lg:pb-16 lg:pt-[86px]',
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 top-0 h-64 w-64 rounded-full bg-accent/15 blur-3xl animate-blob lg:hidden"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 top-40 h-64 w-64 rounded-full bg-violet/15 blur-3xl animate-blob lg:hidden"
          style={{ animationDelay: '8s' }}
        />

        <AppHeader />

        <div className="mb-4 lg:hidden">
          <GlobalSearch />
        </div>

        <div className="hidden lg:block">
          <DesktopSidebarFilters userPrefs={sidebarPrefs} />
        </div>

        <div className="min-w-0 lg:col-start-2">
          <section className="relative mt-4 mb-6 animate-enter-up lg:mt-0 lg:mb-8">
            <p className="font-display text-2xs uppercase tracking-widest text-accent">
              {whenLabel}
            </p>
            <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display lg:text-3xl">
              {active ? 'Filtered feed' : 'The feed, end to end'}
            </h2>
          </section>

          <div className="hidden lg:block">
            <DesktopActiveSearchChip
              artistLabel={searchLabels.artist?.name ?? null}
              venueLabel={searchLabels.venue?.name ?? null}
            />
          </div>

          <div className="relative mb-8 lg:hidden">
            <FilterBar
              userPrefs={sidebarPrefs}
              artistLabel={searchLabels.artist?.name ?? null}
              venueLabel={searchLabels.venue?.name ?? null}
            />
          </div>

          {events.length === 0 &&
          followedScExtras.length === 0 &&
          followedSpotifyExtras.length === 0 ? (
            <EmptyState filtered={active} />
          ) : (
            <InfiniteFeed
              key={feedKey}
              initialEvents={events}
              initialFollowedScExtras={followedScExtras}
              initialFollowedSpotifyExtras={followedSpotifyExtras}
              initialHasMore={events.length === INITIAL_PAGE_SIZE}
              filters={filters}
              savedIds={[...savedIds]}
              followedSoundcloudUsernames={followedScUsernames}
              followedSpotifyArtistIds={followedSpotifyArtistIds}
              preferredGenres={prefs.preferred_genres}
              signedIn={signedIn}
            />
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <div className="curi-glass rounded-2xl p-8 text-center shadow-card">
        <p className="font-display text-lg font-semibold text-fg-primary">
          No matches.
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          Nothing in the feed fits those filters right now. Try widening the
          date range or picking fewer genres — then we&apos;ll see what&apos;s out
          there.
        </p>
      </div>
    );
  }
  return (
    <div className="curi-glass rounded-2xl p-8 text-center shadow-card">
      <p className="font-display text-lg font-semibold text-fg-primary">
        No events yet.
      </p>
      <p className="mt-2 text-sm text-fg-muted">
        The Railway scrapers run nightly at 10 UTC. Check back in the morning —
        or trigger a manual ingest to populate the feed now.
      </p>
    </div>
  );
}
