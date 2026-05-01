// Phase 5.8 — SoundCloud OAuth callback.
//
// GET /api/soundcloud/callback?code=...&state=...
//
// Closes the authorize → callback round trip:
//   1. Verify the signed __sc_oauth cookie's HMAC.
//   2. Confirm the `state` query param matches the cookie's stored state.
//   3. Confirm a Supabase user is signed in.
//   4. POST to SC's token endpoint with grant_type=authorization_code +
//      code_verifier (PKCE).
//   5. GET SC's /me to capture the user's permalink (slug) — used as
//      the join key against artists.soundcloud_username when the
//      Phase 5.9+ followings-fetch lands.
//   6. Persist tokens + permalink to user_prefs.
//   7. Clear the __sc_oauth cookie.
//   8. Redirect to /profile?sc_connected=1 on success, or
//      /profile?sc_error=<code> on any failure.
//
// Failure modes are bucketed into two query-param codes the OAuth
// card maps to user-visible copy:
//   - `state`    — cookie tampering, expiry, or state mismatch
//   - `exchange` — token endpoint or /me endpoint returned non-2xx
// (`config` is set by the authorize route on missing env vars and is
// surfaced as a generic "try again" — same copy as `exchange`.)

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  exchangeCodeForTokens,
  fetchMe,
  getOAuthConfig,
  verifyCookieValue,
  SC_OAUTH_COOKIE_NAME,
} from '@/lib/soundcloud/oauth';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  // Hoisted so we can clear the cookie on every terminal path. The
  // cookie's only purpose was the round trip; once we're back, it's
  // garbage whether or not we succeeded.
  const clearCookie = (res: NextResponse) => {
    res.cookies.set({
      name: SC_OAUTH_COOKIE_NAME,
      value: '',
      path: '/',
      maxAge: 0,
    });
    return res;
  };

  let cfg;
  try {
    cfg = getOAuthConfig();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sc-callback] config error:', err);
    return clearCookie(
      NextResponse.redirect(`${origin}/profile?sc_error=config`),
    );
  }

  // Verify the signed cookie BEFORE checking the query params — if
  // the cookie is missing/tampered, the rest of the request is
  // untrusted regardless of what `state` claims.
  const cookieRaw = request.headers.get('cookie') ?? '';
  const cookieValue = parseCookie(cookieRaw, SC_OAUTH_COOKIE_NAME);
  const payload = verifyCookieValue(cookieValue, cfg.cookieSecret);

  if (!payload || !state || payload.state !== state || !code) {
    return clearCookie(
      NextResponse.redirect(`${origin}/profile?sc_error=state`),
    );
  }

  // Auth gate. Signed-out users shouldn't reach here (the authorize
  // route gates first), but a session can expire mid-flow.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return clearCookie(
      NextResponse.redirect(
        `${origin}/login?next=${encodeURIComponent('/profile')}`,
      ),
    );
  }

  // Exchange the code + verifier for tokens, then fetch /me. Either
  // step failing surfaces the same `exchange` error code — the user
  // doesn't care which network call broke.
  let tokens;
  let me;
  try {
    tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: payload.codeVerifier,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
    });
    me = await fetchMe(tokens.access_token);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sc-callback] token exchange or /me failed:', err);
    return clearCookie(
      NextResponse.redirect(`${origin}/profile?sc_error=exchange`),
    );
  }

  // Persist. Same `as never` cast pattern saves.ts / preferences.ts
  // use for the @supabase/ssr 0.5.1 inference quirk.
  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000,
  ).toISOString();
  const permalink = me.permalink.toLowerCase();

  try {
    const { error } = await supabase
      .from('user_prefs')
      .update({
        soundcloud_access_token: tokens.access_token,
        soundcloud_refresh_token: tokens.refresh_token,
        soundcloud_token_expires_at: expiresAt,
        soundcloud_username: permalink,
      } as never)
      .eq('user_id', user.id);
    if (error) throw error;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sc-callback] db write failed:', err);
    return clearCookie(
      NextResponse.redirect(`${origin}/profile?sc_error=exchange`),
    );
  }

  return clearCookie(
    NextResponse.redirect(`${origin}/profile?sc_connected=1`),
  );
}

/**
 * Pluck a single cookie value from a `Cookie:` header. Avoids pulling
 * `next/headers#cookies()` here so the route stays purely dependent on
 * the request object (cleaner for testing and for handling the cookie
 * header explicitly).
 */
function parseCookie(header: string, name: string): string | undefined {
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
