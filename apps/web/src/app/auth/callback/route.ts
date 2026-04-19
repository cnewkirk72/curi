// OAuth callback — Google sends the user here after the consent screen.
//
// Supabase's PKCE flow delivers a short-lived `code` param that we swap
// for a session via `exchangeCodeForSession`. The resulting cookies are
// set by the server client (see lib/supabase/server.ts) and picked up
// on subsequent requests.
//
// This URL is referenced in two places that MUST stay in sync:
//   1. lib/supabase/actions.ts (signInWithGoogle → redirectTo)
//   2. Supabase dashboard → Auth → URL Configuration → Redirect URLs
// If you change the path here, update both.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  // `next` lets us deep-link through sign-in (e.g. user taps "Save" on
  // an event while logged out → /login?next=/events/abc → back to that
  // event after auth). Default to home.
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Either no code or exchange failed — send the user back to /login with
  // an error flag so the UI can show a toast without leaking details.
  return NextResponse.redirect(`${origin}/login?error=oauth_callback`);
}
