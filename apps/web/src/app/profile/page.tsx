// Profile placeholder — proper version (genre preferences, save-count,
// notification settings) lands in Phase 3.9. This page surfaces the
// sign-out action so Phase 3.6 is end-to-end clickable.

import { redirect } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/lib/supabase/actions';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Signed-out users shouldn't see this screen at all — send them to login.
  if (!user) redirect('/login?next=/profile');

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

        <p className="mt-6 text-xs text-fg-muted">
          Genre preferences, save count, and notification settings arrive in
          Phase 3.9.
        </p>

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
