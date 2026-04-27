// Sign-in screen. Visual match for the SignInScreen in /design-preview.
//
// Structure: RSC for the page shell + a small client component for the
// Google button. The button uses useGoogleSignIn, which on web defers
// to the existing server action (PKCE redirect through Supabase) and
// on iOS does native Google Sign-In → Supabase ID-token exchange.
// Native is required because Google blocks OAuth in embedded WebViews
// ("disallowed_useragent"); see lib/auth/use-google-sign-in.ts.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LoginGoogleButton } from './login-google-button';

type SearchParams = { error?: string };

const ERROR_COPY: Record<string, string> = {
  oauth_init: 'Could not reach Google. Try again in a moment.',
  oauth_callback: 'Sign-in was interrupted. Try again.',
  oauth_no_url: 'Sign-in is misconfigured. Contact support.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // If already signed in, bounce to home — avoids a dead-end login screen
  // when someone refreshes /login after auth.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect('/');

  const errorMessage = searchParams.error ? ERROR_COPY[searchParams.error] : null;

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-[430px] flex-col overflow-hidden px-5 pb-10 pt-16">
      {/* Ambient blobs — same recipe as the home placeholder so branding
          stays consistent through sign-in → home. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl animate-blob"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-violet/20 blur-3xl animate-blob"
        style={{ animationDelay: '6s' }}
      />

      <div className="relative flex flex-1 flex-col justify-center">
        <div className="space-y-3 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            curi — NYC
          </p>
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-display">
            Find the night
            <br />
            that sounds like you.
          </h1>
          <p className="max-w-sm text-sm text-fg-muted">
            Sign in to save events, personalize your feed, and get nudges
            when artists you follow play in NYC.
          </p>
        </div>

        <div className="mt-10 space-y-3">
          <LoginGoogleButton />

          {errorMessage && (
            <p className="rounded-xl border border-amber/30 bg-amber-chip px-4 py-3 text-xs text-amber">
              {errorMessage}
            </p>
          )}

          <p className="pt-2 text-center text-2xs text-fg-dim">
            By signing in you agree to our terms and privacy policy.
          </p>
        </div>
      </div>

      <footer className="relative mt-6 text-center font-display text-2xs uppercase tracking-widest text-fg-dim tabular">
        v0.1 · NYC · /curi
      </footer>
    </main>
  );
}
