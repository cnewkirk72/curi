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
import { getUpcomingEvents, type FeedEvent } from '@/lib/events';
import { getSavedEventIds } from '@/lib/saves';
import { createClient } from '@/lib/supabase/server';
import { nycDayKey, groupLabel } from '@/lib/format';
import {
  hasActiveFilters,
  parseFilters,
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

  return (
    <div className="relative min-h-dvh">
      <main className="relative mx-auto max-w-[430px] px-5 pb-28 pt-10">
        {/* Ambient blobs — lighter than the login screen because the
            feed content itself provides visual weight. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 top-0 h-64 w-64 rounded-full bg-accent/15 blur-3xl animate-blob"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 top-40 h-64 w-64 rounded-full bg-violet/15 blur-3xl animate-blob"
          style={{ animationDelay: '8s' }}
        />

        <AppHeader />

        {/* Hero title — adapts to the active date filter so the feed's
            framing stays honest when a user has narrowed the window. */}
        <section className="relative mt-4 mb-6 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            {filters.when === 'all' ? 'Upcoming in NYC' : `${labelForWhen(filters.when)} in NYC`}
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display">
            {active ? 'Filtered feed' : 'The feed, end to end'}
          </h2>
        </section>

        {/* Filter bar — shows the "Filter" pill + active chips + Clear */}
        <div className="relative mb-8">
          <FilterBar />
        </div>

        {groups.length === 0 ? (
          <EmptyState filtered={active} />
        ) : (
          <Feed groups={groups} savedIds={savedIds} signedIn={signedIn} />
        )}
      </main>

      <BottomNav />
    </div>
  );
}

// ─── Feed rendering ───────────────────────────────────────────────────

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
          <div className="space-y-4">
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
