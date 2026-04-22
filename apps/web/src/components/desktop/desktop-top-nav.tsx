// Sticky, full-width glass top nav shown at `lg` (≥1024px) and above.
//
// Anatomy (left → right):
//   "curi NYC" wordmark   — links to /, same brand thread as the
//                           mobile AppHeader and the login screen
//   3 nav pill links      — Browse / Saved / Profile (client component
//                           so it can read usePathname for active state)
//   Avatar or Sign-in CTA — mirrors AppHeader's right-side behavior
//
// This component is only rendered at `lg:` breakpoints via the
// parent page's `hidden lg:block` wrapper. The mobile AppHeader +
// BottomNav stay responsible for their half of the breakpoint.
//
// Kept as a server component — same shape as <AppHeader/>. Auth is
// fetched inline, so any page rendering <DesktopTopNav/> doesn't
// have to re-fetch the user.

import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getMyProfile } from '@/lib/profile';
import { DesktopNavLinks } from '@/components/desktop/desktop-nav-links';

export async function DesktopTopNav() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    <header
      className={
        // Sticky at the top, full-width, glass background with a
        // hairline divider. z-30 sits under the filter sheet backdrop
        // (z-40) so a modal always covers it.
        'sticky top-0 z-30 border-b border-border bg-bg-deep/70 backdrop-blur-glass'
      }
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-8 py-4">
        {/* Left: brand wordmark + NYC badge */}
        <Link
          href="/"
          aria-label="Curi home"
          className="flex items-center gap-2.5 rounded-pill px-1 transition hover:opacity-80"
        >
          {/* h1 here (rather than span) so desktop pages keep a page-level
              heading after AppHeader's mobile h1 is gated out by lg:hidden.
              Mobile + desktop headers are mutually exclusive via breakpoint
              gating, so only one h1 ever renders per page. */}
          <h1 className="font-display text-xl font-semibold tracking-display text-fg-primary">
            curi
          </h1>
          <span className="rounded-pill border border-border px-2 py-0.5 text-2xs uppercase tracking-widest text-fg-muted">
            NYC
          </span>
        </Link>

        {/* Center: pill nav links (client, for usePathname active state).
            Hidden on narrow desktop (<1280px) to avoid crowding — the
            avatar still routes users to /profile, and /saved remains
            accessible via deep link and the mobile bottom-nav. */}
        <div className="hidden xl:flex">
          <DesktopNavLinks />
        </div>

        {/* Right: avatar or sign-in CTA. On the "narrow desktop" range
            (1024-1279px) we show the nav links here too, condensed next
            to the avatar — keeps nav reachable at lg without overlapping
            the wordmark. */}
        <div className="flex items-center gap-3">
          <div className="flex xl:hidden">
            <DesktopNavLinks />
          </div>
          {user ? (
            <Link
              href="/profile"
              aria-label="Profile"
              className="shrink-0 rounded-full ring-offset-2 ring-offset-bg-deep focus-visible:ring-2 focus-visible:ring-accent"
            >
              {avatar ? (
                // Avatar images come from Google or our avatars bucket —
                // both hosts are allowlisted when 3.7 swaps to next/image.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar}
                  alt={name}
                  className="h-9 w-9 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-elevated text-sm font-semibold text-fg-primary">
                  {name.charAt(0).toUpperCase() || '·'}
                </div>
              )}
            </Link>
          ) : (
            <Link
              href="/login"
              className="rounded-pill border border-accent/30 bg-accent-chip px-4 py-2 text-xs font-medium text-accent transition hover:bg-accent/20"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
