'use client';

// Client-side nav links for DesktopTopNav. Rendered as a sibling of
// the wordmark + avatar in the parent server component. Split off so
// active-state detection (via usePathname) doesn't force the whole
// header to opt out of the server render.
//
// Why 3 items, same as mobile: keeps the information architecture
// identical across breakpoints so muscle memory transfers. A user
// who learns "Saved is second" on their phone finds it second on
// their laptop too.

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

export function DesktopNavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {ITEMS.map((item) => {
        const active =
          pathname === item.href ||
          (item.matchesPrefix?.some((p) => pathname.startsWith(p)) ?? false);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // Pill-button nav item, 44px+ tall for touch-target compliance
              // at any breakpoint, tighter px than mobile since we have room.
              'inline-flex items-center gap-2 rounded-pill px-4 py-2',
              'font-display text-xs font-medium tracking-tight',
              'transition duration-micro ease-expo active:scale-[0.97]',
              active
                ? // Active: subtle cyan chip fill + cyan text, matches
                  // the filter-bar's "on" state for visual coherence.
                  'bg-accent-chip text-accent shadow-glow-sm'
                : 'text-fg-muted hover:bg-bg-elevated-hover hover:text-fg-primary',
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={2} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
