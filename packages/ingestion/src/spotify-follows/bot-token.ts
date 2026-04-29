// Phase 5.7 — Spotify bot session-token resolver.
//
// Pathfinder GraphQL requires a Bearer access token, which is minted
// from the bot's `sp_dc` cookie via `https://open.spotify.com/api/token`.
// The bot is a dedicated Spotify account Curi controls (NOT
// Christian's personal); the cookie lives in the SPOTIFY_BOT_SP_DC env
// var on Vercel + Railway.
//
// Caching strategy: module-global memo with TTL. Tokens have a ~1
// hour TTL. We expire the memo 5 minutes before real expiry so a
// request started right at the boundary still has buffer to complete.
// On 401 (cookie expired or otherwise revoked) the caller invalidates
// via `invalidateBotToken()` and surfaces `SpotifyAuthFailedError` —
// the daily healthcheck cron is what catches this proactively.
//
// In-flight promise sharing prevents thundering-herd when concurrent
// callers all miss the cache during the first request after a cold
// start (same pattern as packages/ingestion/src/soundcloud/client-id.ts).

import { SpotifyAuthFailedError } from './types.js';

let _cached: { token: string; expiresAt: number } | null = null;
let _inflight: Promise<string> | null = null;

const SPOTIFY_TOKEN_URL = 'https://open.spotify.com/api/token';

// 5-minute buffer before the real expiry so a request started just
// before the boundary still has runway to complete its pathfinder
// chain (token mint → hash extract → first page → paginate).
const TOKEN_TTL_BUFFER_MS = 5 * 60 * 1000;

// User-Agent pattern matching SC's client-id.ts. Spotify's open.com
// endpoints are more permissive than SC's homepage (no Cloudflare
// interstitial) but a real-browser UA is still safer than bare-curl.
const SPOTIFY_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FETCH_HEADERS_BASE: Record<string, string> = {
  'User-Agent': SPOTIFY_USER_AGENT,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Resolve a usable Spotify access token via the bot's sp_dc cookie.
 * Cached for ~55 minutes (token TTL minus the buffer). Concurrent
 * callers during the first miss share a single in-flight promise.
 *
 * @throws SpotifyAuthFailedError when SPOTIFY_BOT_SP_DC is missing
 *   from env, or when token mint returns 401 (cookie expired). The
 *   healthcheck cron (cli-healthcheck-spotify-bot.ts) runs daily and
 *   pages Christian on this so the issue is caught before users see
 *   it during a sync.
 */
export async function getBotAccessToken(): Promise<string> {
  if (_cached && _cached.expiresAt > Date.now()) return _cached.token;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const sp_dc = process.env.SPOTIFY_BOT_SP_DC;
      if (!sp_dc) {
        throw new SpotifyAuthFailedError(
          'SPOTIFY_BOT_SP_DC env var is not set — bot account needs ' +
            'provisioning before Spotify follows can be synced. See ' +
            'OPS.md or curi_roadmap.md Phase 5.7 for setup.',
        );
      }

      const res = await fetch(SPOTIFY_TOKEN_URL, {
        headers: {
          ...FETCH_HEADERS_BASE,
          Cookie: `sp_dc=${sp_dc}`,
        },
      });

      if (res.status === 401) {
        // Cookie expired or revoked. Healthcheck will catch this on
        // its next run; user-facing flow surfaces `bot_auth_failed`.
        throw new SpotifyAuthFailedError(
          `Bot sp_dc cookie expired or revoked (401 from token mint at ${SPOTIFY_TOKEN_URL})`,
        );
      }
      if (!res.ok) {
        throw new SpotifyAuthFailedError(
          `Bot token mint failed: ${res.status} ${res.statusText}`,
        );
      }

      const json = (await res.json()) as {
        accessToken?: string;
        accessTokenExpirationTimestampMs?: number;
        clientId?: string;
        isAnonymous?: boolean;
      };

      if (!json.accessToken || !json.accessTokenExpirationTimestampMs) {
        throw new SpotifyAuthFailedError(
          'Bot token mint returned malformed response (missing accessToken or expiration)',
        );
      }

      // Defensive: if the mint flagged this as anonymous, the cookie
      // wasn't accepted as authenticated. queryArtistsFollowed needs
      // an authenticated viewer, so anonymous mode = same failure
      // mode as expired cookie.
      if (json.isAnonymous === true) {
        throw new SpotifyAuthFailedError(
          'Bot token mint returned anonymous token — sp_dc cookie was ' +
            'rejected as authentication. Re-paste the cookie in env.',
        );
      }

      _cached = {
        token: json.accessToken,
        expiresAt:
          json.accessTokenExpirationTimestampMs - TOKEN_TTL_BUFFER_MS,
      };
      return _cached.token;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

/**
 * Drop the cached access token. Call when an api-partner request
 * returns 401 — the cached token has either rotated unexpectedly or
 * was minted from a now-stale sp_dc. Caller should refetch via
 * `getBotAccessToken()` and retry the original request once.
 *
 * Note: this does NOT invalidate the underlying sp_dc cookie. If the
 * cookie itself has expired, the next `getBotAccessToken()` call will
 * throw `SpotifyAuthFailedError` regardless and the healthcheck will
 * have already paged Christian.
 */
export function invalidateBotToken(): void {
  _cached = null;
}
