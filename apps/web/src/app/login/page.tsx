// Sign-in screen. Visual match for the SignInScreen in /design-preview.
//
// Structure: RSC + a single client button. The Google button is a form
// that POSTs to the signInWithGoogle server action, which redirects the
// browser to Google's consent screen. No client-side Supabase SDK calls
// happen here — the PKCE flow lives entirely server-side.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signInWithGoogle } from '@/lib/supabase/actions';

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
          <form action={signInWithGoogle}>
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-3 rounded-pill bg-accent px-6 py-3.5 font-display text-sm font-semibold text-bg-deep shadow-glow transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]"
            >
              <GoogleMark />
              Sign in with Google
            </button>
          </form>

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

// Google "G" mark — inline SVG. Using the multicolor mark is Google's
// recommendation in their branding guidelines for OAuth buttons.
function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M17.64 9.2045c0-.638-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9087c1.7018-1.567 2.6836-3.874 2.6836-6.6151z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2582c-.806.54-1.8368.8591-3.0477.8591-2.344 0-4.3282-1.5832-5.036-3.7105H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71c-.18-.54-.2823-1.1168-.2823-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
        fill="#EA4335"
      />
    </svg>
  );
}
