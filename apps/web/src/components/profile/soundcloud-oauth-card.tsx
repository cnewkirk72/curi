'use client';

// Phase 5.8 — SoundCloud OAuth connect card.
//
// The single SC connection surface on /profile (the legacy paste card
// has been hidden — see connectors-section.tsx). The card derives its
// state from two server-passed predicates:
//
//   `connected`           — true iff a SC OAuth access token is
//                           persisted on user_prefs. This is the new
//                           canonical "connected" signal.
//   `username` (non-null) — the user has either an OAuth-fetched or a
//                           legacy paste-flow handle saved.
//
// Three render states:
//   1. CONNECTED (oauth)  — `connected === true`. Shows "Connected as
//                           @user" with a Disconnect button. SC orange
//                           dot. Happy path.
//   2. LEGACY (migration) — `!connected && username`. Shows their saved
//                           handle with an amber attention dot and a
//                           "Reconnect with SoundCloud" CTA. Same OAuth
//                           anchor as fresh connect — re-auth upgrades
//                           a legacy user in place.
//   3. DISCONNECTED       — `!connected && !username`. Shows the
//                           description + "Connect with SoundCloud"
//                           hero CTA. Cold-start path.
//
// State machine for ephemeral interactions:
//   idle → syncing → synced (transient ~3s) → idle
//   idle → disconnecting → idle
//   ?sc_error=<code>     → error state on mount (one-shot, then strip)
//   ?sc_connected=1      → triggers an auto-sync (Phase 5.9). The
//                          server already persisted tokens before
//                          redirecting; the card kicks off the
//                          /me/followings fetch as a separate step
//                          so the user gets visible progress feedback
//                          rather than a black-box redirect.
//
// Visual language matches spotify-connect-card.tsx for cross-platform
// rhyme — same .curi-glass chrome, same active-press scale. SC's brand
// orange (`bg-sc-orange`, `shadow-glow-sc-sm`) replaces Spotify green
// as the connector accent. Amber (`bg-amber`) is reserved for the
// migration/error attention signal — distinct from "connected" so a
// glance can tell the two states apart.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { disconnectSoundcloud } from '@/app/actions/disconnect-soundcloud';
import { syncSoundcloudFollowsOAuth } from '@/app/actions/sync-soundcloud-follows-oauth';

type Props = {
  /** True iff a SC OAuth access token is currently persisted on
   *  user_prefs for the signed-in user. Drives the connected/
   *  disconnected card state. */
  connected: boolean;
  /** SC profile slug (lowercased permalink) populated by the OAuth
   *  callback's /me lookup, OR by the legacy paste flow. Shown as
   *  "Connected as @{username}" when present. May be null in the
   *  edge case where OAuth tokens exist but the username column was
   *  cleared by some other flow. */
  username: string | null;
  /** ISO timestamp of the most recent follows-sync, or null if the
   *  user has never synced. Drives the "Last synced X ago" line in
   *  the connected card. Set by either the legacy paste-sync OR the
   *  Phase 5.9 OAuth sync. */
  lastSyncedAt: string | null;
  /** Number of rows in user_soundcloud_follows for this user. The
   *  connected card surfaces this as "247 artists" so the user has
   *  feedback that the integration is alive. Reads as 0 when the
   *  user follows no artists or has never synced. */
  followsCount: number;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'synced'; count: number; matchedArtists: number }
  | { kind: 'disconnecting' }
  | { kind: 'error'; message: string };

