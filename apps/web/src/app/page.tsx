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
import { EventCard } from '@/components/event-card';
import { FilterBar } from '@/components/filter-bar';
import { DesktopTopNav } from '@/components/desktop/desktop-top-nav';
import { DesktopSidebarFilters } from '@/components/desktop/desktop-sidebar-filters';
import { getUpcomingEvents, type FeedEvent } from '@/lib/events';
import { getSavedEventIds } from '@/lib/saves';
import { createClient } from '@/lib/supabase/server';
import { nycDayKey, groupLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  hasActiveFilters,
  parseFilters,
  labelForDateRange,
  labelForWhen,
} from '@/lib/filters';

// Re-fetch on each request during Phase 3. We'll revisit caching
// (e.g. `revalidate: 60`) in Phase 3.12 once we see production
// traffic patterns. Dynamic rendering also means searchParams
// changes trigger a fresh fetch rather than a stale cached page.
export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

// Next passes `searchParams` into page components as a plain object,
// not a URLSearchParams. Build a `get()`-shaped adapter so
// parseFilters can consume it without caring which side it's on.
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

  // Fire the three reads in parallel — they don't depend on each
  // other. Auth + saved-ids both fail soft for anon viewers (RLS
  // returns [] rather than 403), so the `signedIn` check is the
  // canonical "show saved state?" predicate.
  const supabase = createClient();
  const [events, savedIds, {
    data: { user },
  }] = await Promise.all([
    getUpcomingEvents({ limit: 80, filters }),
    getSavedEventIds(),
    supabase.auth.getUser(),
  ]);

  const signedIn = !!user;
  const groups = groupByDay(events);
  const active = hasActiveFilters(filters);

  // Eyebrow label — drives the tiny uppercase caption above the
  // page title. Custom ranges get the formatted "Apr 25 – Apr 27"
  // treatment so the caption matches the chip.
  const whenLabel =
    filters.when === 'all'
      ? 'Upcoming in NYC'
      : `${labelForDateRange(filters) ?? labelForWhen(filters.when)} in NYC`;

  return (
    <div className="relative min-h-dvh">
      {/* Desktop-only sticky top nav. Self-gates with `hidden lg:block`
          via its own header element so mobile doesn't render the
          extra DOM. */}
      <div className="hidden lg:block">
        <DesktopTopNav />
      </div>

      <main
        className={cn(
          // Mobile: narrow iOS-safe column, same as before.
          'relative mx-auto max-w-[430px] px-5 pb-28 pt-10',
          // Desktop: widen to a 2-col grid container with sidebar on
          // the left and feed on the right. `pt-8` is tighter than
          // mobile since the DesktopTopNav already provides padding.
          'lg:grid lg:max-w-7xl lg:grid-cols-[260px_1fr] lg:gap-10 lg:px-8 lg:pb-16 lg:pt-10',
        )}
      >
        {/* Ambient blobs — only rendered on mobile. At desktop the
            sidebar + feed grid provides the visual weight; blobs
            behind a wide grid end up looking like browser-crop
            bugs. */}
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

        {/* Desktop sidebar — shown in the grid's first column at lg+.
            Keeps all filter state in the URL just like mobile. */}
        <div className="hidden lg:block">
          <DesktopSidebarFilters />
        </div>

        {/* Feed column ────────────────────────── */}
        <div className="min-w-0 lg:col-start-2">
          {/* Hero title — adapts to the active date filter so the
              feed's framing stays honest when a user has narrowed
              the window. */}
          <section className="relative mt-4 mb-6 animate-enter-up lg:mt-0 lg:mb-8">
            <p className="font-display text-2xs uppercase tracking-widest text-accent">
              {whenLabel}
            </p>
            <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display lg:text-3xl">
              {active ? 'Filtered feed' : 'The feed, end to end'}
            </h2>
          </section>

          {/* Mobile filter-bar — hidden at lg+ (sidebar takes over). */}
          <div className="relative mb-8 lg:hidden">
            <FilterBar />
          </div>

          {groups.length === 0 ? (
            <EmptyState filtered={active} />
          ) : (
            <Feed groups={groups} savedIds={savedIds} signedIn={signedIn} />
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}

// ─── Feed rendering ─────────────────────────────────

type DayGroup = { dayKey: string; events: FeedEvent[] };

function groupByDay(events: FeedEvent[]): DayGroup[] {
  const buckets = new Map<string, FeedEvent[]>();
  for (const ev of events) {
    const key = nycDayKey(ev.starts_at);
    const list = buckets.get(key);
    if (list) list.push(ev);
    else buckets.set(key, [ev]);
  }
  // Keys are ISO-day strings, so lexical sort == chronological sort.
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dayKey, events]) => ({ dayKey, events }));
}

function Feed({
  groups,
  savedIds,
  signedIn,
}: {
  groups: DayGroup[];
  savedIds: Set<string>;
  signedIn: boolean;
}) {
  return (
    <div className="relative space-y-10">
      {groups.map(({ dayKey, events }) => (
        <section key={dayKey} aria-labelledby={`group-${dayKey}`}>
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              id={`group-${dayKey}`}
              className="font-display text-xs font-medium uppercase tracking-widest text-fg-muted"
            >
              {groupLabel(dayKey)}
            </h3>
            <span className="text-2xs text-fg-dim tabular">
              {events.length} {events.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          {/* Mobile: stacked vertical list. Desktop: responsive grid.
              We lean on the card's aspect-ratio hero to keep rows
              aligned across differently-sized titles/lineups. */}
          <div
            className={cn(
              'space-y-4',
              'lg:grid lg:grid-cols-2 lg:gap-5 lg:space-y-0',
              'xl:grid-cols-3',
            )}
          >
            {events.map((ev) => (
              <EventCard
                key={ev.id}
                event={ev}
                saved={savedIds.has(ev.id)}
                signedIn={signedIn}
              />
            ))}
          </div>
        </section>
      ))}
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
