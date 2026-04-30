'use client';

// Phase 5.7.1 — Spotify connect card.
//
// Branches on Capacitor.isNativePlatform():
//
//   Native (iOS / future Android):
//     Tap Connect → SpotifyConnect.start() (native-bridge) → plugin
//     shows SwiftUI consent sheet → opens WKWebView → user signs into
//     Spotify → injected script captures the followed-artists URIs →
//     plugin resolves with the ID list → we POST to syncSpotifyFollows
//     → hard-refresh on success.
//
//   Web (desktop + mobile browsers):
//     Show inline "Connect Spotify in the Curi iOS app" prompt.
//     App Store install link + native deep link. No OAuth, no
//     URL paste, no bookmarklet — single recommended path until
//     a browser extension ships.
//
// The native consent sheet (SpotifyConsentViewController) replaces
// the URL-paste overlay from Phase 5.7. The web fallback is purely
// inline copy on this card.

import { useCallback, useMemo, useState, useTransition } from 'react';
import { Capacitor } from '@capacitor/core';
import { Loader2, RefreshCw, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SpotifyConnect,
  isSpotifyConnectError,
  type SpotifyConnectErrorCode,
} from '@/lib/spotify/native-bridge';
import {
  syncSpotifyFollows,
  disconnectSpotify,
  type SyncResult,
} from '@/app/actions/sync-spotify-follows';

type Props = {
  /** Spotify user ID extracted at first connection. May be null even
   *  when connected (the WKWebView flow doesn't capture this id). */
  initialUserId: string | null;
  /** ISO timestamp of last successful sync, or null. */
  initialLastSyncedAt: string | null;
  /** Whether the user has any user_spotify_follows rows. The card uses
   *  this as the canonical "connected?" predicate since
   *  initialUserId is no longer captured by the WKWebView flow. */
  hasFollows: boolean;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'refreshing' }
  | { kind: 'disconnecting' }
  | { kind: 'error'; message: string };

export function SpotifyConnectCard({
  initialUserId,
  initialLastSyncedAt,
  hasFollows,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [, startTransition] = useTransition();

  // Connected state: any row in user_spotify_follows OR a populated
  // user_prefs.spotify_user_id (legacy URL-paste flow). New WKWebView
  // flow only sets the rows.
  const isConnected = hasFollows || !!initialUserId;

  const isNative = useMemo(() => Capacitor.isNativePlatform(), []);

  // ─── Native: trigger Capacitor plugin ────────────────────────────

  const runNativeFlow = useCallback(
    async (mode: 'connect' | 'refresh') => {
      setStatus({ kind: mode === 'refresh' ? 'refreshing' : 'connecting' });
      try {
        const result =
          mode === 'refresh'
            ? await SpotifyConnect.refresh()
            : await SpotifyConnect.start();
        const sync: SyncResult = await syncSpotifyFollows(result.ids);
        if (sync.ok) {
          // Hard-refresh so all RSCs re-render with the new follow set.
          // Same pattern as the SC connect card.
          window.location.href = '/';
        } else {
          setStatus({
            kind: 'error',
            message: serverErrorMessage(sync.error),
          });
        }
      } catch (err) {
        if (isSpotifyConnectError(err)) {
          if (err.code === 'USER_CANCELLED') {
            // Silent: user backed out, no toast needed.
            setStatus({ kind: 'idle' });
            return;
          }
          setStatus({
            kind: 'error',
            message: nativeErrorMessage(err.code, err.message),
          });
          return;
        }
        setStatus({
          kind: 'error',
          message: 'Something went wrong. Try again in a moment.',
        });
      }
    },
    [],
  );

  // ─── Disconnect ─────────────────────────────────────────────

  const onDisconnect = useCallback(() => {
    setStatus({ kind: 'disconnecting' });
    startTransition(async () => {
      const result = await disconnectSpotify();
      if (result.ok) {
        window.location.href = '/profile';
      } else {
        setStatus({
          kind: 'error',
          message: 'Could not disconnect. Try again in a moment.',
        });
      }
    });
  }, []);

  // ─── Render ──────────────────────────────────────────────────

  const isBusy = status.kind === 'connecting' || status.kind === 'refreshing' || status.kind === 'disconnecting';

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Spotify follows
        </h3>
        <span className="text-2xs text-fg-dim">Imported from your account</span>
      </div>

      <div className="curi-glass rounded-2xl p-5 shadow-card">
        {isConnected ? (
          <ConnectedSummary
            lastSyncedAt={initialLastSyncedAt}
            onRefresh={isNative ? () => runNativeFlow('refresh') : undefined}
            onDisconnect={onDisconnect}
            disabled={isBusy}
            isNative={isNative}
          />
        ) : isNative ? (
          <DisconnectedRowNative
            onConnect={() => runNativeFlow('connect')}
            disabled={isBusy}
          />
        ) : (
          <DisconnectedRowWeb />
        )}
      </div>

      {status.kind === 'connecting' && <ProgressBar label="Opening Spotify…" />}
      {status.kind === 'refreshing' && <ProgressBar label="Refreshing your follows…" />}
      {status.kind === 'disconnecting' && <ProgressBar label="Disconnecting…" />}
      {status.kind === 'error' && (
        <ErrorBar message={status.message} onDismiss={() => setStatus({ kind: 'idle' })} />
      )}
    </section>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function DisconnectedRowNative({
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

function DisconnectedRowWeb() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Spotify connect is available in the Curi iOS app. Sync the artists
        you follow on Spotify so events featuring them rise to the top of
        your feed.
      </p>
      <a
        href="https://apps.apple.com/app/curi/id0"
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-pill px-4 py-2',
          'bg-spotify-green text-bg-deep shadow-glow-spotify-sm',
          'font-display text-2xs font-semibold',
          'transition duration-micro ease-expo',
          'hover:opacity-90 active:scale-[0.97]',
        )}
      >
        Get Curi for iOS
        <ArrowUpRight className="h-3 w-3" strokeWidth={2.5} />
      </a>
      <p className="text-2xs text-fg-dim">
        Once connected on iOS, your follows sync to web automatically.
      </p>
    </div>
  );
}

