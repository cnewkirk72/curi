'use server';

// Server action backing the home feed's infinite scroll. Thin wrapper
// around `getUpcomingEvents` that the client-side <InfiniteFeed>
// sentinel invokes when it comes into view.
//
// Why a server action (not an API route):
//   - No serialization ceremony — args/returns cross the RSC boundary
//     as plain JSON with the same type safety we get at page render.
//   - Shares the existing Supabase server client, so RLS applies to
//     every page identically to the initial SSR fetch.
//
// The client passes the FilterState it rendered with, plus a cursor
// built from the last event in its current list. We return the next
// page of events plus a `hasMore` flag so the client can stop
// observing the sentinel once the feed is exhausted.

import { getUpcomingEvents, type FeedCursor, type FeedEvent } from '@/lib/events';
import type { FilterState } from '@/lib/filters';

export type LoadMoreResult = {
  events: FeedEvent[];
  hasMore: boolean;
};

// Page size for follow-on loads. Matches the initial SSR batch so the
// day-grouping on the client stays consistent (initial and paged
// chunks form sections of comparable density).
const PAGE_SIZE = 40;

export async function loadMoreEvents({
  filters,
  cursor,
}: {
  filters: FilterState;
  cursor: FeedCursor;
}): Promise<LoadMoreResult> {
  const events = await getUpcomingEvents({
    limit: PAGE_SIZE,
    filters,
    cursor,
  });
  return {
    events,
    // If we got back exactly PAGE_SIZE rows there might be more;
    // fewer means we've reached the tail of the feed. A `hasMore ===
    // true` result that later yields zero on the next call is fine —
    // the InfiniteFeed handles the empty response by clamping
    // `hasMore` to false itself.
    hasMore: events.length === PAGE_SIZE,
  };
}
