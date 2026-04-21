'use server';

// Auth server actions. These are called from form POSTs (see /login page
// and the sign-out form in the home page). Keeping them in one file so
// the Supabase auth surface area is obvious — any new auth flow (email
// OTP, magic link) would land here.

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

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
  const origin = headers().get('origin') ?? '';

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${origin}/auth/callback`,
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
