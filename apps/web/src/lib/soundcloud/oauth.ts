// Phase 5.8 — SoundCloud OAuth 2.1 helpers.
//
// Endpoints (verified against SC's developer docs):
//   - Authorize:  https://secure.soundcloud.com/authorize
//   - Token:      https://secure.soundcloud.com/oauth/token
//   - /me:        https://api.soundcloud.com/me
//
// SC requires PKCE (code_challenge_method=S256) on the authorization
// code grant, and the API uses `Authorization: OAuth <token>` for
// authenticated calls (NOT Bearer — that's standard OAuth-2.1 deviation
// on SC's side, easy to get wrong from training memory).
//
// State + verifier round-trip: we stash both in a short-lived signed
// httpOnly cookie (`__sc_oauth`) during /api/soundcloud/authorize, then
// verify in /api/soundcloud/callback before exchanging the code. The
// cookie is signed with HMAC-SHA256 against SOUNDCLOUD_OAUTH_COOKIE_SECRET
// — its only job is integrity (the contents aren't sensitive), so this
// is sufficient without encryption.

import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// ─── Endpoints ──────────────────────────────────────────────────────────

export const SC_AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
export const SC_TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
export const SC_ME_URL = 'https://api.soundcloud.com/me';

// ─── Env access (server-only) ───────────────────────────────────────────

/**
 * Read the four OAuth env vars or throw. Centralized so route handlers
 * fail loud and early at request time when configuration is missing,
 * rather than producing a half-broken redirect.
 */
export function getOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  cookieSecret: string;
} {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  const redirectUri = process.env.SOUNDCLOUD_REDIRECT_URI;
  const cookieSecret = process.env.SOUNDCLOUD_OAUTH_COOKIE_SECRET;

  if (!clientId || !clientSecret || !redirectUri || !cookieSecret) {
    throw new Error(
      '[sc-oauth] Missing SoundCloud OAuth env vars. Required: ' +
        'SOUNDCLOUD_CLIENT_ID, SOUNDCLOUD_CLIENT_SECRET, ' +
        'SOUNDCLOUD_REDIRECT_URI, SOUNDCLOUD_OAUTH_COOKIE_SECRET.',
    );
  }

  return { clientId, clientSecret, redirectUri, cookieSecret };
}

// ─── PKCE primitives ────────────────────────────────────────────────────

/**
 * Generate a high-entropy `code_verifier` per RFC 7636 §4.1. SC's docs
 * specify S256, which requires a 43–128 char verifier; 32 random bytes
 * base64-url-encoded yields 43 chars exactly.
 */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/**
 * Derive the `code_challenge` from a `code_verifier` per RFC 7636 §4.2:
 * base64-url(SHA-256(verifier)). Send to the authorize endpoint, hold
 * the verifier in the cookie until the callback.
 */
export function deriveCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** 32-byte hex random string. Used for the `state` parameter. */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

// ─── Signed cookie payload ──────────────────────────────────────────────

export const SC_OAUTH_COOKIE_NAME = '__sc_oauth';
/** 10 minutes — covers a slow consent flow but caps damage on cookie leak. */
export const SC_OAUTH_COOKIE_MAX_AGE_S = 600;

export type OAuthCookiePayload = {
  state: string;
  codeVerifier: string;
};

/**
 * Build a signed cookie value: `<base64url(json)>.<base64url(hmac)>`.
 * The HMAC covers the JSON portion. We use timingSafeEqual on verify
 * to avoid leaking the secret via timing comparison.
 */
export function signCookieValue(
  payload: OAuthCookiePayload,
  cookieSecret: string,
): string {
  const json = JSON.stringify(payload);
  const body = base64url(Buffer.from(json, 'utf8'));
  const sig = base64url(
    createHmac('sha256', cookieSecret).update(body).digest(),
  );
  return `${body}.${sig}`;
}

/**
 * Verify a signed cookie value and return its payload, or null if the
 * signature is missing/invalid/malformed. Pure function — does not
 * touch the cookie store directly.
 */