export function SoundcloudOAuthCard({
  connected,
  username,
  lastSyncedAt,
  followsCount,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [, startTransition] = useTransition();

  const router = useRouter();
  const searchParams = useSearchParams();

  // The 'synced' toast self-clears so we can use the same kind for
  // both auto and manual syncs without forcing the user to click
  // through. ~3s is long enough to read "Imported 247 artists" and
  // glance at the matched-count, short enough to not nag.
  const SYNCED_TOAST_MS = 3000;
  const syncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Sync ──────────────────────────────────────────────────────────
  //
  // The single sync entry point — called on (a) ?sc_connected=1 mount
  // (auto-sync after a fresh OAuth handshake) and (b) the connected
  // card's Refresh button. The server action is replace-not-merge,
  // so calling it repeatedly is safe.

  const runSync = useCallback(() => {
    if (syncedTimer.current) {
      clearTimeout(syncedTimer.current);
      syncedTimer.current = null;
    }
    setStatus({ kind: 'syncing' });
    startTransition(async () => {
      const result = await syncSoundcloudFollowsOAuth();
      if (result.ok) {
        setStatus({
          kind: 'synced',
          count: result.count,
          matchedArtists: result.matchedArtists,
        });
        // The server action calls revalidatePath('/profile'); refresh
        // the route so the followsCount + lastSyncedAt props re-read.
        router.refresh();
        syncedTimer.current = setTimeout(() => {
          setStatus({ kind: 'idle' });
          syncedTimer.current = null;
        }, SYNCED_TOAST_MS);
      } else {
        setStatus({
          kind: 'error',
          message: syncErrorMessage(result.error),
        });
        // For reauth_required, the server action already nulled the
        // tokens; refresh so the card flips to legacy/disconnected.
        if (result.error === 'reauth_required') {
          router.refresh();
        }
      }
    });
  }, [router]);

  // Cleanup any pending toast timer on unmount.
  useEffect(() => {
    return () => {
      if (syncedTimer.current) clearTimeout(syncedTimer.current);
    };
  }, []);

  // ─── Surface callback-redirect signals as one-shots ────────────────
  //
  // The /api/soundcloud/callback route redirects to either
  //   /profile?sc_connected=1 — success → kick off auto-sync
  //   /profile?sc_error=<code> — failure → show inline error
  //
  // Idempotency: the effect itself runs twice in dev under StrictMode,
  // and `router.replace` is async — so the URL strip can race the
  // re-mount, leaving `?sc_connected=1` visible to the second run.
  // Without the ref guard, that double-fires the (expensive) sync.
  // The ref pins "we've already handled this page-load's callback
  // signal" before the body runs anything else, so subsequent mounts
  // (StrictMode, Fast Refresh, or even a deliberate user reload) are
  // a no-op until we actually navigate to a fresh /profile load.

  const hasHandledCallback = useRef(false);

  useEffect(() => {
    if (hasHandledCallback.current) return;

    const err = searchParams.get('sc_error');
    const ok = searchParams.get('sc_connected');
    if (!err && !ok) return;

    hasHandledCallback.current = true;

    // Strip the params from the URL FIRST so a remount-mid-async sees
    // a clean URL even if the side effects below haven't completed.
    const url = new URL(window.location.href);
    url.searchParams.delete('sc_error');
    url.searchParams.delete('sc_connected');
    router.replace(url.pathname + url.search, { scroll: false });

    if (err) {
      setStatus({ kind: 'error', message: callbackErrorMessage(err) });
    } else if (ok) {
      runSync();
    }
    // Mount-only — runSync is stable via useCallback, and the ref
    // gate prevents re-entry regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Disconnect ────────────────────────────────────────────────────

  const onDisconnect = useCallback(() => {
    setStatus({ kind: 'disconnecting' });
    startTransition(async () => {
      const result = await disconnectSoundcloud();
      if (result.ok) {
        // The server action calls revalidatePath('/profile'), so we
        // just need to trigger the client-side re-fetch. router.refresh
        // is sufficient — replacing the URL with the same path is a
        // no-op-ish navigation that adds nothing here.
        router.refresh();
        setStatus({ kind: 'idle' });
      } else {
        setStatus({
          kind: 'error',
          message:
            result.error === 'unauth'
              ? 'Sign in required. Refresh the page and sign in again.'
              : 'Could not disconnect. Try again in a moment.',
        });
      }
    });
  }, [router]);

  const isBusy =
    status.kind === 'syncing' || status.kind === 'disconnecting';

  // Derived render state. Order matters: connected is canonical; a
  // legacy user is "not connected via OAuth but has a saved handle";
  // disconnected is everyone else.
  const isLegacyMigration = !connected && username !== null;

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          SoundCloud follows
        </h3>
        <span className="text-2xs text-fg-dim">
          {connected
            ? 'Active'
            : isLegacyMigration
              ? 'Upgrade recommended'
              : 'Sign in to your account'}
        </span>
      </div>

      <div className="curi-glass rounded-2xl p-5 shadow-card">
        {connected ? (
          <ConnectedSummary
            username={username}
            followsCount={followsCount}
            lastSyncedAt={lastSyncedAt}
            onRefresh={runSync}
            onDisconnect={onDisconnect}
            disabled={isBusy}
          />
        ) : isLegacyMigration ? (
          <LegacyMigrationRow username={username!} disabled={isBusy} />
        ) : (
          <DisconnectedRow disabled={isBusy} />
        )}
      </div>

      {status.kind === 'syncing' && (
        <ProgressBar label="Importing your follows…" />
      )}
      {status.kind === 'synced' && (
        <SuccessBar
          count={status.count}
          matchedArtists={status.matchedArtists}
        />
      )}
      {status.kind === 'disconnecting' && <ProgressBar label="Disconnecting…" />}
      {status.kind === 'error' && (
        <ErrorBar
          message={status.message}
          onDismiss={() => setStatus({ kind: 'idle' })}
        />
      )}
    </section>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function DisconnectedRow({ disabled }: { disabled: boolean }) {
  // Stacked layout (description above, hero CTA below) — the OAuth
  // button is the entire purpose of this card, so it gets full-width
  // visual weight rather than the side-button pattern the legacy /
  // Spotify cards use. SC's brand guidance for "Connect with
  // SoundCloud" buttons calls for the logomark + the literal label
  // on the orange brand swatch with white text.
  //
  // Anchor (not button) — the OAuth flow is a full-page navigation so
  // the signed __sc_oauth cookie can round-trip from /authorize to
  // /callback. A bare <a> to a route handler doesn't prefetch.
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Sync the artists you follow on SoundCloud so events featuring
        them rise to the top of your feed.
      </p>
      <a
        href="/api/soundcloud/authorize"
        aria-disabled={disabled || undefined}
        className={cn(
          'inline-flex w-full items-center justify-center gap-2 rounded-pill px-5 py-2.5',
          'bg-sc-orange text-white shadow-glow-sc-sm',
          'font-display text-xs font-semibold',
          'transition duration-micro ease-expo',
          'hover:opacity-90 active:scale-[0.98]',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        <SoundcloudMark className="h-4 w-4 shrink-0" />
        <span>Connect with SoundCloud</span>
      </a>
    </div>
  );
}

function LegacyMigrationRow({
  username,
  disabled,
}: {
  username: string;
  disabled: boolean;
}) {
  // The user connected via the Phase 5.6 paste flow but hasn't
  // completed an OAuth handshake. Their existing
  // user_soundcloud_follows rows still drive the feed boost via the
  // weekly cron, so this is genuinely a "soft upgrade" — nothing is
  // broken. The amber dot + "Upgrade recommended" eyebrow signal
  // attention without implying error or urgency.
  //
  // Same `/api/soundcloud/authorize` anchor as a fresh connect: the
  // callback's `UPDATE user_prefs SET soundcloud_*_token = ...` is
  // additive — once tokens land the user becomes oauthConnected and
  // this branch falls through to <ConnectedSummary /> on the next
  // server render.
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg-primary">
            @{username}
          </div>
          <div className="mt-0.5 text-2xs text-fg-muted">
            Reconnect via SoundCloud sign-in for a more reliable
            connection that stays in sync.
          </div>
        </div>
      </div>
      <a
        href="/api/soundcloud/authorize"
        aria-disabled={disabled || undefined}
        className={cn(
          'inline-flex w-full items-center justify-center gap-2 rounded-pill px-5 py-2.5',
          'bg-sc-orange text-white shadow-glow-sc-sm',
          'font-display text-xs font-semibold',
          'transition duration-micro ease-expo',
          'hover:opacity-90 active:scale-[0.98]',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        <SoundcloudMark className="h-4 w-4 shrink-0" />
        <span>Reconnect with SoundCloud</span>
      </a>
    </div>
  );
}

/**
 * SoundCloud logomark — cloud + wave bars in a single inline SVG.
 * Path traced from SoundCloud's published brand assets. Rendered with
 * `currentColor` so the parent's text color (white on the brand pill)
 * controls the fill — keeps the icon visually paired with its label
 * without needing a separate fill prop.
 */
function SoundcloudMark({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      aria-hidden
      fill="currentColor"
      className={className}
    >
      <path d="M1.175 12.225c-.051 0-.094.046-.101.1l-.233 2.154.233 2.105c.007.058.05.098.101.098.05 0 .09-.04.099-.098l.255-2.105-.27-2.154c0-.057-.045-.1-.09-.1m-.899.828c-.06 0-.091.037-.104.094L0 14.479l.165 1.308c.005.058.045.092.09.092.045 0 .089-.034.099-.092l.213-1.308-.213-1.32c-.006-.05-.05-.09-.099-.09m1.83-1.229c-.061 0-.12.045-.12.104l-.21 2.633.21 2.121c0 .063.054.108.117.108.06 0 .12-.045.12-.108l.24-2.121-.24-2.633c-.001-.06-.054-.105-.118-.104zm.974-.42c-.075 0-.135.054-.15.121l-.193 3.116.196 2.139c.001.07.07.131.151.131.075 0 .134-.061.149-.135l.255-2.137-.247-3.105c-.001-.061-.07-.13-.16-.13m1.245.398a.165.165 0 0 0-.165.166l-.222 2.745.225 2.157c0 .089.075.158.166.158.09 0 .157-.07.157-.158l.255-2.157-.27-2.745c0-.099-.075-.166-.166-.166m1.139-.038c-.105 0-.195.09-.195.18l-.21 2.595.21 2.142c.001.106.09.18.196.18.103 0 .194-.075.194-.18l.225-2.142-.225-2.61c0-.09-.09-.18-.195-.18m1.215-.273c-.121 0-.21.089-.21.21l-.187 2.85.187 2.115c0 .12.103.213.21.213a.215.215 0 0 0 .21-.213l.225-2.115-.225-2.851c0-.118-.105-.21-.225-.21m1.275-.66c-.135 0-.24.106-.24.24l-.165 3.479.165 2.094c0 .135.105.24.24.24s.24-.105.24-.24l.18-2.094-.18-3.493c0-.143-.105-.227-.24-.227zm1.319-.598a.252.252 0 0 0-.255.27l-.158 4.062.165 2.073c0 .149.106.27.255.27s.255-.121.27-.27l.165-2.073-.165-4.062c-.001-.144-.121-.27-.27-.27zm1.755.435a.236.236 0 0 0-.115-.044.249.249 0 0 0-.165.061c-.061.045-.105.135-.105.21l-.014.166-.151 3.6.16 2.043v.014c.001.06.022.114.061.165.045.061.121.099.196.099.061 0 .135-.029.18-.075.061-.05.09-.124.09-.21l.181-2.027-.18-3.78c-.005-.075-.061-.157-.135-.21m.846-.396a.296.296 0 0 0-.151-.045.34.34 0 0 0-.165.045.299.299 0 0 0-.124.255l-.105 4.169.119 2.001c0 .074.029.149.075.196a.345.345 0 0 0 .21.089c.075 0 .15-.029.21-.089a.267.267 0 0 0 .075-.196l.135-2.001-.135-4.169a.31.31 0 0 0-.143-.255zm.861-1.395a.34.34 0 0 0-.165-.045.443.443 0 0 0-.18.045.314.314 0 0 0-.18.297v.105l-.135 5.434.119 1.978a.312.312 0 0 0 .105.225c.06.061.135.09.225.09s.165-.029.225-.09a.327.327 0 0 0 .105-.225v-.014l.135-1.964-.135-5.488a.308.308 0 0 0-.119-.348zm.869-.448a.346.346 0 0 0-.18-.061.379.379 0 0 0-.196.061.337.337 0 0 0-.166.31v.014l-.119 5.834.119 2.013a.376.376 0 0 0 .12.255c.061.06.135.105.226.105.075 0 .15-.045.21-.105a.341.341 0 0 0 .12-.255l.137-2.013-.137-5.834a.339.339 0 0 0-.135-.324zm.93-.225a.401.401 0 0 0-.21-.061.358.358 0 0 0-.211.061.339.339 0 0 0-.166.299v.045l-.105 6.089.105 1.948a.402.402 0 0 0 .137.27.4.4 0 0 0 .24.105.376.376 0 0 0 .397-.375l.121-1.948-.121-6.089a.4.4 0 0 0-.187-.345m.87.106a.378.378 0 0 0-.21-.061.378.378 0 0 0-.21.061.4.4 0 0 0-.18.32l-.075 5.969.09 1.938c.001.139.061.255.166.345a.362.362 0 0 0 .224.075c.09 0 .166-.029.225-.075a.396.396 0 0 0 .166-.345l.105-1.938-.105-5.969a.395.395 0 0 0-.196-.32zm.91.21a.42.42 0 0 0-.225-.075.34.34 0 0 0-.225.075.392.392 0 0 0-.18.345l-.075 5.851.09 1.929c.001.135.061.255.166.345a.396.396 0 0 0 .555-.045.396.396 0 0 0 .105-.3l.105-1.929-.105-5.85a.451.451 0 0 0-.211-.346zm.984.331a.481.481 0 0 0-.255-.075.475.475 0 0 0-.24.075.46.46 0 0 0-.196.36l-.061 5.804.075 1.92c0 .136.061.27.166.36.075.061.166.105.255.105.09 0 .18-.045.255-.105a.47.47 0 0 0 .166-.36l.075-1.92-.075-5.804a.461.461 0 0 0-.165-.36m.78.51a.476.476 0 0 0-.255-.075.526.526 0 0 0-.27.075.477.477 0 0 0-.226.405l-.045 5.279.061 1.965c.001.137.061.27.166.36a.476.476 0 0 0 .315.121.524.524 0 0 0 .312-.121.474.474 0 0 0 .166-.36l.075-1.965-.075-5.279a.51.51 0 0 0-.224-.405zm.999.585a.42.42 0 0 0-.27-.075.45.45 0 0 0-.27.075c-.135.09-.225.243-.225.42v.014l-.029 4.704.045 1.93c.001.16.075.32.196.42a.51.51 0 0 0 .315.121.51.51 0 0 0 .315-.121.488.488 0 0 0 .195-.42l.061-1.93-.061-4.704a.524.524 0 0 0-.272-.434m.996.585a.488.488 0 0 0-.285-.09.498.498 0 0 0-.286.09.485.485 0 0 0-.225.45v.014l-.045 4.119.045 1.965c.001.193.075.36.225.473a.476.476 0 0 0 .315.119.527.527 0 0 0 .315-.119.483.483 0 0 0 .211-.473l.045-1.965-.045-4.119a.529.529 0 0 0-.27-.464m.969.6a.498.498 0 0 0-.297-.09.526.526 0 0 0-.301.09.498.498 0 0 0-.225.452l-.043 3.583.043 1.965c.001.193.105.39.225.494a.501.501 0 0 0 .315.121.485.485 0 0 0 .315-.121c.137-.105.226-.301.226-.494v-.014l.061-1.948-.061-3.583a.501.501 0 0 0-.27-.45zm15.495.255l-1.605.42c-1.005.255-1.815-.045-2.31-.345.21-1.515.405-2.91.66-4.65a.524.524 0 0 0-.105-.345.493.493 0 0 0-.225-.165 8.085 8.085 0 0 0-.66-.121c-.045-.014-.075-.043-.075-.075-.029-.495-.451-.91-.945-.91-.495 0-.91.421-.91.91l.014.061.165 5.654-.166 1.605c-.014.149.075.314.196.404.061.045.165.061.255.061h7.5c1.575 0 2.881-1.305 2.881-2.881-.06-1.604-1.319-2.91-2.880-2.91-.736-.045-1.396.166-1.96.541z" />
    </svg>
  );
}

function ConnectedSummary({
  username,
  followsCount,
  lastSyncedAt,
  onRefresh,
  onDisconnect,
  disabled,
}: {
  username: string | null;
  followsCount: number;
  lastSyncedAt: string | null;
  onRefresh: () => void;
  onDisconnect: () => void;
  disabled: boolean;
}) {
  // Status line: "247 artists · synced 2 hours ago" — combines real-
  // time integration health (count) with recency (age) on one row.
  // Falls back gracefully when either signal is missing (count === 0
  // pre-first-sync; lastSyncedAt === null for legacy-username-only
  // users who happen to have OAuth tokens but never ran the sync).
  const ageLabel = useMemo(
    () => (lastSyncedAt ? formatRelativeAge(lastSyncedAt) : null),
    [lastSyncedAt],
  );
  const countLabel =
    followsCount === 0
      ? null
      : followsCount === 1
        ? '1 artist'
        : `${followsCount.toLocaleString()} artists`;

  const subline =
    countLabel && ageLabel
      ? `${countLabel} · synced ${ageLabel}`
      : countLabel
        ? countLabel
        : ageLabel
          ? `Synced ${ageLabel}`
          : "We'll boost events featuring artists you follow.";

  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full bg-sc-orange shadow-glow-sc-sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg-primary">
          {username ? (
            <>
              Connected as{' '}
              <span className="text-sc-orange">@{username}</span>
            </>
          ) : (
            <span className="text-sc-orange">Connected</span>
          )}
        </div>
        <div className="text-2xs text-fg-muted tabular">{subline}</div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={disabled}
        aria-label="Refresh SoundCloud follows"
        title="Refresh"
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

function SuccessBar({
  count,
  matchedArtists,
}: {
  count: number;
  matchedArtists: number;
}) {
  // Copy is intentionally specific: the count alone is just a number,
  // but pairing it with "M of whom play in NYC" turns the sync into
  // tangible value. Fall back to the bare count when no matches —
  // honest framing beats a misleading "0 of whom play in NYC" line.
  const headline =
    count === 0
      ? "You don't follow anyone on SoundCloud yet"
      : count === 1
        ? 'Imported 1 artist you follow'
        : `Imported ${count.toLocaleString()} artists you follow`;
  const subline =
    count > 0 && matchedArtists > 0
      ? `${matchedArtists.toLocaleString()} ${
          matchedArtists === 1 ? 'plays' : 'play'
        } in NYC.`
      : null;

  return (
    <div className="mt-3 curi-glass rounded-2xl p-4 shadow-card animate-enter-up">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full bg-sc-orange shadow-glow-sc-sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs font-medium text-fg-primary tabular">
            {headline}
          </p>
          {subline && (
            <p className="text-2xs text-fg-muted tabular">{subline}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ label }: { label: string }) {
  return (
    <div className="mt-3 curi-glass rounded-2xl p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-sc-orange"
          strokeWidth={2.5}
          aria-hidden
        />
        <span className="text-2xs font-medium text-fg-muted">{label}</span>
      </div>
      <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-border">
        <div
          aria-hidden
          className="h-full w-full animate-pulse bg-sc-orange/50"
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

/**
 * Map the `?sc_error=<code>` query param the callback redirects with
 * onto user-visible copy. Codes are stable contracts between the
 * callback route and this card.
 */
function callbackErrorMessage(code: string): string {
  switch (code) {
    case 'state':
      return "That sign-in didn't complete. Try connecting again.";
    case 'exchange':
      return "Couldn't connect to SoundCloud right now. Try again in a moment.";
    case 'config':
      return 'SoundCloud connect is temporarily unavailable. Try again later.';
    default:
      return 'Something went wrong connecting to SoundCloud. Try again.';
  }
}

/**
 * Map the discriminated `error` field of a SyncResult to user-facing
 * copy. Same contract pattern as `callbackErrorMessage` — keeps the
 * server action's error vocabulary in one translation table.
 */
function syncErrorMessage(
  code: 'unauth' | 'not_connected' | 'reauth_required' | 'fetch_failed' | 'db_failed',
): string {
  switch (code) {
    case 'unauth':
      return 'Sign in required. Refresh the page and sign in again.';
    case 'not_connected':
      return 'Connect your SoundCloud account first to import follows.';
    case 'reauth_required':
      return 'Your SoundCloud session expired. Reconnect to keep importing follows.';
    case 'fetch_failed':
      return "Couldn't reach SoundCloud right now. Try refreshing in a moment.";
    case 'db_failed':
      return 'Could not save your follows. Try again in a moment.';
  }
}

/**
 * Render an ISO timestamp as a coarse relative age. Same logic as the
 * legacy paste card's helper — kept inline rather than imported so
 * this card stays self-contained when the legacy file eventually
 * gets deleted.
 */
function formatRelativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const ms = Date.now() - then;
  if (ms < 0) return 'just now';

  const min = ms / 60000;
  if (min < 1) return 'just now';
  if (min < 60)
    return `${Math.floor(min)} minute${Math.floor(min) === 1 ? '' : 's'} ago`;

  const hr = min / 60;
  if (hr < 24)
    return `${Math.floor(hr)} hour${Math.floor(hr) === 1 ? '' : 's'} ago`;

  const day = hr / 24;
  if (day < 30)
    return `${Math.floor(day)} day${Math.floor(day) === 1 ? '' : 's'} ago`;

  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

