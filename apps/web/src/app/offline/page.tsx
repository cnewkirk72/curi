// Offline fallback route.
//
// The service worker precaches this HTML on install and serves it
// when a navigation request fails (airplane mode, dead wifi, tunnel,
// etc.). It's a real Next.js route (not a raw /public html file) so
// it picks up the app's fonts + Tailwind styling, and so we can
// iterate on copy without touching the SW.
//
// Intentionally simple: no header, no nav, no data fetches. Anything
// that needs Supabase would fail here too.

import Link from 'next/link';
import { WifiOff } from 'lucide-react';

// Static render — no session, no queries, cheap to precache.
export const dynamic = 'force-static';

export const metadata = {
  title: 'Offline — Curi',
  description: "You're offline. Curi will pick back up once you have signal.",
};

export default function OfflinePage() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-6">
      {/* Single ambient blob so the page isn't a flat void — ties
          visually to the rest of the app without needing any of the
          chrome that lives in BottomNav/AppHeader. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
      </div>

      <main className="relative mx-auto max-w-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-pill border border-border bg-bg-elevated text-accent">
          <WifiOff className="h-6 w-6" strokeWidth={2} />
        </div>

        <h1 className="mt-6 font-display text-2xl font-semibold leading-tight tracking-display text-fg-primary">
          You&apos;re offline.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Curi needs a connection to pull the latest feed. We&apos;ll refresh
          the moment you&apos;re back on wifi or cell.
        </p>

        <Link
          href="/"
          className="mt-8 inline-flex items-center justify-center rounded-pill bg-accent px-5 py-2.5 font-display text-xs font-semibold text-bg-deep shadow-glow transition hover:bg-accent-hover active:scale-[0.97]"
        >
          Try again
        </Link>
      </main>
    </div>
  );
}
