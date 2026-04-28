// Phase 6.3 v2 — typed client wrapper for the `search_suggestions`
// Postgres RPC (see migrations/0021_search_suggestions.sql).
//
// The RPC returns a flat union of three buckets — events, artists,
// venues — each ranked by trigram similarity. This wrapper:
//   1. Calls the RPC with `q` (already trimmed by the caller).
//   2. Splits the flat result into three typed buckets so the
//      dropdown can render sections without re-filtering on every
//      keystroke.
//   3. Surfaces the top-scoring artist / venue (if score >= 0.7) so
//      the dropdown can render the "Show events with X" / "Show
//      events at Y" entity buttons. The 0.7 threshold matches the
//      RPC docstring — high enough to feel like a confident match,
//      low enough that fuzzy typos still surface the entity row.
//
// Cancellation: the caller passes an AbortSignal so a stale request
// (user typed another character) doesn't clobber a fresh one. Supabase
// JS doesn't accept AbortSignal natively, so we race the RPC promise
// against the signal and throw a sentinel error on abort.

import { createClient } from '@/lib/supabase/client';

export type SearchKind = 'event' | 'artist' | 'venue';

export type SearchResultRow = {
  kind: SearchKind;
  id: string;
  slug: string | null;
  title: string;
  subtitle: string | null;
  image_url: string | null;
  score: number;
  starts_at: string | null;
};

export type SearchSuggestions = {
  events: SearchResultRow[];
  artists: SearchResultRow[];
  venues: SearchResultRow[];
  // Top-scoring artist / venue if score >= ENTITY_THRESHOLD. These
  // power the "Show events with [X]" / "Show events at [X]" buttons
  // at the top of the dropdown.
  topArtist: SearchResultRow | null;
  topVenue: SearchResultRow | null;
};

export const ENTITY_THRESHOLD = 0.7;

export class SearchAbortedError extends Error {
  constructor() {
    super('search aborted');
    this.name = 'SearchAbortedError';
  }
}

const EMPTY: SearchSuggestions = {
  events: [],
  artists: [],
  venues: [],
  topArtist: null,
  topVenue: null,
};

export async function searchSuggestions(
  q: string,
  signal?: AbortSignal,
): Promise<SearchSuggestions> {
  const needle = q.trim();
  if (needle.length === 0) return EMPTY;
  if (signal?.aborted) throw new SearchAbortedError();

  const supabase = createClient();

  // Race the RPC against the abort signal so a stale in-flight call
  // gets discarded the moment the user types another character.
  //
  // The `as any` cast follows the convention from
  // packages/ingestion/src/normalizer.ts — supabase-js's RPC overloads
  // don't always pick up hand-edited Functions entries from
  // lib/supabase/types.ts. Type safety is preserved further down where
  // we cast `result.data` to the strict SearchResultRow[] shape that
  // matches the migration's RETURNS table.
  const rpcPromise = (supabase as unknown as {
    rpc: (
      fn: 'search_suggestions',
      args: { q: string },
    ) => Promise<{
      data: SearchResultRow[] | null;
      error: { message: string } | null;
    }>;
  }).rpc('search_suggestions', { q: needle });

  // Shape returned by the supabase-js builder (a PostgrestResponse-ish
  // envelope). Local alias keeps the Promise generic explicit even
  // though `rpcPromise` itself is typed as `any` after the cast above.
  type RpcEnvelope = {
    data: SearchResultRow[] | null;
    error: { message: string } | null;
  };

  const result = await new Promise<RpcEnvelope>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new SearchAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    (rpcPromise as Promise<RpcEnvelope>).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });

  if (result.error) {
    // Surface the error to the caller — the dropdown shows an empty
    // state with a generic "Search unavailable" footer.
    throw result.error;
  }

  const rows: SearchResultRow[] = result.data ?? [];

  const events: SearchResultRow[] = [];
  const artists: SearchResultRow[] = [];
  const venues: SearchResultRow[] = [];

  for (const row of rows) {
    if (row.kind === 'event') events.push(row);
    else if (row.kind === 'artist') artists.push(row);
    else if (row.kind === 'venue') venues.push(row);
  }

  // Already ordered by score desc inside the RPC, but we pluck the
  // first row defensively in case any UNION re-ordering ever sneaks in.
  // tsconfig has noUncheckedIndexedAccess on, hence the explicit
  // truthiness check.
  const topArtistRow = artists[0];
  const topVenueRow = venues[0];
  const topArtist: SearchResultRow | null =
    topArtistRow && topArtistRow.score >= ENTITY_THRESHOLD ? topArtistRow : null;
  const topVenue: SearchResultRow | null =
    topVenueRow && topVenueRow.score >= ENTITY_THRESHOLD ? topVenueRow : null;

  return { events, artists, venues, topArtist, topVenue };
}
