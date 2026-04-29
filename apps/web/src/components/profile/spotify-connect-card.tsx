'use client';

// Phase 5.7 — Spotify connect card.
//
// Lives inside ConnectorsSection on /profile, above the existing
// SoundcloudConnectCard. Two states:
//
//   Disconnected
//     ┌───────────────────────────────────────────────────────┐
//     │ Sync the artists you follow on Spotify so events      │
//     │ featuring them rise to the top of your feed.          │
//     │                                            [Connect →]│
//     └───────────────────────────────────────────────────────┘
//
//   Connected (mirrors SoundcloudConnectCard's ConnectedSummary)
//     ┌───────────────────────────────────────────────────────┐
//     │ ● Connected via @user-1249423375                      │
//     │   Last synced X ago             [↻ Refresh] / [Edit] │
//     └───────────────────────────────────────────────────────┘
//
// Tapping Connect mounts the SpotifyOnboardingOverlay (the 4-page
// swipe + URL paste). Tapping Refresh re-runs the sync against the
// stored spotify_user_id (no overlay; same flow SC's card uses).
// Tapping Edit reopens the overlay so the user can paste a new URL.
//
// The dot color + handle accent are spotify-green (#1ED760), matching
// the EventCard / LineupList FollowDotStack vocabulary.
//
// Brand alignment matches the existing SoundcloudConnectCard so the
// two connectors feel like siblings: same .curi-glass chrome, same
// padding, same disconnected-state vertical rhythm.

import { useCallback, useMemo, useState, useTransition } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SpotifyOnboardingOverlay } from '@/components/profile/spotify-onboarding-overlay';
import {
  syncSpotifyFollows,
  type SyncResult,
} from '@/app/actions/sync-spotify-follows';

type Props = {
  /** The user's Spotify user ID extracted at first connection.
   *  Numeric (legacy) or alphanumeric. Null when never connected. */
  initialUserId: string | null;
  /** ISO timestamp of last successful sync, or null. */
  initialLastSyncedAt: string | null;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'overlay-open' }
  | { kind: 'refreshing' }
  | { kind: 'refresh-error'; code: NonNullable<ErrorOf<SyncResult>> };

type ErrorOf<T> = T extends { ok: false; error: infer E } ? E : never;

