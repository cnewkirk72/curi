'use server';

// Auth server actions. These are called from form POSTs (see /login page
// and the sign-out form in the home page). Keeping them in one file so
// the Supabase auth surface area is obvious — any new auth flow (email
// OTP, magic link) would land here.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Derive the absolute origin (`https://host`) of the page that triggered
 * the current server action. We need this to build an absolute redirectTo
 * URL for Supabase OAuth — Supabase requires the redirectTo to match its
 * Redirect URL allowlist, which is configured with absolute URLs. A bare
 * relative path like `/auth/callback` won't match anything in the allowlist
 * and Supabase silently falls back to the project's Site URL (sending the
 * user to `/?code=...` instead of `/auth/callback?code=...` — see the
 * curi.events sign-in regression that triggered this hardening).
 *
 * Strategy is fall-through:
 *   1. `Origin` header (preferred) — the browser sets this on POSTs from
 *      the page that triggered the server action. Reliably present on most
 *      Vercel deploys, but observed empty on certain custom-domain aliases.
 *   2. `x-forwarded-proto` + `x-forwarded-host` — Vercel's edge proxy sets
 *      these on every inbound request regardless of how the domain is
 *      aliased, so they're a safe second source.
 *   3. `host` + assumed `https` — fallback for non-Vercel deploys (local
 *      dev sometimes hits this; localhost gets http instead of https).
 *
 * Returns `null` when none of the three resolve a usable origin — caller
 * can then surface a config error rather than building a relative URL
 * that will silently fail allowlist matching.
 */
function deriveOrigin(): string | null {
  const h = headers();

  // 1. Origin header — preferred when present.
  const origin = h.get('origin');
  if (origin) return origin;

  // 2. Vercel's x-forwarded-* — set by the edge proxy on every request.
  const xfHost = h.get('x-forwarded-host');
  const xfProto = h.get('x-forwarded-proto');
  if (xfHost) {
    return `${xfProto ?? 'https'}://${xfHost}`;
  }

  // 3. Bare Host header — last resort.
  const host = h.get('host');
  if (host) {
    // localhost gets http; anything else, assume https.
    const proto = host.startsWith('localhost') ? 'http' : 'https';
    return `${proto}://${host}`;
  }

  return null;
}

/**
 * Kick off Google OAuth.
 *
 * Supabase handles the Google handshake on its own domain; we just need
 * to (a) tell Supabase which provider, and (b) tell Google where to send
 * the user back — that's our `/auth/callback` route, which exchanges the
 * PKCE `code` param for a session cookie.
 */
export async function signInWithGoogle() {
  const supabase = createClient();
  const origin = deriveOrigin();

  if (!origin) {
    // No usable origin → can't build an absolute redirectTo. Bail with an
    // error rather than letting Supabase fall back to Site URL (which
    // hides the bug). Surfaces as ?error=oauth_no_origin on /login.
    // eslint-disable-next-line no-console
    console.error('[signInWithGoogle] no origin derivable from request headers');
    redirect('/login?error=oauth_no_origin');
  }

  const redirectTo = `${origin}/auth/callback`;

  // Diagnostic log so the redirectTo computed at request time is visible
  // in Vercel function logs — useful when debugging multi-domain OAuth
  // mismatches against the Supabase Redirect URL allowlist. Cheap; runs
  // at most once per sign-in click.
  // eslint-disable-next-line no-console
  console.log('[signInWithGoogle] redirectTo:', redirectTo);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
    },
  });

  if (error) {
    // Redirect back to /login with a flag so the UI can surface the error
    // — we don't render the raw message to the user.
    redirect(`/login?error=oauth_init`);
  }

  if (data.url) {
    // This is the redirect URL Supabase wants us to send the browser to —
    // it's the Google consent screen.
    redirect(data.url);
  }

  // No URL, no error → something is wrong with the Supabase project config.
  redirect('/login?error=oauth_no_url');
}

/**
 * End the session and bounce to /login.
 *
 * Also clears the `curi_onboarded` cache cookie written by the
 * middleware gate (Task #6). Without this, a different user signing
 * in on the same browser would inherit the previous user's cached
 * "already onboarded" flag and skip the flow — the middleware's
 * cookie-trust fast path would lie to us.
 */
export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  cookies().delete('curi_onboarded');
  redirect('/login');
}
