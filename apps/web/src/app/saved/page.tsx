// Saved events feed.

import Link from 'next/link';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { DesktopTopNav } from '@/components/desktop/desktop-top-nav';
import { EventCard } from '@/components/event-card';
import { getSavedEvents } from '@/lib/saves';
import {
  getUserFollowedSoundcloudUsernames,
  getUserFollowedSpotifyArtistIds,
} from '@/lib/follows';
import { getUserPrefs } from '@/lib/preferences';
import { feedScore } from '@/lib/enrichment';
import { createClient } from '@/lib/supabase/server';
import { nycDayKey, groupLabel } from '@/lib/format';
import type { FeedEvent } from '@/lib/events';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type DayGroup = { dayKey: string; events: FeedEvent[] };

function groupByDay(
  events: FeedEvent[],
  followedScUsernames: Set<string>,
  followedSpotifyArtistIds: Set<string>,
  preferredGenres: ReadonlySet<string>,
): DayGroup[] {
  const buckets = new Map<string, FeedEvent[]>();
  for (const ev of events) {
    const key = nycDayKey(ev.starts_at);
    const list = buckets.get(key);
    if (list) list.push(ev);
    else buckets.set(key, [ev]);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([dayKey, evs]) => ({
      dayKey,
      events: [...evs].sort((a, b) => {
        const diff =
          feedScore(
            b,
            followedScUsernames,
            followedSpotifyArtistIds,
            preferredGenres,
          ) -
          feedScore(
            a,
            followedScUsernames,
            followedSpotifyArtistIds,
            preferredGenres,
          );
        if (diff !== 0) return diff;
        if (a.starts_at !== b.starts_at)
          return a.starts_at < b.starts_at ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      }),
    }));
}

export default async function SavedPage() {
  const supabase = createClient();

  const [
    savedEvents,
    followedScUsernames,
    followedSpotifyArtistIds,
    prefs,
    {
      data: { user },
    },
  ] = await Promise.all([
    getSavedEvents(),
    getUserFollowedSoundcloudUsernames(),
    getUserFollowedSpotifyArtistIds(),
    getUserPrefs(),
    supabase.auth.getUser(),
  ]);

  const followedScUsernameSet = new Set(followedScUsernames);
  const followedSpotifyArtistIdSet = new Set(followedSpotifyArtistIds);
  const preferredGenresSet: ReadonlySet<string> = new Set(prefs.preferred_genres);

  const groups = groupByDay(
    savedEvents,
    followedScUsernameSet,
    followedSpotifyArtistIdSet,
    preferredGenresSet,
  );
  const total = savedEvents.length;

  return (
    <div className="relative min-h-dvh">
      <div className="hidden lg:block">
        <DesktopTopNav />
      </div>

      <main
        className={cn(
          'relative mx-auto max-w-[430px] px-5 pb-28 pt-10',
          'lg:max-w-5xl lg:px-8 lg:pb-16 lg:pt-10',
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 top-10 h-60 w-60 rounded-full bg-violet/15 blur-3xl animate-blob lg:hidden"
        />

        <AppHeader />

        <section className="relative mt-4 mb-8 animate-enter-up">
          <p className="font-display text-2xs uppercase tracking-widest text-accent">
            Saved
          </p>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-2xl font-semibold leading-tight tracking-display">
              Your list
            </h2>
            {user && total > 0 && (
              <span className="shrink-0 text-2xs text-fg-muted tabular">
                {total} {total === 1 ? 'event' : 'events'}
              </span>
            )}
          </div>
        </section>

        {!user ? (
          <SignedOutCta />
        ) : total === 0 ? (
          <EmptyState />
        ) : (
          <Feed
            groups={groups}
            followedScUsernameSet={followedScUsernameSet}
            followedSpotifyArtistIdSet={followedSpotifyArtistIdSet}
          />
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function Feed({
  groups,
  followedScUsernameSet,
  followedSpotifyArtistIdSet,
}: {
  groups: DayGroup[];
  followedScUsernameSet: Set<string>;
  followedSpotifyArtistIdSet: Set<string>;
}) {
  return (
    <div className="relative space-y-10">
      {groups.map(({ dayKey, events }) => (
        <section key={dayKey} aria-labelledby={`saved-group-${dayKey}`}>
          <div className="mb-3 flex items-baseline justify-between">
            <h3
              id={`saved-group-${dayKey}`}
              className="font-display text-xs font-medium uppercase tracking-widest text-fg-muted"
            >
              {groupLabel(dayKey)}
            </h3>
            <span className="text-2xs text-fg-dim tabular">
              {events.length} {events.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          <div
            className={cn(
              'space-y-4',
              'lg:grid lg:grid-cols-2 lg:gap-5 lg:space-y-0',
              'xl:grid-cols-3',
            )}
          >
            {events.map((ev) => (
              <EventCard
                key={ev.id}
                event={ev}
                saved
                followedSoundcloudUsernames={followedScUsernameSet}
                followedSpotifyArtistIds={followedSpotifyArtistIdSet}
                signedIn
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="curi-glass rounded-2xl p-8 text-center shadow-card">
      <p className="font-display text-lg font-semibold text-fg-primary">
        Nothing saved yet.
      </p>
      <p className="mt-2 text-sm text-fg-muted">
        Tap the bookmark on any event to add it here. Saved events stay
        synced across your devices.
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex items-center justify-center rounded-pill border border-border-strong bg-bg-elevated px-5 py-2.5 font-display text-xs font-semibold text-fg-primary transition hover:bg-bg-elevated-hover active:scale-[0.97]"
      >
        Browse the feed
      </Link>
    </div>
  );
}

function SignedOutCta() {
  return (
    <div className="curi-glass rounded-2xl p-8 text-center shadow-card">
      <p className="font-display text-lg font-semibold text-fg-primary">
        Sign in to save events.
      </p>
      <p className="mt-2 text-sm text-fg-muted">
        Saved events sync across your devices. Google sign-in only — no
        password, no email spam.
      </p>
      <Link
        href="/login?next=/saved"
        className="mt-5 inline-flex items-center justify-center rounded-pill bg-accent px-5 py-2.5 font-display text-xs font-semibold text-bg-deep shadow-glow transition hover:bg-accent-hover active:scale-[0.97]"
      >
        Sign in with Google
      </Link>
    </div>
  );
}