export function SpotifyConnectCard({
  initialUserId,
  initialLastSyncedAt,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const isConnected = !!initialUserId;

  const onConnectClick = useCallback(() => {
    setStatus({ kind: 'overlay-open' });
  }, []);

  const onOverlayClose = useCallback(() => {
    setStatus({ kind: 'idle' });
  }, []);

  const onOverlaySuccess = useCallback(() => {
    // Hard refresh so all RSCs re-render with the new follow set in
    // the home + saved feed sort. Same pattern as the SC connect
    // card's DoneBar success flow.
    window.location.href = '/';
  }, []);

  const onRefresh = useCallback(() => {
    if (!initialUserId) return;
    setStatus({ kind: 'refreshing' });
    startTransition(async () => {
      const result = await syncSpotifyFollows(initialUserId);
      if (result.ok) {
        window.location.href = '/';
      } else {
        setStatus({ kind: 'refresh-error', code: result.error });
      }
    });
  }, [initialUserId, startTransition]);

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Spotify follows
        </h3>
        <span className="text-2xs text-fg-dim">
          Imported from your public profile
        </span>
      </div>

      <div className="curi-glass rounded-2xl p-5 shadow-card">
        {isConnected ? (
          <ConnectedSummary
            userId={initialUserId!}
            lastSyncedAt={initialLastSyncedAt}
            onRefresh={onRefresh}
            onEdit={onConnectClick}
            disabled={isPending || status.kind === 'refreshing'}
          />
        ) : (
          <DisconnectedRow
            onConnect={onConnectClick}
            disabled={status.kind === 'overlay-open'}
          />
        )}
      </div>

      {status.kind === 'refreshing' && <RefreshingBar />}
      {status.kind === 'refresh-error' && (
        <RefreshErrorBar
          code={status.code}
          onRetry={onRefresh}
          onDismiss={() => setStatus({ kind: 'idle' })}
        />
      )}

      <SpotifyOnboardingOverlay
        open={status.kind === 'overlay-open'}
        onClose={onOverlayClose}
        onSuccess={onOverlaySuccess}
      />
    </section>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function DisconnectedRow({
  onConnect,
  disabled,
}: {
  onConnect: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-sm text-fg-muted">
        Sync the artists you follow on Spotify so events featuring them
        rise to the top of your feed.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={disabled}
        className={cn(
          'shrink-0 inline-flex items-center justify-center rounded-pill px-4 py-1.5',
          'bg-spotify-green text-bg-deep shadow-glow-spotify-sm',
          'font-display text-2xs font-semibold',
          'transition duration-micro ease-expo',
          'hover:opacity-90 active:scale-[0.97]',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        Connect
      </button>
    </div>
  );
}

function ConnectedSummary({
  userId,
  lastSyncedAt,
  onRefresh,
  onEdit,
  disabled,
}: {
  userId: string;
  lastSyncedAt: string | null;
  onRefresh: () => void;
  onEdit: () => void;
  disabled: boolean;
}) {
  const ageLabel = useMemo(
    () => (lastSyncedAt ? formatRelativeAge(lastSyncedAt) : null),
    [lastSyncedAt],
  );

  // Spotify user IDs are often numeric (1249423375) — not visually
  // friendly to surface verbatim. We render with an `@user-` prefix
  // for legibility, matching the "Connected as @{handle}" pattern
  // SC uses but acknowledging Spotify IDs aren't true handles.
  const displayHandle = `user-${userId}`;

  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full bg-spotify-green shadow-glow-spotify-sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg-primary">
          Connected as{' '}
          <span className="text-spotify-green">@{displayHandle}</span>
        </div>
        {ageLabel && (
          <div className="text-2xs text-fg-muted tabular">
            Last synced {ageLabel}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={disabled}
        aria-label="Refresh Spotify follows"
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-pill',
          'border border-border bg-bg-elevated px-3 py-1.5',
          'text-2xs font-medium text-fg-muted',
          'transition duration-micro ease-expo hover:bg-bg-elevated-hover hover:text-fg-primary',
          'active:scale-[0.97]',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <RefreshCw className="h-3 w-3" strokeWidth={2} />
        Refresh
      </button>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        className={cn(
          'shrink-0 rounded-pill px-3 py-1.5',
          'text-2xs font-medium text-fg-muted',
          'transition hover:text-fg-primary active:scale-[0.97]',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        Edit
      </button>
    </div>
  );
}

function RefreshingBar() {
  return (
    <div className="mt-3 curi-glass rounded-2xl p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-spotify-green"
          strokeWidth={2.5}
          aria-hidden
        />
        <span className="text-2xs font-medium text-fg-muted">
          Syncing your Spotify follows…
        </span>
      </div>
      <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-border">
        <div
          aria-hidden
          className="h-full w-full animate-pulse bg-spotify-green/50"
        />
      </div>
    </div>
  );
}

function RefreshErrorBar({
  code,
  onRetry,
  onDismiss,
}: {
  code: NonNullable<ErrorOf<SyncResult>>;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-3 rounded-2xl border border-amber/30 bg-amber-chip p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber"
        />
        <p className="min-w-0 flex-1 text-2xs font-medium text-amber">
          {errorMessage(code)}
        </p>
        {code !== 'unauth' && (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              'shrink-0 rounded-pill border border-amber/40 bg-amber/10 px-3 py-1',
              'text-2xs font-medium text-amber',
              'transition hover:bg-amber/20 active:scale-[0.97]',
            )}
          >
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-pill px-2 py-1 text-2xs font-medium text-amber/70 hover:text-amber"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function errorMessage(code: NonNullable<ErrorOf<SyncResult>>): string {
  switch (code) {
    case 'unauth':
      return 'Sign in required. Refresh the page and sign in again.';
    case 'invalid_url':
      return 'Stored profile URL is invalid — tap Edit to re-enter it.';
    case 'private_profile':
      return 'Spotify profile is private or returned no follows. Make sure your profile is public.';
    case 'bot_auth_failed':
      return "We're having trouble with our Spotify lookup service. Try again in a few minutes.";
    case 'scrape_failed':
      return 'Something went wrong refreshing your follows. Try again in a moment.';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatRelativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const ms = Date.now() - then;
  if (ms < 0) return 'just now';

  const min = ms / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)} minute${Math.floor(min) === 1 ? '' : 's'} ago`;

  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)} hour${Math.floor(hr) === 1 ? '' : 's'} ago`;

  const day = hr / 24;
  if (day < 30) return `${Math.floor(day)} day${Math.floor(day) === 1 ? '' : 's'} ago`;

  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
