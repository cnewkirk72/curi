// OAuth callback — Google sends the user here after the consent screen.
//
// Supabase's PKCE flow delivers a short-lived `code` param that we swap
// for a session via `exchangeCodeForSession`. The resulting cookies are
// set by the server client (see lib/supabase/server.ts) and picked up
// on subsequent requests.
//
// Routing rules (Task #6):
//   - Unfinished onboarding (no stamp on user_prefs) → /onboarding
//   - Completed onboarding + `next` param             → $next
//   - Completed onboarding, no `next`                 → /events
//
// The middleware gate (lib/supabase/middleware.ts) would catch any
// un-onboarded user bouncing through here even if we didn't branch —
// but branching explicitly saves a redirect hop and keeps the intent
// readable in server logs.
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
  // event after auth). Absence falls back to /events for onboarded
  // users; un-onboarded users always go to /onboarding regardless.
  const next = searchParams.get('next');

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Look up the user we just signed in so we can check their
      // onboarding state before picking a landing page.
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data } = await supabase
          .from('user_prefs')
          .select('onboarding_completed_at')
          .maybeSingle();

        // Same @supabase/ssr 0.5.1 inference workaround as saves.ts /
        // preferences.ts — cast via unknown to reach the column type.
        const row = data as unknown as { onboarding_completed_at: string | null } | null;
        const completedAt = row?.onboarding_completed_at ?? null;

        if (!completedAt) {
          // Brand-new sign-in (or a user who bailed mid-flow). Skip
          // the `next` deep link — onboarding is the only sensible
          // destination until they finish it.
          return NextResponse.redirect(`${origin}/onboarding`);
        }
      }

      // Returning user with a stamped completion — honor the deep-link
      // intent if any, otherwise land on the feed.
      return NextResponse.redirect(`${origin}${next ?? '/events'}`);
    }
  }

  // Either no code or exchange failed — send the user back to /login with
  // an error flag so the UI can show a toast without leaking details.
  return NextResponse.redirect(`${origin}/login?error=oauth_callback`);
}
