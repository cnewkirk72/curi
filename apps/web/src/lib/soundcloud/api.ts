// Phase 5.9 — authenticated SoundCloud API client.
//
// Server-only. Pairs the OAuth helpers in ./oauth.ts with the
// user_prefs token columns introduced in migration 0024 to make
// authenticated calls on the user's behalf.
//
// Two surfaces:
//   - `withFreshToken(supabase, userId, fn)` — lazy refresh wrapper.
//     Loads the user's tokens, refreshes them if near-expiry, persists
//     the new bundle, then runs `fn(accessToken)`. Treat any thrown
//     error from this wrapper as either "user has no SC tokens" or
//     "refresh failed → reconnect required."
//   - `fetchUserFollowings(accessToken)` — paginated /me/followings
//     client. Walks `next_href` until null, capped at 50 pages × 200
//     items = 10k follows (matches the legacy scraper's cap).
//
// Why eager-refresh and not 401-retry: the cost of an extra refresh
// before a near-expiry call is one round trip; the cost of mid-
// pagination 401-retry is rebuilding state and re-walking pages
// already fetched. Eager refresh is simpler and cheaper for this
// workload, where calls are user-initiated and infrequent.

import { createClient } from '@/lib/supabase/server';
import {
  getOAuthConfig,
  refreshAccessToken,
  SC_ME_URL,
} from './oauth';

// ─── Errors ─────────────────────────────────────────────────────────────

/** Thrown when the user hasn't completed the OAuth flow yet. */
export class SoundcloudNotConnectedError extends Error {
  constructor() {
    super('SoundCloud OAuth tokens not found on user_prefs');
    this.name = 'SoundcloudNotConnectedError';
  }
}

/** Thrown when refresh fails — the refresh token is likely revoked,
 *  and the user must re-auth. Callers should null out the stored
 *  tokens and prompt for reconnect. */
export class SoundcloudReauthRequiredError extends Error {
  constructor(cause?: unknown) {
    super('SoundCloud refresh failed — reconnect required');
    this.name = 'SoundcloudReauthRequiredError';
    if (cause) (this as Error & { cause?: unknown }).cause = cause;
  }
}

// ─── Refresh wrapper ────────────────────────────────────────────────────

/**
 * Run `fn` with a guaranteed-fresh access token for the signed-in user.
 *
 * Self-contained: creates its own Supabase server client and reads the
 * user identity from the auth cookie. RLS gates the user_prefs row
 * read/write to the signed-in user, so passing the userId from the
 * caller would only be redundant.
 *
 * Steps:
 *   1. Resolve the signed-in user. No user → SoundcloudNotConnectedError.
 *   2. Load `soundcloud_access_token`, `soundcloud_refresh_token`, and
 *      `soundcloud_token_expires_at` from user_prefs.
 *   3. If no access token exists → throw SoundcloudNotConnectedError.
 *   4. If expires_at is null OR within `EXPIRY_SKEW_MS` of now →
 *      refresh and persist the new bundle (rotated refresh_token if
 *      SC sent one). Any refresh failure throws
 *      SoundcloudReauthRequiredError.
 *   5. Call `fn(accessToken)` and return its result.
 */
