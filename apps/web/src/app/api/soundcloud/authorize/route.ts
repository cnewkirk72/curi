// Phase 5.8 — SoundCloud OAuth init.
//
// GET /api/soundcloud/authorize
//
// Generates a fresh state + PKCE verifier, stashes them in a signed
// httpOnly cookie, and 302s the user to SC's authorize endpoint. The
// callback route then verifies the round-trip via that cookie before
// exchanging the auth code for tokens.
//
// Auth gate: the user must be signed into Curi to start the flow,
// because the callback writes tokens to their user_prefs row. Signed-out
// callers are bounced to /login?next=/profile so they end up back on
// the connect card after authentication.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  getOAuthConfig,
  signCookieValue,
  SC_OAUTH_COOKIE_NAME,
  SC_OAUTH_COOKIE_MAX_AGE_S,
} from '@/lib/soundcloud/oauth';

export async function GET(request: Request) {
  const { origin } = new URL(request.url);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      `${origin}/login?next=${encodeURIComponent('/profile')}`,
    );
  }

  let cfg;
  try {
    cfg = getOAuthConfig();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sc-authorize] config error:', err);
    return NextResponse.redirect(`${origin}/profile?sc_error=config`);
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);

  const authorizeUrl = buildAuthorizeUrl({
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state,
    codeChallenge,
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set({
    name: SC_OAUTH_COOKIE_NAME,
    value: signCookieValue({ state, codeVerifier }, cfg.cookieSecret),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SC_OAUTH_COOKIE_MAX_AGE_S,
  });
  return res;
}
