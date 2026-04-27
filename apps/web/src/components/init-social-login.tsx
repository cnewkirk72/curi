'use client';

// One-shot initializer for the @capgo/capacitor-social-login plugin.
//
// Mirrors the RegisterSW pattern: mounted once at the top of the app,
// no-ops on web (Capacitor.isNativePlatform() returns false in the
// browser), and dynamically imports the plugin so the web bundle
// doesn't carry the native bridge stubs.
//
// On iOS, this must run before the user taps "Continue with Google" —
// SocialLogin.login() will throw "Plugin not initialized" otherwise.
// Mounting in the root layout's body guarantees that even a deep-link
// straight into /login or /onboarding hits the init first.

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

// iOS OAuth Client ID from Google Cloud Console (Curi iOS app).
// Distinct from the web client ID configured in Supabase Auth → Google;
// both IDs are listed in Supabase's "Authorized Client IDs" so the
// project accepts ID tokens from either platform.
const IOS_CLIENT_ID =
  '280343146266-l4k8d1asco7s5ggbjdb98cha8u8ta7e1.apps.googleusercontent.com';

export function InitSocialLogin() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let cancelled = false;
    (async () => {
      try {
        const { SocialLogin } = await import('@capgo/capacitor-social-login');
        if (cancelled) return;
        await SocialLogin.initialize({
          google: {
            iOSClientId: IOS_CLIENT_ID,
          },
        });
      } catch (err) {
        // Init failure is non-fatal — the sign-in button will surface a
        // clearer error when the user actually taps it. We log so the
        // failure is visible in Safari Web Inspector during dev.
        // eslint-disable-next-line no-console
        console.warn('[social-login] init failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
