'use client';

// Cross-platform Google sign-in hook.
//
// On web this defers to the existing server action `signInWithGoogle`,
// which does the standard PKCE redirect flow through Supabase. On
// iOS (Capacitor), Google blocks OAuth in embedded WebViews
// ("disallowed_useragent"), so we instead use the native Google
// Sign-In SDK via @capgo/capacitor-social-login, get an ID token,
// and exchange it via supabase.auth.signInWithIdToken.
//
// Both flows land at the same auth.users row (matched by email), so
// downstream code doesn't have to care which path got the user there.
//
// The plugin must be initialized once at app startup — see
// <InitSocialLogin /> in the root layout.
//
// Why a hook (not just a function): we need pending/error state so
// the button can show a spinner and surface failures inline. The
// previous web-only flow used react-dom's `useFormStatus`, which
// can't see a non-form click handler — hence we manage state here.

import { useCallback, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { signInWithGoogle as signInWithGoogleServerAction } from '@/lib/supabase/actions';
import { createClient } from '@/lib/supabase/client';

type Status = 'idle' | 'pending' | 'error';

export function useGoogleSignIn(opts?: { redirectTo?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setError(null);

    // Web — invoke the server action. It redirects() to Google's consent
    // screen, so this call never resolves in the happy path; we just set
    // pending in case the redirect is briefly in flight.
    if (!Capacitor.isNativePlatform()) {
      setStatus('pending');
      try {
        await signInWithGoogleServerAction();
      } catch (err) {
        // Server action redirects throw a special control-flow error
        // that Next swallows — anything that surfaces here is a real
        // problem (e.g. the action itself errored before redirecting).
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Sign in failed.');
      }
      return;
    }

    // Native — native Google Sign-In → Supabase ID-token exchange.
    setStatus('pending');
    try {
      // Dynamic import keeps the plugin out of the web bundle entirely.
      // The plugin's web stubs would work too, but there's no reason
      // to ship them to browser users who'll never call this branch.
      const { SocialLogin } = await import('@capgo/capacitor-social-login');

      const loginResult = await SocialLogin.login({
        provider: 'google',
        options: { scopes: ['email', 'profile'] },
      });

      // The plugin's typed result shape varies by provider; we narrow to
      // the Google response defensively rather than coupling to its
      // internal type names.
      const idToken =
        (loginResult as unknown as { result?: { idToken?: string } })
          .result?.idToken;

      if (!idToken) {
        throw new Error('Google did not return an ID token.');
      }

      const supabase = createClient();
      const { error: sbError } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });
      if (sbError) throw sbError;

      // Full reload so the new session cookies propagate to the server.
      // SSR pages render with the authenticated user on the next request,
      // and the onboarding orchestrator (or the home page) picks up where
      // the user left off.
      window.location.href = opts?.redirectTo ?? '/';
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    }
  }, [opts?.redirectTo]);

  return {
    signIn,
    pending: status === 'pending',
    error,
  };
}
