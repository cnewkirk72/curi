// Profile — account identity, save count, taste preferences, sign-out.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bookmark, ArrowUpRight } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { DesktopTopNav } from '@/components/desktop/desktop-top-nav';
import { PreferencesForm } from '@/components/preferences-form';
import { ProfileForm } from '@/components/profile-form';
import { ConnectorsSection } from '@/components/profile/connectors-section';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/lib/supabase/actions';
import { getSaveCount } from '@/lib/saves';
import { getUserPrefs } from '@/lib/preferences';
import { getMyProfile } from '@/lib/profile';
import { getSoundcloudConnection } from '@/lib/soundcloud-connection';
import { getSpotifyConnection } from '@/lib/spotify-connection';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?next=/profile');

  const [saveCount, prefs, profile, scConnection, spotifyConnection] = await Promise.all([
    getSaveCount(),
    getUserPrefs(),
    getMyProfile(),
    getSoundcloudConnection(),
    getSpotifyConnection(),
  ]);

  const googleAvatarUrl =
    (user.user_metadata?.picture as string | undefined) ??
    (user.user_metadata?.avatar_url as string | undefined) ??
    null;

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

        <ProfileForm
          initial={
            profile ?? {
              id: user.id,
              username: null,
              display_name: null,
              avatar_url: null,
              created_at: new Date(0).toISOString(),
              updated_at: new Date(0).toISOString(),
            }
          }
          googleAvatarUrl={googleAvatarUrl}
          emailFallback={user.email ?? null}
        />

        <ConnectorsSection
          spotifyUserId={spotifyConnection.userId}
          spotifyLastSyncedAt={spotifyConnection.lastSyncedAt}
          soundcloudUsername={scConnection.username}
          soundcloudLastSyncedAt={scConnection.lastSyncedAt}
        />

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
