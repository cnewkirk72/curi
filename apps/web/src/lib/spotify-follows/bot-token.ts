// Phase 5.7 — Spotify bot session-token resolver.
//
// NOTE: Dual-copy of packages/ingestion/src/spotify-follows/bot-token.ts.
// See ./types.ts for the dual-copy rationale.
//
// apps/web copy uses HeadersInit (DOM lib available) and relative
// imports without .js extensions. Functionally identical at runtime.
//
// Endpoint: `https://open.spotify.com/get_access_token` with query
// params `reason=transport&productType=web-player`. The legacy
// `/api/token` path was deprecated sometime in 2023; calling it now
// returns 400 Bad Request even with a valid sp_dc cookie.
//
// We send Origin/Referer headers matching the real web-player
// request shape because Spotify's edge layer flags requests that
// carry a real sp_dc but lack browser-style headers.

import { SpotifyAuthFailedError } from './types';

let _cached: { token: string; expiresAt: number } | null = null;
let _inflight: Promise<string> | null = null;

const SPOTIFY_TOKEN_URL =
  'https://open.spotify.com/get_access_token?reason=transport&productType=web-player';
const TOKEN_TTL_BUFFER_MS = 5 * 60 * 1000;

const SPOTIFY_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FETCH_HEADERS_BASE: HeadersInit = {
  'User-Agent': SPOTIFY_USER_AGENT,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  // Origin + Referer match the real web-player shape; Spotify's bot
  // classifier flags real-cookie requests missing these.
  Origin: 'https://open.spotify.com',
  Referer: 'https://open.spotify.com/',
  'App-Platform': 'WebPlayer',
};

export async function getBotAccessToken(): Promise<string> {
  if (_cached && _cached.expiresAt > Date.now()) return _cached.token;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const sp_dc = process.env.SPOTIFY_BOT_SP_DC;
      if (!sp_dc) {
        throw new SpotifyAuthFailedError(
          'SPOTIFY_BOT_SP_DC env var is not set — bot account needs ' +
            'provisioning before Spotify follows can be synced.',
        );
      }

      const res = await fetch(SPOTIFY_TOKEN_URL, {
        headers: {
          ...FETCH_HEADERS_BASE,
          Cookie: `sp_dc=${sp_dc}`,
        },
      });

      if (res.status === 401) {
        // Read body before throwing so the cookie-expired message
        // surfaces the actual server response.
        const body = await res.text().catch(() => '<unreadable>');
        throw new SpotifyAuthFailedError(
          `Bot sp_dc cookie expired or revoked (401 from token mint at ` +
            `${SPOTIFY_TOKEN_URL}). Body: ${body.slice(0, 200)}`,
        );
      }
      if (!res.ok) {
        // Capture the server's actual error message for diagnosis.
        // Spotify's edge sometimes returns useful body text on 400s
        // (missing param, invalid combination, etc).
        const body = await res.text().catch(() => '<unreadable>');
        throw new SpotifyAuthFailedError(
          `Bot token mint failed: ${res.status} ${res.statusText}. ` +
            `Body: ${body.slice(0, 400)}`,
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
          'Bot token mint returned malformed response ' +
            `(missing accessToken or expiration). Got: ${JSON.stringify(json).slice(0, 300)}`,
        );
      }

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

export function invalidateBotToken(): void {
  _cached = null;
}
