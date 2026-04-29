'use client';

// Client-side feed wrapper that adds infinite scroll on top of the
// server-rendered initial batch. The home page (`app/page.tsx`) does
// the first `getUpcomingEvents` fetch during SSR and hands the result
// in as `initialEvents`; this component takes it from there — an
// IntersectionObserver on a sentinel <div> at the bottom triggers
// the `loadMoreEvents` server action, which appends the next page.
//
// Filter changes are expected to remount this component via a `key`
// bound to the serialized filter state — that way we don't have to
// reconcile an in-flight "load more" against a URL change the user
// just performed. Parent owns the cache-bust; we just append.
//
// Types come from `events.ts` via `import type { ... }`, which is
// erased at compile time — so this client module never pulls the
// server-only supabase client into the bundle. `enrichmentScore`
// lives in the separate `lib/enrichment.ts` (also server-free) for
// the same reason.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { EventCard } from '@/components/event-card';
import { nycDayKey, groupLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FeedCursor, FeedEvent } from '@/lib/events';
import { enrichmentScore } from '@/lib/enrichment';
import type { FilterState } from '@/lib/filters';
import { loadMoreEvents } from '@/app/actions/load-more-events';

type Props = {
  initialEvents: FeedEvent[];
  initialHasMore: boolean;
  filters: FilterState;
  /** Serialized on the server to dodge Set serialization — we rebuild
   * the Set here with useMemo. */
  savedIds: string[];
  /** Phase 5.6 — lowercased SoundCloud usernames the signed-in user
   * follows. Same array-on-the-wire / Set-in-the-component pattern
   * as `savedIds`. Empty array for anon viewers and for signed-in
   * users who haven't connected SoundCloud yet, which short-circuits
   * the boost path in `enrichmentScore` to the pre-Phase-5.6 sort.
   * Stays static for the lifetime of this component instance — the
   * server fetches it once at page-load and we don't refresh on
   * pagination (load-more-events doesn't need it; the boost is
   * applied client-side from this prop). */
  followedSoundcloudUsernames: string[];
  signedIn: boolean;
};

type DayGroup = { dayKey: string; events: FeedEvent[] };

