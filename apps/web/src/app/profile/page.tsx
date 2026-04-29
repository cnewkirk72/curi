// Profile — account identity, save count, taste preferences, sign-out.
//
// Identity (username / display name / avatar) lives in public.profiles
// and is edited through <ProfileForm>, which wraps the server actions
// in lib/profile-actions.ts. Taste prefs live in user_prefs and are
// edited through <PreferencesForm>. The two forms own disjoint slices
// of state, so they can be saved independently — tapping Save on one
// does not disturb the other's drafts.
//
// Preferences are persisted in user_prefs (migration 0005) and
// fetched through getUserPrefs, which falls back to DEFAULT_PREFS
// for first-visit viewers who haven't saved anything yet.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bookmark, ArrowUpRight } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { DesktopTopNav } from '@/components/desktop/desktop-top-nav';
import { PreferencesForm } from '@/components/preferences-form';
import { ProfileForm } from '@/components/profile-form';
import { SoundcloudConnectCard } from '@/components/profile/soundcloud-connect-card';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/lib/supabase/actions';
import { getSaveCount } from '@/lib/saves';
import { getUserPrefs } from '@/lib/preferences';
import { getMyProfile } from '@/lib/profile';
import { getSoundcloudConnection } from '@/lib/soundcloud-connection';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Signed-out users shouldn't see this screen at all — send them to login.
  if (!user) redirect('/login?next=/profile');

  // Count is cheap (head+count only — see getSaveCount), prefs is a
  // single row lookup, profile is a single row lookup, and the SC
  // connection state is a 2-column projection of the same prefs row
  // we read above (kept in a separate fetcher rather than folded into
  // getUserPrefs to avoid widening the UserPrefs type that PreferencesForm
  // depends on). All four are auth-gated by RLS so they run *after* we
  // know there's a session, but they're independent of each other —
  // parallelize.
  const [saveCount, prefs, profile, scConnection] = await Promise.all([
    getSaveCount(),
    getUserPrefs(),
    getMyProfile(),
    getSoundcloudConnection(),
  ]);

  // Google OAuth stores the profile picture under two different keys
  // depending on when Supabase last updated (`picture` on newer
  // sessions, `avatar_url` on older). Prefer the newer, fall back.
  const googleAvatarUrl =
    (user.user_metadata?.picture as string | undefined) ??
    (user.user_metadata?.avatar_url as string | undefined) ??
    null;

  // Identity-card display values. Prefer profile.display_name /
  // username if set; fall back to Google's full_name / email so
  // first-visit signins don't look like empty placeholders.
  const displayName =
    profile?.display_name ??
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email ??
    'You';
  const cardAvatar = profile?.avatar_url ?? googleAvatarUrl;
  const handle = profile?.username ?? null;

  return (
    <div className="relative min-h-dvh">
      <div className="hidden lg:block">
        <DesktopTopNav />
      </div>

      {/* Container: keep narrow on desktop too — Profile is a
          form-heavy screen and 100ch-wide form fields feel awkward.
          Slightly wider than mobile (~520px) gives the identity card
          some breathing room without turning the form into a table. */}
      <main className="relative mx-auto max-w-[430px] px-5 pb-28 pt-10 lg:max-w-[560px] lg:pb-16 lg:pt-10">
        <AppHeader />

        <section className="mt-4 mb-8 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            Profile
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-display">
            Your account
          </h2>
        </section>

        {/* ── Identity card — summary only; edit is below in ProfileForm ── */}
        <div className="curi-glass rounded-2xl p-5 shadow-card">
          <div className="flex items-center gap-4">
            {cardAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cardAvatar}
                alt=""
                className="h-12 w-12 rounded-full border border-border object-cover"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-bg-elevated text-sm font-semibold text-fg-primary">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg-primary">
                {displayName}
              </div>
              <div className="truncate text-2xs text-fg-muted">
                {handle ? `@${handle}` : (user.email ?? '')}
              </div>
            </div>
            <span className="shrink-0 rounded-pill border border-border bg-bg-elevated px-2.5 py-1 text-2xs text-fg-muted">
              Google
            </span>
          </div>
        </div>

        {/* ── Stats / shortcuts ──────────────────────────────── */}
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

        {/* ── Identity editor ──────────────────────────────────── */}
        {/* Always render even when `profile` is null — getMyProfile
            returns null if the handle_new_user trigger failed. The
            form falls back to empty strings as drafts, so saving
            still works (update → unique-violation or success). */}
        <ProfileForm
          initial={
            profile ?? {
              id: user.id,
              username: null,
              display_name: null,
              avatar_url: null,
              // These two are read-only in the form; synthesize safe
              // fallbacks so the type is satisfied.
              created_at: new Date(0).toISOString(),
              updated_at: new Date(0).toISOString(),
            }
          }
          googleAvatarUrl={googleAvatarUrl}
          emailFallback={user.email ?? null}
        />

        {/* ── SoundCloud follow-graph connect (Phase 5.6.1) ──
            Lives between the identity editor and the taste prefs so
            the "wire up an external account" mental category sits
            visually next to the OAuth identity card above it, while
            the within-Curi taste sliders stay grouped below. */}
        <SoundcloudConnectCard
          initialUsername={scConnection.username}
          initialLastSyncedAt={scConnection.lastSyncedAt}
        />

        {/* ── Preferences ───────────────────────────────── */}
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
