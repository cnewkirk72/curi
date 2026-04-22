// 3-item bottom navigation, fixed to the viewport. Active tab is
// derived from the URL on the server — no client-side state needed
// for a static 3-item nav, and doing it server-side means the active
// indicator is already painted in the HTML response.
//
// Design: 3 items (under Material's 5-item cap), cyan active indicator
// above the icon, backdrop-blurred background. See MASTER.md → Bottom
// navigation recipe.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, Bookmark, User } from 'lucide-react';
import { cn } from '@/lib/utils';

type NavItem = {
  label: string;
  href: string;
  icon: typeof Compass;
  // matchesPrefix lets /events/[id] keep the Browse tab active
  matchesPrefix?: string[];
};

const ITEMS: NavItem[] = [
  { label: 'Browse', href: '/', icon: Compass, matchesPrefix: ['/events'] },
  { label: 'Saved', href: '/saved', icon: Bookmark },
  { label: 'Profile', href: '/profile', icon: User },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[430px]',
        // Glass backdrop + top-edge hairline
        'border-t border-border bg-bg-base/80 backdrop-blur-glass',
        'shadow-nav-top',
        // Respect the iOS home-indicator safe area
        'pb-[env(safe-area-inset-bottom)]',
        // Desktop: the DesktopTopNav takes over, hide the bottom nav
        // entirely so it doesn't eat 64px at the bottom of every
        // lg+ viewport. Mobile PWA (iOS/Android) never hits `lg`,
        // so the home-screen app is unaffected.
        'lg:hidden',
      )}
    >
      <ul className="flex items-stretch justify-around px-2 pt-2">
        {ITEMS.map((item) => {
          const active =
            pathname === item.href ||
            (item.matchesPrefix?.some((p) => pathname.startsWith(p)) ?? false);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-16 flex-col items-center justify-center gap-1',
                  'text-2xs font-medium tracking-tight transition-colors duration-micro',
                  active ? 'text-accent' : 'text-fg-muted hover:text-fg-primary',
                )}
              >
                {/* 3px cyan dot above the icon when active */}
                <span
                  aria-hidden
                  className={cn(
                    'h-[3px] w-[3px] rounded-full transition-all',
                    active ? 'bg-accent shadow-glow-sm' : 'bg-transparent',
                  )}
                />
                <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
