// Session-refresh helper for Next.js middleware.
//
// Why this exists: `@supabase/ssr` stores auth in httpOnly cookies that
// expire. Without middleware running on every request, the session silently
// dies and Server Components start seeing a null user — even when the
// browser is still actively signed in. `updateSession` re-hydrates the
// cookies on each request so both the RSC render and any client-side
// Supabase calls see a fresh token.
//
// This follows the canonical @supabase/ssr + Next.js 14 app-router pattern.
// See: https://supabase.com/docs/guides/auth/server-side/nextjs
//
// Phase 5.6 / Task #6 adds the onboarding redirect gate here:
//   Signed-in users whose `user_prefs.onboarding_completed_at` is null
//   get bounced to `/onboarding` from any non-exempt route. This is the
//   counterpart to /onboarding/page.tsx, which handles the opposite
//   direction (already-completed users who happen to hit /onboarding
//   get redirected back to the feed).
//
// Placement note: the Supabase docs explicitly warn against inserting
// ANY logic between `createServerClient` and the first `getUser()`
// call — doing so can drop the refresh-token rotation and silently
// sign users out. The gate therefore runs *after* getUser().
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/supabase/types';

// Routes that must stay reachable regardless of onboarding state.
//
// - `/onboarding` itself: obvious — redirecting onto itself would loop.
// - `/login` and `/auth/*`: the redirect gate runs after getUser, so
//   signed-out users never hit it, but the sign-in form can also be
//   reached post-logout by a formerly-signed-in user whose token is
//   still briefly valid; skip these out of caution.
// - `/offline`: the service-worker fallback page — must render when the
//   user has no network, so we can't redirect it into anything.
// - `/api/*`: any API route — we never want to redirect a `fetch()`
//   that's in flight; the HTML response would corrupt the caller.
const ONBOARDING_EXEMPT_PREFIXES = [
  '/onboarding',
  '/login',
  '/auth',
  '/offline',
  '/api',
];

function isOnboardingExempt(pathname: string): boolean {
  for (const p of ONBOARDING_EXEMPT_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`)) return true;
  }
  return false;
}

// Per-user cache that skips the user_prefs roundtrip on every request.
//
// `curi_onboarded=1` is stamped once we observe a completed stamp; every
// subsequent middleware hit for this session can trust the cookie and
// short-circuit the DB read. We clear/overwrite the cookie on sign-out
// via the sign-out action (handled by the Supabase cookie rotation), so
// a new session on the same browser correctly re-checks.
//
// The cookie is not security-sensitive: RLS still gates the underlying
// data, and the worst-case of tampering is a user skipping their own
// onboarding flow (which they could also do by just not visiting the
// page). Keep it httpOnly anyway to avoid accidental JS reads.
const ONBOARDED_COOKIE = 'curi_onboarded';
const ONBOARDED_COOKIE_VALUE = '1';
const ONBOARDED_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do NOT add anything between createServerClient() and getUser() — the
  // Supabase docs explicitly warn that inserting logic here can drop the
  // refresh token and silently sign users out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Onboarding gate — only applies to signed-in users hitting a route
  // that isn't itself part of the auth/onboarding surface.
  if (user && !isOnboardingExempt(request.nextUrl.pathname)) {
    // Fast path: if the per-session cache cookie is present, we already
    // confirmed this user is onboarded in a prior request. Skip the DB
    // roundtrip entirely. The cookie is cleared by the sign-out action,
    // so a fresh login re-verifies.
    const cachedOnboarded =
      request.cookies.get(ONBOARDED_COOKIE)?.value === ONBOARDED_COOKIE_VALUE;

    if (!cachedOnboarded) {
      // Single-row select keyed by user_id (enforced by RLS). Returns
      // null for brand-new users whose row hasn't been written yet —
      // which we treat as "not yet onboarded", same as if the stamp
      // were explicitly null.
      const { data } = await supabase
        .from('user_prefs')
        .select('onboarding_completed_at')
        .maybeSingle();

      // @supabase/ssr 0.5.1 infers data as `never`-ish against the
      // generated Database type — cast via unknown to pull out the
      // single field we care about. Same dance as saves.ts / prefs.ts.
      const row = data as unknown as { onboarding_completed_at: string | null } | null;
      const completedAt = row?.onboarding_completed_at ?? null;

      if (!completedAt) {
        const url = request.nextUrl.clone();
        url.pathname = '/onboarding';
        url.search = '';
        // Build the redirect response fresh, but copy any auth cookies
        // that getUser() may have rotated onto supabaseResponse. Dropping
        // those would defeat the session refresh we just did.
        const redirectResponse = NextResponse.redirect(url);
        supabaseResponse.cookies.getAll().forEach((cookie) => {
          redirectResponse.cookies.set(cookie);
        });
        return redirectResponse;
      }

      // Confirmed onboarded — stamp the cache cookie onto this response
      // so subsequent requests in this session skip the DB roundtrip.
      supabaseResponse.cookies.set({
        name: ONBOARDED_COOKIE,
        value: ONBOARDED_COOKIE_VALUE,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: ONBOARDED_COOKIE_MAX_AGE,
      });
    }
  }

  return supabaseResponse;
}