export async function withFreshToken<T>(
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new SoundcloudNotConnectedError();
  }

  const { data, error } = await supabase
    .from('user_prefs')
    .select(
      'soundcloud_access_token, soundcloud_refresh_token, soundcloud_token_expires_at',
    )
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[sc-api] failed to load user_prefs tokens: ${error.message}`,
    );
  }
  if (!data) {
    throw new SoundcloudNotConnectedError();
  }

  const row = data as unknown as {
    soundcloud_access_token: string | null;
    soundcloud_refresh_token: string | null;
    soundcloud_token_expires_at: string | null;
  };

  if (!row.soundcloud_access_token || !row.soundcloud_refresh_token) {
    throw new SoundcloudNotConnectedError();
  }

  let accessToken = row.soundcloud_access_token;
  const expiresAt = row.soundcloud_token_expires_at
    ? new Date(row.soundcloud_token_expires_at).getTime()
    : 0;

  // Refresh if expired, missing, or expiring within EXPIRY_SKEW_MS. The
  // skew covers clock drift + the time between this check and the
  // actual API call.
  if (!expiresAt || expiresAt - Date.now() < EXPIRY_SKEW_MS) {
    const cfg = getOAuthConfig();

    let bundle;
    try {
      bundle = await refreshAccessToken({
        refreshToken: row.soundcloud_refresh_token,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      });
    } catch (err) {
      throw new SoundcloudReauthRequiredError(err);
    }

    accessToken = bundle.access_token;
    const newExpiresAt = new Date(
      Date.now() + bundle.expires_in * 1000,
    ).toISOString();

    // Persist. Per OAuth 2.1, SC may rotate the refresh token —
    // always write whatever came back; fall back to the existing
    // refresh token when SC didn't send a new one.
    const persisted = {
      soundcloud_access_token: bundle.access_token,
      soundcloud_refresh_token:
        bundle.refresh_token ?? row.soundcloud_refresh_token,
      soundcloud_token_expires_at: newExpiresAt,
    };
    const upd = await supabase
      .from('user_prefs')
      .update(persisted as never)
      .eq('user_id', user.id);
    if (upd.error) {
      // Token is fresh in memory but we couldn't persist. Continue —
      // the call will succeed once. The next call will refresh again.
      // eslint-disable-next-line no-console
      console.warn(
        '[sc-api] refreshed token but failed to persist:',
        upd.error.message,
      );
    }
  }

  return fn(accessToken);
}

/** Refresh slightly before actual expiry so a long pagination doesn't
 *  cross the boundary. 60 seconds is generous; SC tokens are typically
 *  hours-long. */
const EXPIRY_SKEW_MS = 60_000;

// ─── /me/followings ─────────────────────────────────────────────────────

export type SoundcloudFollowing = {
  /** Lowercase profile slug — the join key against
   *  artists.soundcloud_username and user_soundcloud_follows. */
  permalink: string;
  /** Display name. May contain unicode, mixed case, etc. */
  username: string;
  /** ISO timestamp of when the user followed this artist, or null
   *  if SC didn't include it on the row. */
  followedAt: string | null;
};

type ApiV2Following = {
  id: number;
  permalink?: string;
  username?: string;
  created_at?: string;
  kind?: string;
};

type ApiV2FollowingsPage = {
  collection: ApiV2Following[];
  next_href?: string | null;
};

const FOLLOWINGS_URL = 'https://api.soundcloud.com/me/followings';
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const PAGE_THROTTLE_MS = 200;

/**
 * Walk `/me/followings` with the given access token, returning every
 * followed user. Caps pagination at 50 pages × 200 = 10k follows;
 * 99.99% of users have <1k.
 *
 * Throws on any non-2xx page response. Callers should catch and
 * surface a friendly error — the most useful framing is "couldn't
 * import your follows right now, try again."
 */
export async function fetchUserFollowings(
  accessToken: string,
): Promise<SoundcloudFollowing[]> {
  const out: SoundcloudFollowing[] = [];

  let nextUrl: string | null = `${FOLLOWINGS_URL}?limit=${PAGE_SIZE}&linked_partitioning=true`;
  let pages = 0;

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `OAuth ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(
        `[sc-api] /me/followings failed (${res.status}): ${detail}`,
      );
    }

    const page = (await res.json()) as ApiV2FollowingsPage;
    for (const f of page.collection ?? []) {
      // Skip rows missing the join key. SC occasionally returns
      // ghost users (deleted accounts) with no permalink.
      if (!f.permalink) continue;
      out.push({
        permalink: f.permalink.toLowerCase(),
        username: f.username ?? f.permalink,
        followedAt: f.created_at ?? null,
      });
    }

    nextUrl = page.next_href ?? null;
    pages += 1;

    if (pages >= MAX_PAGES) {
      // Don't throw — return what we have. 10k follows is far past
      // any plausible user; if we hit this, the user is automation.
      // eslint-disable-next-line no-console
      console.warn(
        `[sc-api] /me/followings pagination cap hit (${MAX_PAGES} pages, ${out.length} rows)`,
      );
      break;
    }

    if (nextUrl) await sleep(PAGE_THROTTLE_MS);
  }

  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export the `/me` URL for any caller that needs the user's own
// profile (already used by the OAuth callback via fetchMe in oauth.ts).
export { SC_ME_URL };
