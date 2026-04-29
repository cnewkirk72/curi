// Phase 5.6 — SoundCloud follow-graph data fetcher. Server-only,
// gated by user_soundcloud_follows's owner-RLS policies (migration
// 0022): the signed-in user can only see their own rows. Anon
// viewers and signed-in users with no follows both get [].
//
// Why a separate module rather than folding into saves.ts: the two
// concerns are logically distinct (saves are user → event, follows
// are user → artist), and the home page parallel-fetches both, so
// keeping them as siblings makes the call sites at the page layer
// read symmetrically (`getSavedEventIds` + `getUserFollowedSoundcloudUsernames`).
//
// The follow set is consumed by `enrichmentScore` in lib/enrichment.ts
// to add a flat per-match boost on events whose lineup overlaps the
// user's follow graph, and by `EventCard` to render the "You follow
// [Artist]" caption explaining why the event ranked where it did.

import { createClient } from '@/lib/supabase/server';

/**
 * Fetch the lowercased SoundCloud usernames the signed-in user follows.
 *
 * Returns an array (not a Set) so it can be passed across the RSC
 * boundary as plain JSON without serialization tricks. The client side
 * (`InfiniteFeed`) rebuilds a Set with `useMemo` for O(1) lookups
 * during the within-day re-sort — same pattern we use for `savedIds`.
 *
 * Usernames are stored lowercased at write time (migration 0022
 * backfill + the Phase 5.6.2 scraper insert path), so the array is
 * already case-normalized; the Set on the client side can do naked
 * `.has(a.soundcloud_username)` against it without any per-call
 * `.toLowerCase()`.
 *
 * Anon viewers: RLS returns [] with no error.
 * Signed-in user with no follows yet (hasn't connected SC, or
 * connected but the sync hasn't run): also [].
 */
export async function getUserFollowedSoundcloudUsernames(): Promise<string[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('user_soundcloud_follows')
    .select('soundcloud_username');

  if (error) {
    // Match the soft-fail pattern used by saves.ts / events.ts —
    // log to console (catches RLS / env drift in dev) but return
    // empty so the page renders. A broken follow fetch should not
    // break the feed; it should just yield the pre-Phase-5.6 sort.
    // eslint-disable-next-line no-console
    console.error(
      '[follows] getUserFollowedSoundcloudUsernames failed:',
      error.message,
    );
    return [];
  }

  // Same ssr-0.5.1 inference quirk as saves.ts: PostgREST row type
  // resolves to `never` despite the generated Database type being
  // correct. Cast via unknown to a minimal row shape.
  const rows = (data ?? []) as unknown as { soundcloud_username: string }[];
  return rows.map((r) => r.soundcloud_username);
}
