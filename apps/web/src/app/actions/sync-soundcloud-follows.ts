'use server';

// Phase 5.6.1 — server action backing the /profile SoundCloud connect
// card. Validates the user-supplied SC username, scrapes their public
// follow graph via @curi/ingestion/soundcloud, replaces (not merges)
// the rows in user_soundcloud_follows, and stamps user_prefs with the
// connection state + sync timestamp.
//
// "Replace, don't merge" is intentional. SC has no delta API for the
// public-followings endpoint, so we'd be doing a full re-scrape
// either way — and a clean replace makes "I unfollowed someone on
// SC" propagate to Curi without a separate cleanup pass. Row counts
// per user are small (typically 50-500, capped at 10k by the
// scraper's pagination guard), so the delete + insert costs are
// negligible.
//
// Vercel Pro server actions allow up to 60s execution; the typical
// scrape is 2-5s for sub-500 follows + ~200ms × number-of-pages
// throttle. Even a 10k-follow power user fits comfortably.

import { revalidatePath } from 'next/cache';
import {
  scrapeUserFollows,
  UserNotFoundError,
} from '@/lib/soundcloud';
import { createClient } from '@/lib/supabase/server';

/**
 * Result returned to the connect card. Discriminated on `ok` so the
 * UI can branch the toast/status-bar copy without inspecting strings.
 *
 * `error` codes:
 *   - `unauth`            → user signed out mid-flow; route to /login
 *   - `invalid_username`  → username failed the format regex client- or
 *                            server-side; render targeted helper text
 *   - `user_not_found`    → SC's /resolve returned 404 (or non-user kind);
 *                            "couldn't find @{username} on SoundCloud"
 *   - `scrape_failed`     → transient SC failure or DB write error;
 *                            generic "try again" copy + retry button
 */
export type SyncResult =
  | { ok: true; count: number }
  | {
      ok: false;
      error: 'unauth' | 'invalid_username' | 'user_not_found' | 'scrape_failed';
    };

// Same regex the scraper uses (defense in depth — a malformed username
// shouldn't even reach the scraper, but if it does it'll throw).
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

/**
 * Sync the signed-in user's SoundCloud follow graph.
 *
 * @param rawUsername  As entered by the user. May contain leading/
 *                     trailing whitespace or accidental `soundcloud.com/`
 *                     prefix; we strip both before validating.
 */
export async function syncSoundcloudFollows(
  rawUsername: string,
): Promise<SyncResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauth' };

  // Defensive normalization. The connect card should have already
  // stripped the `soundcloud.com/` prefix on the client, but the
  // server is the security boundary so we re-strip and re-validate.
  const username = stripUsername(rawUsername);
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: 'invalid_username' };
  }

  // Lowercase once at the boundary. The migration 0022 backfill,
  // the scraper output, and the EventCard match (PR #4) all
  // assume usernames are stored lowercased — this is the invariant.
  const normalizedUsername = username.toLowerCase();

  let follows;
  try {
    follows = await scrapeUserFollows(normalizedUsername);
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return { ok: false, error: 'user_not_found' };
    }
    // Treat ScrapeFailedError + any other throw as transient.
    // eslint-disable-next-line no-console
    console.error('[syncSoundcloudFollows] scrape failed:', err);
    return { ok: false, error: 'scrape_failed' };
  }

  // Replace-not-merge: clear the user's old follow set, then insert
  // the freshly-scraped rows. Both writes go through RLS (the user
  // can only touch their own rows); the FK in migration 0022 cascades
  // any orphan cleanup automatically if user_id is ever wrong.
  //
  // The `as never` casts on insert/update payloads are the same
  // @supabase/ssr 0.5.1 inference workaround used by saves.ts /
  // preferences-actions.ts — the generated row types resolve as
  // `never`-ish despite the Database type being correct.
  try {
    const del = await supabase
      .from('user_soundcloud_follows')
      .delete()
      .eq('user_id', user.id);
    if (del.error) throw del.error;

    if (follows.length > 0) {
      const rows = follows.map((f) => ({
        user_id: user.id,
        soundcloud_username: f.username,
        display_name: f.displayName,
        followed_at: f.followedAt,
      }));
      const ins = await supabase
        .from('user_soundcloud_follows')
        .insert(rows as never);
      if (ins.error) throw ins.error;
    }

    const upd = await supabase
      .from('user_prefs')
      .update({
        soundcloud_username: normalizedUsername,
        soundcloud_last_synced_at: new Date().toISOString(),
      } as never)
      .eq('user_id', user.id);
    if (upd.error) throw upd.error;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[syncSoundcloudFollows] db write failed:', err);
    return { ok: false, error: 'scrape_failed' };
  }

  // Bust the RSC caches that read user_soundcloud_follows or the
  // sync timestamp. The connect card hard-refreshes after success
  // so most clients won't actually use these cached values, but
  // server actions should be honest about what they invalidate.
  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');

  return { ok: true, count: follows.length };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Strip whitespace and an accidental `soundcloud.com/` prefix from
 * user input. The connect card's input has a permanent
 * `soundcloud.com/` prefix label, but a paste from the user's own
 * profile URL might include it as part of the value — friendly to
 * accept either.
 */
function stripUsername(raw: string): string {
  let s = raw.trim();
  // Strip protocol + domain if present (handles full-URL pastes).
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/^(www\.)?soundcloud\.com\//i, '');
  // Strip leading slash if a bare `/username` was pasted.
  s = s.replace(/^\/+/, '');
  // Strip trailing slash + any path segment (defensive).
  s = s.split('/')[0] ?? '';
  return s;
}