export function verifyCookieValue(
  raw: string | undefined,
  cookieSecret: string,
): OAuthCookiePayload | null {
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = base64url(
    createHmac('sha256', cookieSecret).update(body).digest(),
  );

  // Length differences mean the signature is the wrong shape — bail
  // before timingSafeEqual (which throws on length mismatch).
  if (sig.length !== expected.length) return null;
  if (
    !timingSafeEqual(
      Buffer.from(sig, 'utf8'),
      Buffer.from(expected, 'utf8'),
    )
  ) {
    return null;
  }

  try {
    const json = Buffer.from(base64urlDecode(body)).toString('utf8');
    const parsed = JSON.parse(json) as OAuthCookiePayload;
    if (
      typeof parsed?.state !== 'string' ||
      typeof parsed?.codeVerifier !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─── URL builders ───────────────────────────────────────────────────────

/**
 * Build SC's `/authorize` URL with PKCE. SC requires
 * code_challenge_method=S256 and PKCE on every authorization-code grant.
 */
export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(SC_AUTHORIZE_URL);
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', args.state);
  u.searchParams.set('code_challenge', args.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// ─── Token endpoint ─────────────────────────────────────────────────────

export type TokenResponse = {
  /** Access token used for `Authorization: OAuth <token>` calls. */
  access_token: string;
  /** Long-lived refresh token, exchangeable for a new access token.
   *  Always present on the initial code exchange. On refresh-grant
   *  responses, SC *may* omit it if it isn't rotating — callers
   *  should fall back to the incoming refresh_token in that case. */
  refresh_token?: string;
  /** Lifetime of the access token, in seconds from issue. */
  expires_in: number;
  /** SC docs use 'bearer' here despite the auth header being `OAuth`. */
  token_type: string;
  /** Free-form scope string, may be empty. */
  scope?: string;
};

/** Initial code-exchange always returns a refresh_token — narrower
 *  than TokenResponse so callers don't need to null-check. */
export type InitialTokenResponse = TokenResponse & { refresh_token: string };

/**
 * Exchange an authorization code for a token bundle. Uses the
 * application/x-www-form-urlencoded body shape SC's docs specify; SC
 * does NOT accept JSON on this endpoint.
 *
 * Throws on non-2xx, with the response text included in the error
 * message for diagnostics. The route handler should catch and redirect
 * to /profile?sc_error=exchange rather than surface the error verbatim.
 */
export async function exchangeCodeForTokens(args: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<InitialTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
    code_verifier: args.codeVerifier,
  });

  const res = await fetch(SC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(
      `[sc-oauth] token exchange failed (${res.status}): ${detail}`,
    );
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token || !data.refresh_token || !data.expires_in) {
    throw new Error('[sc-oauth] token response missing required fields');
  }
  return data as InitialTokenResponse;
}

// ─── Refresh ────────────────────────────────────────────────────────────

/**
 * Exchange a refresh token for a new access token bundle. Used when
 * the stored access token is expired (or about to expire) before
 * making an authenticated SC API call.
 *
 * SC's token endpoint is the same URL and shape as the initial code
 * exchange, just with `grant_type=refresh_token`. Per OAuth 2.1, SC
 * may rotate the refresh token — the response *may* include a new
 * `refresh_token` field, in which case we MUST persist it (the old
 * one becomes invalid). Callers should always persist whatever
 * `refresh_token` comes back; if it's missing, fall back to the
 * incoming one.
 *
 * Throws on non-2xx with the response text in the error message.
 * Callers should catch and treat any failure as "refresh token
 * revoked" — null out the user's stored tokens and prompt them to
 * reconnect.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
  });

  const res = await fetch(SC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(
      `[sc-oauth] refresh failed (${res.status}): ${detail}`,
    );
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token || !data.expires_in) {
    throw new Error('[sc-oauth] refresh response missing required fields');
  }
  return data;
}

// ─── /me endpoint ───────────────────────────────────────────────────────

export type SoundcloudMe = {
  id: number;
  /** Lowercase profile slug, used as the join key on artists.soundcloud_username. */
  permalink: string;
  /** Display name. */
  username: string;
};

/**
 * Fetch the authenticated user's SoundCloud profile. Used by the
 * callback route to populate user_prefs.soundcloud_username after a
 * successful token exchange.
 */
export async function fetchMe(accessToken: string): Promise<SoundcloudMe> {
  const res = await fetch(SC_ME_URL, {
    headers: {
      Authorization: `OAuth ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`[sc-oauth] /me failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as SoundcloudMe;
  if (typeof data.permalink !== 'string') {
    throw new Error('[sc-oauth] /me response missing `permalink`');
  }
  return data;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + '='.repeat(pad), 'base64');
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
