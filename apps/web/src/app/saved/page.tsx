// Saved events placeholder — proper version (empty-state + saved list
// query against user_saves) lands in Phase 3.9.

import Link from 'next/link';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function SavedPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="relative min-h-dvh">
      <main className="relative mx-auto max-w-[430px] px-5 pb-28 pt-10">
        <AppHeader />

        <section className="mt-4 mb-8 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            Saved
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display">
            Your list
          </h2>
        </section>

        <div className="curi-glass rounded-2xl p-8 text-center shadow-card">
          {user ? (
            <>
              <p className="font-display text-lg font-semibold text-fg-primary">
                Nothing saved yet.
              </p>
              <p className="mt-2 text-sm text-fg-muted">
                Tap the bookmark on any event to save it here. Full Saved
                screen lands in Phase 3.9.
              </p>
            </>
          ) : (
            <>
              <p className="font-display text-lg font-semibold text-fg-primary">
                Sign in to save events.
              </p>
              <p className="mt-2 text-sm text-fg-muted">
                Saved events sync across your devices. Google sign-in only —
                no password, no email spam.
              </p>
              <Link
                href="/login"
                className="mt-5 inline-flex items-center justify-center rounded-pill bg-accent px-5 py-2.5 font-display text-xs font-semibold text-bg-deep shadow-glow transition hover:bg-accent-hover active:scale-[0.97]"
              >
                Sign in with Google
              </Link>
            </>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
