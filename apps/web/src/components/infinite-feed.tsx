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
// server-only supabase client into the bundle. `feedScore` lives in
// the separate `lib/enrichment.ts` (also server-free) for the same
// reason.
//
// ─── Phase 5.7 sort + candidate-pool architecture ──────────────────
//
// Two state slices:
//
//   chronoEvents       The chronologically-paginated stream from
//                      getUpcomingEvents. Pagination appends here.
//                      Cursor for `loadMoreEvents` is anchored to the
//                      tail of THIS list (not the merged list below).
//
//   followedExtras     Events injected by getFollowedEventsInWindow
//                      that feature followed artists but might fall
//                      past the chronological page cap. Static for
//                      the lifetime of the component (we don't refetch
//                      on pagination — the date window doesn't change
//                      mid-scroll).
//
// Day-grouping operates on the UNION of these two with id-dedup. The
// `feedScore` comparator surfaces followed events to the top of each
// day group via the FOLLOWED_TIER_FLOOR boost. As pagination brings
// chronologically-later events in, any duplicates with followedExtras
// are filtered by id at merge time — no double rendering.
//
// Cursor invariant: keyset cursor on `(starts_at, id)` continues to
// work because pagination only ever consumes/extends `chronoEvents`.
// The merged view is presentation-only.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { EventCard } from '@/components/event-card';
import { nycDayKey, groupLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FeedCursor, FeedEvent } from '@/lib/events';
import { feedScore } from '@/lib/enrichment';
import type { FilterState } from '@/lib/filters';
import { loadMoreEvents } from '@/app/actions/load-more-events';

type Props = {
  initialEvents: FeedEvent[];
  initialFollowedScExtras: FeedEvent[];
  initialFollowedSpotifyExtras: FeedEvent[];
  initialHasMore: boolean;
  filters: FilterState;
  savedIds: string[];
  followedSoundcloudUsernames: string[];
  followedSpotifyArtistIds: string[];
  preferredGenres: string[];
  signedIn: boolean;
};

type DayGroup = { dayKey: string; events: FeedEvent[] };

export function InfiniteFeed({
  initialEvents,
  initialFollowedScExtras,
  initialFollowedSpotifyExtras,
  initialHasMore,
  filters,
  savedIds,
  followedSoundcloudUsernames,
  followedSpotifyArtistIds,
  preferredGenres,
  signedIn,
}: Props) {
  const [chronoEvents, setChronoEvents] = useState<FeedEvent[]>(initialEvents);
  const [hasMore, setHasMore] = useState<boolean>(initialHasMore);
  const [isPending, startTransition] = useTransition();
  const [errored, setErrored] = useState(false);

  const followedScExtras = initialFollowedScExtras;
  const followedSpotifyExtras = initialFollowedSpotifyExtras;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const inflightRef = useRef(false);

  const savedIdSet = useMemo(() => new Set(savedIds), [savedIds]);
  const followedScUsernameSet = useMemo(
    () => new Set(followedSoundcloudUsernames),
    [followedSoundcloudUsernames],
  );
  const followedSpotifyArtistIdSet = useMemo(
    () => new Set(followedSpotifyArtistIds),
    [followedSpotifyArtistIds],
  );
  const preferredGenresSet = useMemo<ReadonlySet<string>>(
    () => new Set(preferredGenres),
    [preferredGenres],
  );

  const loadNext = useCallback(async () => {
    if (inflightRef.current || !hasMore) return;
    const last = chronoEvents[chronoEvents.length - 1];
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
        setChronoEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const fresh = result.events.filter((e) => !seen.has(e.id));
          return prev.concat(fresh);
        });
        setHasMore(
          result.hasMore && result.events.some((e) => !chronoEvents.find((x) => x.id === e.id)),
        );
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[infinite-feed] loadMoreEvents failed:', err);
      setErrored(true);
    } finally {
      inflightRef.current = false;
    }
  }, [chronoEvents, filters, hasMore]);

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

  const mergedEvents = useMemo(() => {
    if (followedScExtras.length === 0 && followedSpotifyExtras.length === 0) {
      return chronoEvents;
    }
    const seen = new Set(chronoEvents.map((e) => e.id));
    const scExtras: FeedEvent[] = [];
    for (const e of followedScExtras) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      scExtras.push(e);
    }
    const spotifyExtras: FeedEvent[] = [];
    for (const e of followedSpotifyExtras) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      spotifyExtras.push(e);
    }
    return chronoEvents.concat(scExtras, spotifyExtras);
  }, [chronoEvents, followedScExtras, followedSpotifyExtras]);

  const groups = useMemo(
    () =>
      groupByDay(
        mergedEvents,
        followedScUsernameSet,
        followedSpotifyArtistIdSet,
        preferredGenresSet,
      ),
    [
      mergedEvents,
      followedScUsernameSet,
      followedSpotifyArtistIdSet,
      preferredGenresSet,
    ],
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
                followedSpotifyArtistIds={followedSpotifyArtistIdSet}
                signedIn={signedIn}
              />
            ))}
          </div>
        </section>
      ))}

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
        mergedEvents.length > 0 && (
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

function groupByDay(
  events: FeedEvent[],
  followedScUsernames: Set<string>,
  followedSpotifyArtistIds: Set<string>,
  preferredGenres: ReadonlySet<string>,
): DayGroup[] {
  const buckets = new Map<string, FeedEvent[]>();
  for (const ev of events) {
    const key = nycDayKey(ev.starts_at);
    const list = buckets.get(key);
    if (list) list.push(ev);
    else buckets.set(key, [ev]);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dayKey, evs]) => ({
      dayKey,
      events: [...evs].sort((a, b) => {
        const diff =
          feedScore(
            b,
            followedScUsernames,
            followedSpotifyArtistIds,
            preferredGenres,
          ) -
          feedScore(
            a,
            followedScUsernames,
            followedSpotifyArtistIds,
            preferredGenres,
          );
        if (diff !== 0) return diff;
        if (a.starts_at !== b.starts_at)
          return a.starts_at < b.starts_at ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      }),
    }));
}
