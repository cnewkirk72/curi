// Home feed. Server component — fetches upcoming events via the
// server-side Supabase client (RLS applies; anon readers see the
// public feed). Events are grouped by NYC calendar day.

import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { EventCard } from '@/components/event-card';
import { getUpcomingEvents, type FeedEvent } from '@/lib/events';
import { nycDayKey, groupLabel } from '@/lib/format';

// Re-fetch on each request during Phase 3. We'll revisit caching
// (e.g. `revalidate: 60` or `dynamic: force-dynamic`) in Phase 3.12
// once we see the production traffic shape.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const events = await getUpcomingEvents({ limit: 80 });
  const groups = groupByDay(events);

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

        {/* Hero title — short, frames the list rather than dominating it */}
        <section className="relative mt-4 mb-8 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            Tonight in NYC
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display">
            The feed, end to end
          </h2>
        </section>

        {groups.length === 0 ? <EmptyState /> : <Feed groups={groups} />}
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

function Feed({ groups }: { groups: DayGroup[] }) {
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
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function EmptyState() {
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
