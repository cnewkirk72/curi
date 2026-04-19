// Profile — account identity, save count, taste preferences, sign-out.
//
// Preferences are persisted in user_prefs (migration 0005) and
// fetched through getUserPrefs, which falls back to DEFAULT_PREFS
// for first-visit viewers who haven't saved anything yet. The form
// itself is a client component so we can debounce toggles behind
// a single explicit Save rather than firing a write per chip.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bookmark, ArrowUpRight } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { PreferencesForm } from '@/components/preferences-form';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/lib/supabase/actions';
import { getSaveCount } from '@/lib/saves';
import { getUserPrefs } from '@/lib/preferences';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Signed-out users shouldn't see this screen at all — send them to login.
  if (!user) redirect('/login?next=/profile');

  // Count is cheap (head+count only — see getSaveCount) and prefs
  // is a single row lookup. Both are auth-gated by RLS so they run
  // *after* we know there's a session, but they're independent of
  // each other — parallelize.
  const [saveCount, prefs] = await Promise.all([
    getSaveCount(),
    getUserPrefs(),
  ]);

  const name =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email ??
    'You';
  const avatar = user.user_metadata?.avatar_url as string | undefined;

  return (
    <div className="relative min-h-dvh">
      <main className="relative mx-auto max-w-[430px] px-5 pb-28 pt-10">
        <AppHeader />

        <section className="mt-4 mb-8 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            Profile
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display">
            Your account
          </h2>
        </section>

        {/* ── Identity card ───────────────────────────────────────── */}
        <div className="curi-glass rounded-2xl p-5 shadow-card">
          <div className="flex items-center gap-4">
            {avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatar}
                alt=""
                className="h-12 w-12 rounded-full border border-border"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-bg-elevated text-sm font-semibold text-fg-primary">
                {name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg-primary">
                {name}
              </div>
              <div className="truncate text-2xs text-fg-muted">
                {user.email}
              </div>
            </div>
            <span className="shrink-0 rounded-pill border border-border bg-bg-elevated px-2.5 py-1 text-2xs text-fg-muted">
              Google
            </span>
          </div>
        </div>

        {/* ── Stats / shortcuts ───────────────────────────────────── */}
        <section className="mt-6">
          <h3 className="mb-3 font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
            Your activity
          </h3>
          <Link
            href="/saved"
            className="curi-glass group flex items-center gap-4 rounded-2xl p-4 shadow-card transition duration-micro ease-expo active:scale-[0.98]"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-accent-chip text-accent">
              <Bookmark className="h-5 w-5" strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-display text-lg font-semibold text-fg-primary tabular">
                {saveCount}
              </div>
              <div className="text-2xs text-fg-muted">
                {saveCount === 1 ? 'saved event' : 'saved events'}
              </div>
            </div>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-fg-dim transition group-hover:text-fg-muted" />
          </Link>
        </section>

        {/* ── Preferences ─────────────────────────────────────────── */}
        <PreferencesForm initial={prefs} />

        <form action={signOut} className="mt-8">
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-pill border border-border-strong bg-bg-elevated px-5 py-3 text-sm font-medium text-fg-muted transition hover:bg-bg-elevated-hover hover:text-fg-primary"
          >
            Sign out
          </button>
        </form>
      </main>

      <BottomNav />
    </div>
  );
}