export function InfiniteFeed({
  initialEvents,
  initialHasMore,
  filters,
  savedIds,
  followedSoundcloudUsernames,
  signedIn,
}: Props) {
  const [events, setEvents] = useState<FeedEvent[]>(initialEvents);
  const [hasMore, setHasMore] = useState<boolean>(initialHasMore);
  const [isPending, startTransition] = useTransition();
  const [errored, setErrored] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guard against duplicate fetches while one is inflight. `isPending`
  // isn't enough because IntersectionObserver can fire again before
  // startTransition's state update has settled.
  const inflightRef = useRef(false);

  // Rebuild the Set on the client. Cheap — savedIds is typically < 50.
  const savedIdSet = useMemo(() => new Set(savedIds), [savedIds]);
  // Phase 5.6 — same pattern for the follow set. Username count is
  // typically a few hundred per power user; Set construction stays
  // negligible. Read by both the within-day sort comparator below
  // (via enrichmentScore) and by EventCard's "You follow [Artist]"
  // caption.
  const followedScUsernameSet = useMemo(
    () => new Set(followedSoundcloudUsernames),
    [followedSoundcloudUsernames],
  );

  const loadNext = useCallback(async () => {
    if (inflightRef.current || !hasMore) return;
    // Need at least one event to build a cursor — if the feed is
    // somehow empty but `hasMore` is true, just stop.
    const last = events[events.length - 1];
    if (!last) {
      setHasMore(false);
      return;
    }
    const cursor: FeedCursor = {
      afterStartsAt: last.starts_at,
      afterId: last.id,
    };

    inflightRef.current = true;
    setErrored(false);
    try {
      const result = await loadMoreEvents({ filters, cursor });
      startTransition(() => {
        setEvents((prev) => {
          // Dedupe defensively — if the server somehow returns an
          // event already in `prev` (shouldn't happen with keyset
          // cursors, but ingestion races or clock skew could surface
          // an edge case), filter it out rather than render duplicates.
          const seen = new Set(prev.map((e) => e.id));
          const fresh = result.events.filter((e) => !seen.has(e.id));
          return prev.concat(fresh);
        });
        // If the server said no more, OR it returned zero new events
        // (paranoia — all IDs already seen), stop observing.
        setHasMore(
          result.hasMore && result.events.some((e) => !events.find((x) => x.id === e.id)),
        );
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[infinite-feed] loadMoreEvents failed:', err);
      setErrored(true);
      // Don't clear hasMore — user can retry via the inline CTA.
    } finally {
      inflightRef.current = false;
    }
  }, [events, filters, hasMore]);

  // IntersectionObserver on the sentinel. `rootMargin: '400px'` fires
  // the load ~400px before the sentinel enters the viewport so new
  // cards appear by the time the user gets there — feels like a
  // continuous scroll rather than a stutter.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadNext();
          }
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadNext, hasMore]);

  const groups = useMemo(
    () => groupByDay(events, followedScUsernameSet),
    [events, followedScUsernameSet],
  );

  return (
    <div className="relative space-y-10">
      {groups.map(({ dayKey, events: dayEvents }) => (
        <section key={dayKey} aria-labelledby={`group-${dayKey}`}>
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              id={`group-${dayKey}`}
              className="font-display text-xs font-medium uppercase tracking-widest text-fg-muted"
            >
              {groupLabel(dayKey)}
            </h3>
            <span className="text-2xs text-fg-dim tabular">
              {dayEvents.length} {dayEvents.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          <div
            className={cn(
              'space-y-4',
              'lg:grid lg:grid-cols-2 lg:gap-5 lg:space-y-0',
              'xl:grid-cols-3',
            )}
          >
            {dayEvents.map((ev) => (
              <EventCard
                key={ev.id}
                event={ev}
                saved={savedIdSet.has(ev.id)}
                followedSoundcloudUsernames={followedScUsernameSet}
                signedIn={signedIn}
              />
            ))}
          </div>
        </section>
      ))}

      {/* Sentinel + tail states. The sentinel only exists when there's
          actually more to load — otherwise we swap in an "end of feed"
          caption (or nothing if the feed was empty to begin with). */}
      {hasMore ? (
        <div ref={sentinelRef} className="flex items-center justify-center py-8">
          {errored ? (
            <button
              type="button"
              onClick={() => void loadNext()}
              className="text-xs font-medium text-fg-muted underline-offset-4 transition hover:text-fg-primary hover:underline"
            >
              Couldn&apos;t load more — tap to retry
            </button>
          ) : (
            <span
              aria-live="polite"
              className={cn(
                'inline-flex items-center gap-2 text-2xs text-fg-muted',
                isPending ? 'opacity-100' : 'opacity-70',
              )}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Loading more events…
            </span>
          )}
        </div>
      ) : (
        events.length > 0 && (
          <div className="py-8 text-center">
            <span className="font-display text-2xs uppercase tracking-widest text-fg-dim">
              You&apos;ve reached the end
            </span>
          </div>
        )
      )}
    </div>
  );
}

// Group events by NYC calendar day. Same logic the server used to use
// directly on the feed — lifted here since the client owns the
// accumulated list once paging kicks in.
//
// Within each day bucket we re-sort by `enrichmentScore` DESC so the
// richest events (artist links, hero image, popular lineup) surface
// to the top. Day ordering stays chronological — keyset pagination
// depends on that invariant and we don't touch it.
//
// Phase 5.6 — `followedScUsernames` is threaded through to
// enrichmentScore so events with a followed-artist match in their
// lineup ride a flat boost (sized to top any unfollowed event). The
// Set is closed-over by the comparator rather than re-built per call,
// and computed once via useMemo at the parent — this keeps the inner
// loop allocation-free during the day-bucket sort.
function groupByDay(
  events: FeedEvent[],
  followedScUsernames: Set<string>,
): DayGroup[] {
  const buckets = new Map<string, FeedEvent[]>();
  for (const ev of events) {
    const key = nycDayKey(ev.starts_at);
    const list = buckets.get(key);
    if (list) list.push(ev);
    else buckets.set(key, [ev]);
  }
  // ISO dayKey strings sort lexically == chronologically.
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dayKey, evs]) => ({
      dayKey,
      // Sort within-day by enrichment (desc). Tiebreak on starts_at
      // then id to match the server's chronological ordering for
      // equally-enriched events — keeps the feed visually stable when
      // scores tie (e.g. two events with no enrichment data at all).
      events: [...evs].sort((a, b) => {
        const diff =
          enrichmentScore(b, followedScUsernames) -
          enrichmentScore(a, followedScUsernames);
        if (diff !== 0) return diff;
        if (a.starts_at !== b.starts_at)
          return a.starts_at < b.starts_at ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      }),
    }));
}