function ConnectedSummary({
  lastSyncedAt,
  onRefresh,
  onDisconnect,
  disabled,
  isNative,
}: {
  lastSyncedAt: string | null;
  onRefresh?: () => void;
  onDisconnect: () => void;
  disabled: boolean;
  isNative: boolean;
}) {
  const ageLabel = useMemo(
    () => (lastSyncedAt ? formatRelativeAge(lastSyncedAt) : null),
    [lastSyncedAt],
  );

  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full bg-spotify-green shadow-glow-spotify-sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg-primary">
          <span className="text-spotify-green">Connected</span>
        </div>
        {ageLabel && (
          <div className="text-2xs text-fg-muted tabular">
            Last synced {ageLabel}
          </div>
        )}
      </div>
      {isNative && onRefresh && (
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
      )}
      <button
        type="button"
        onClick={onDisconnect}
        disabled={disabled}
        className={cn(
          'shrink-0 rounded-pill px-3 py-1.5',
          'text-2xs font-medium text-fg-muted',
          'transition hover:text-fg-primary active:scale-[0.97]',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        Disconnect
      </button>
    </div>
  );
}

function ProgressBar({ label }: { label: string }) {
  return (
    <div className="mt-3 curi-glass rounded-2xl p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-spotify-green"
          strokeWidth={2.5}
          aria-hidden
        />
        <span className="text-2xs font-medium text-fg-muted">{label}</span>
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

function ErrorBar({
  message,
  onDismiss,
}: {
  message: string;
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
          {message}
        </p>
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

// ─── Helpers ────────────────────────────────────────────────────────────

function nativeErrorMessage(
  code: SpotifyConnectErrorCode,
  detail?: string,
): string {
  switch (code) {
    case 'TIMEOUT':
      return "Spotify took too long to load. Try connecting again.";
    case 'NETWORK_OFFLINE':
      return "You're offline. Connect to the internet and try again.";
    case 'INVALID_PAYLOAD':
      return 'Spotify returned an unexpected response. Try connecting again.';
    case 'NO_VIEW_CONTROLLER':
      return 'Could not open Spotify. Try restarting the app.';
    case 'SCRAPE_FAILED':
      return detail ?? 'Could not import your follows. Make sure your Spotify profile is set to public.';
    case 'USER_CANCELLED':
    default:
      return 'Connection cancelled.';
  }
}

function serverErrorMessage(error: 'unauth' | 'invalid_payload' | 'db_failed'): string {
  switch (error) {
    case 'unauth':
      return 'Sign in required. Refresh the page and sign in again.';
    case 'invalid_payload':
      return "Spotify didn't return any followed artists. Make sure your profile is public.";
    case 'db_failed':
      return 'Could not save your follows. Try again in a moment.';
  }
}

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
