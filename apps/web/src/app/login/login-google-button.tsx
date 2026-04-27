'use client';

// Google sign-in button for the /login page.
//
// Thin client wrapper around useGoogleSignIn — the hook handles the
// platform branching (web → server-action redirect, iOS → native ID
// token + signInWithIdToken). On native, after a successful sign-in
// we navigate to '/' so the middleware can route the user to either
// /onboarding (first-time) or '/' (already onboarded).
//
// The /login page itself stays an RSC; only the button is client-side
// because we need pending state and platform detection.

import { useGoogleSignIn } from '@/lib/auth/use-google-sign-in';

export function LoginGoogleButton() {
  const { signIn, pending, error } = useGoogleSignIn({ redirectTo: '/' });

  return (
    <>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-3 rounded-pill bg-accent px-6 py-3.5 font-display text-sm font-semibold text-bg-deep shadow-glow transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
      >
        <GoogleMark />
        {pending ? 'Opening Google…' : 'Sign in with Google'}
      </button>

      {/* Inline error from the native flow (web errors are surfaced
          via the ?error= query param the server action redirects to,
          and rendered by the parent page). */}
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-amber/30 bg-amber-chip px-4 py-3 text-xs text-amber"
        >
          {error}
        </p>
      )}
    </>
  );
}

// Google "G" mark — inline SVG. Multicolor mark per Google's branding
// guidelines for OAuth buttons.
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
