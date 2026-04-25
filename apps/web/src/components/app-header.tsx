// Top header for authenticated app screens.
//
// Left:  "curi" wordmark + NYC badge (same as the login screen to
//        preserve the brand thread post-auth)
// Right: Profile avatar that links to /profile if signed in, or a
//        compact "Sign in" pill if not. Prefers public.profiles
//        (custom upload / Google-fallback) over the raw OAuth
//        metadata so changes on /profile propagate instantly.
//
// Kept as a server component — auth state is fetched inline rather
// than passed in as a prop, so any page wanting the header doesn't
// have to re-fetch the user.

import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getMyProfile } from '@/lib/profile';

export async function AppHeader() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Fetch profile in parallel is overkill — we only hit this path
  // when `user` exists, and a single maybeSingle is <10ms on warm
  // connections. Skipping for signed-out viewers saves the round-trip.
  const profile = user ? await getMyProfile() : null;

  const avatar =
    profile?.avatar_url ??
    (user?.user_metadata?.picture as string | undefined) ??
    (user?.user_metadata?.avatar_url as string | undefined) ??
    undefined;
  const name =
    profile?.display_name ??
    (user?.user_metadata?.full_name as string | undefined) ??
    (user?.user_metadata?.name as string | undefined) ??
    user?.email ??
    '';

  return (
    // Mobile-only: DesktopTopNav takes over at lg+. The whole header
    // is gated rather than inner elements so the pb-4 spacing also
    // collapses at desktop.
    <header className="sticky top-0 z-30 -mx-5 mb-4 flex items-center justify-between border-b border-border bg-bg-deep/70 px-5 py-3 backdrop-blur-glass lg:hidden">
      <div className="flex items-center gap-2">
        <h1 className="font-display text-lg font-semibold tracking-display">curi</h1>
        <span className="rounded-pill border border-border px-2 py-0.5 text-2xs uppercase tracking-widest text-fg-muted">
          NYC
        </span>
      </div>

      {user ? (
        <Link
          href="/profile"
          aria-label="Profile"
          className="shrink-0 rounded-full ring-offset-2 ring-offset-bg-deep focus-visible:ring-2 focus-visible:ring-accent"
        >
          {avatar ? (
            // Avatars come from either Google (lh3.googleusercontent.com)
            // or our own Supabase Storage avatars bucket. Both hosts
            // will be allowlisted when we swap to next/image in 3.7.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt={name}
              className="h-8 w-8 rounded-full border border-border object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-elevated text-xs font-semibold text-fg-primary">
              {name.charAt(0).toUpperCase() || '·'}
            </div>
          )}
        </Link>
      ) : (
        <Link
          href="/login"
          className="rounded-pill border border-accent/30 bg-accent-chip px-3 py-1.5 text-2xs font-medium text-accent transition hover:bg-accent/20"
        >
          Sign in
        </Link>
      )}
    </header>
  );
}
