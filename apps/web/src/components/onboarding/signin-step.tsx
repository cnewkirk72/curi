'use client';

// Onboarding step 2 — sign-in gate with a skip-for-now escape.
//
// We mirror the /login page's Google button (same form action, same
// visual pill) so returning users who already have an account don't
// feel like onboarding is a separate product. The difference vs
// /login is the "Skip for now" ghost button — onboarding is not
// auth-gated, and we want people who aren't ready to commit to a
// Google sign-in to still be able to get a personalized feed for
// this session.
//
// When Skip is tapped the orchestrator advances to `genres` with
// the user still anonymous. Their taste writes will be no-ops (the
// server actions return `unauth` and we toast quietly on the client)
// — but the local draft keeps everything so when they eventually
// sign in we can upsert the accumulated preferences in one shot.

import { useFormStatus } from 'react-dom';
import { cn } from '@/lib/utils';
import { signInWithGoogle } from '@/lib/supabase/actions';

type Props = {
  /** Called when the user chooses to skip sign-in. */
  onSkip: () => void;
};

export function SigninStep({ onSkip }: Props) {
  return (
    <div className="flex flex-col gap-6 px-5 pt-4 animate-enter-up">
      <div className="space-y-3">
        <p className="font-display text-2xs uppercase tracking-widest text-accent">
          Step 2 of 5
        </p>
        <h2 className="font-display text-2xl font-semibold leading-tight tracking-display">
          Sign in to save
          <br />
          your picks.
        </h2>
        <p className="max-w-sm text-sm text-fg-muted">
          Google is the fastest way in. You can also skip for now and
          we&apos;ll remember your choices on this device.
        </p>
      </div>

      <div className="space-y-3">
        {/* Same pattern as /login: bare form with a server action. The
            action redirects to Google, so we never get a resolve back
            in the browser — `useFormStatus` just drives a brief pending
            label while the outbound redirect is in flight. */}
        <form action={signInWithGoogle}>
          <GoogleSubmit />
        </form>

        <button
          type="button"
          onClick={onSkip}
          className="inline-flex w-full items-center justify-center rounded-pill border border-border bg-bg-elevated px-6 py-3 text-sm font-medium text-fg-muted transition duration-micro ease-expo hover:bg-bg-elevated-hover hover:text-fg-primary active:scale-[0.98]"
        >
          Skip for now
        </button>

        <p className="pt-1 text-center text-2xs text-fg-dim">
          By continuing you agree to our terms and privacy policy.
        </p>
      </div>
    </div>
  );
}

// Submit button split out so `useFormStatus` can read the parent
// <form>'s pending state. Must be rendered inside the form.
function GoogleSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(
        'inline-flex w-full items-center justify-center gap-3 rounded-pill bg-accent px-6 py-3.5',
        'font-display text-sm font-semibold text-bg-deep shadow-glow',
        'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-60',
      )}
    >
      <GoogleMark />
      {pending ? 'Opening Google…' : 'Continue with Google'}
    </button>
  );
}

// Inline Google "G" mark — same as login page. Mirrored here rather
// than shared because the asset is tiny and a shared component
// would just add an import indirection.
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
