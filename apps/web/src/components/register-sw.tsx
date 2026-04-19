'use client';

// Service worker registrar.
//
// Mounted once in the root layout. Does nothing in development
// (Next dev already hot-reloads, and a SW hijacks caching in ways
// that confuse the dev experience — we explicitly bail when
// NODE_ENV !== 'production'). In production, registers /sw.js with
// scope /.
//
// Errors are swallowed: a failed registration is a non-fatal nice-
// to-have, not something that should surface to users. We log to
// console so the issue is visible in prod if someone's debugging.

import { useEffect } from 'react';

export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    // Defer to idle so registration doesn't fight with the initial
    // paint. A SW registering a second after first paint is fine —
    // caches populate on subsequent navigations anyway.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[sw] registration failed:', err);
        });
    };

    // Prefer requestIdleCallback when available (Chrome, Firefox),
    // otherwise fall back to a 1s setTimeout (Safari) which
    // approximates "after first paint" well enough for a one-shot
    // registration.
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    if (typeof idle === 'function') {
      idle(register);
    } else {
      window.setTimeout(register, 1000);
    }
  }, []);

  return null;
}
