'use client';

// Phase 5.6.1 — SoundCloud follow-graph connect card.
//
// Visual anatomy (top → bottom on /profile, between the activity stats
// section and the PreferencesForm):
//   Eyebrow      — "SoundCloud follows" caption
//   Card chrome  — .curi-glass rounded-2xl p-5 shadow-card (matches the
//                  identity card + preferences card visual rhythm)
//   Card body    — state-machine driven, see <CardBody /> below
//   Confirmation — absolute inset-0 overlay on top of the card chrome
//                  during the `confirming` state. Dismissed via Cancel
//                  or the Sync follows primary action.
//   Status bar   — sibling under the card during `syncing` / `done` /
//                  `error` states. Also .curi-glass for visual rhyme.
//
// State machine (see Status type):
//   idle / typing → confirming → syncing → done | error
//                       └ cancel ┘                 └ retry → syncing
//   When the user is already connected, idle starts as `connected` and
//   the Refresh button can drop straight to `syncing`.
//
// Brand alignment (matched to the existing UI per UI/UX skill review):
//   - Cyan accent (`bg-accent`, `shadow-glow-sm`) for primary action
//     pills; same token the SaveButton + Filter "On" chip use.
//   - Animated entry via `animate-enter-up` (280ms, expo-out — defined
//     in tailwind.config.ts; same animation the home page hero + the
//     onboarding step transitions use).
//   - Tabular numerals (`tabular`) for the count + sync-age numbers.
//   - Amber error palette (`border-amber/30 bg-amber-chip text-amber`)
//     matches the onboarding signin-step error toast.
//   - No "scrape" / "scraper" wording anywhere user-facing — copy uses
//     "sync your follows" / "import the artists you follow", per spec.
//
// Performance: server action is awaited inside useTransition so the
// button can show a non-blocking pending state. The action does the
// scrape + DB writes synchronously (Vercel Pro 60s timeout covers
// even power-user follow counts); the client just renders the bar
// while it's in flight.

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  syncSoundcloudFollows,
  type SyncResult,
} from '@/app/actions/sync-soundcloud-follows';

type Props = {
  /** Server-fetched current connection state. `username === null`
   *  means the user has never connected SC; renders the idle/typing
   *  flow. Non-null means render the connected-summary with a
   *  Refresh affordance (changing username also triggers a full
   *  re-sync — replace-not-merge per spec). */
  initialUsername: string | null;
  /** ISO timestamp of last successful sync, or null. Drives the
   *  "Last synced X ago" label. */
  initialLastSyncedAt: string | null;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'typing'; value: string }
  | { kind: 'confirming'; username: string }
  | { kind: 'syncing'; username: string }
  | { kind: 'done'; username: string; count: number }
  | { kind: 'error'; username: string; code: NonNullable<ErrorOf<SyncResult>> };

// Pull the discriminated `error` codes out of SyncResult for the
// state machine — keeps the union of error states tied to the
// server action's contract rather than hand-listed strings.
type ErrorOf<T> = T extends { ok: false; error: infer E } ? E : never;

// Same regex the server action uses (defense in depth — kept in sync).
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

export function SoundcloudConnectCard({
  initialUsername,
  initialLastSyncedAt,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // The "live" input value drives the typing state and the conditional
  // Save button. Initialized from the server-side initialUsername so
  // already-connected users see their handle prefilled.
  const [inputValue, setInputValue] = useState(initialUsername ?? '');

  const isConnected = !!initialUsername && status.kind === 'idle';
  const showSaveButton =
    !isConnected &&
    status.kind !== 'confirming' &&
    status.kind !== 'syncing' &&
    status.kind !== 'done' &&
    inputValue.trim().length > 0 &&
    USERNAME_RE.test(stripPrefix(inputValue.trim()));

  // ─── Handlers ───────────────────────────────────────────────────────────

  const onInputChange = useCallback((next: string) => {
    setInputValue(next);
    // Any keystroke after a terminal state (done/error) clears the
    // status bar so the user gets a clean retry surface. Using the
    // functional setter to avoid stale-state edge cases when typing
    // mid-transition.
    setStatus((s) => {
      if (s.kind === 'idle' || s.kind === 'typing') {
        return next.trim().length > 0
          ? { kind: 'typing', value: next.trim() }
          : { kind: 'idle' };
      }
      // From done/error/etc, return to typing.
      return next.trim().length > 0
        ? { kind: 'typing', value: next.trim() }
        : { kind: 'idle' };
    });
  }, []);

  const onSaveClick = useCallback(() => {
    const candidate = stripPrefix(inputValue.trim());
    if (!USERNAME_RE.test(candidate)) return;
    setStatus({ kind: 'confirming', username: candidate });
  }, [inputValue]);

  const onConfirmCancel = useCallback(() => {
    setStatus({ kind: 'typing', value: inputValue.trim() });
    // Return focus to the input so keyboard users continue smoothly.
    queueMicrotask(() => inputRef.current?.focus());
  }, [inputValue]);

  const runSync = useCallback(
    (username: string) => {
      setStatus({ kind: 'syncing', username });
      startTransition(async () => {
        const result = await syncSoundcloudFollows(username);
        if (result.ok) {
          setStatus({ kind: 'done', username, count: result.count });
        } else {
          setStatus({ kind: 'error', username, code: result.error });
        }
      });
    },
    [startTransition],
  );

  const onConfirmSync = useCallback(() => {
    if (status.kind === 'confirming') runSync(status.username);
  }, [status, runSync]);

  const onRetry = useCallback(() => {
    if (status.kind === 'error') runSync(status.username);
  }, [status, runSync]);

  const onRefresh = useCallback(() => {
    if (initialUsername) runSync(initialUsername);
  }, [initialUsername, runSync]);

  const onDoneOk = useCallback(() => {
    // Hard refresh so all RSCs re-render with the new follow set in
    // the home + saved feed sort. Same pattern the onboarding "ready"
    // step uses on completion.
    window.location.href = '/';
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          SoundCloud follows
        </h3>
        <span className="text-2xs text-fg-dim">
          Boost events with artists you follow
        </span>
      </div>

      {/* Card + confirmation overlay share a relative wrapper so the
          overlay can absolute-inset-0 onto the card without breaking
          the section header layout above. */}
      <div className="relative">
        <div className="curi-glass rounded-2xl p-5 shadow-card">
          {isConnected ? (
            <ConnectedSummary
              username={initialUsername!}
              lastSyncedAt={initialLastSyncedAt}
              onRefresh={onRefresh}
              disabled={isPending}
            />
          ) : (
            <DisconnectedInput
              inputRef={inputRef}
              value={inputValue}
              onChange={onInputChange}
              onSave={onSaveClick}
              showSaveButton={showSaveButton}
              disabled={isPending || status.kind === 'syncing' || status.kind === 'done'}
            />
          )}
        </div>

        {status.kind === 'confirming' && (
          <ConfirmationOverlay
            username={status.username}
            onCancel={onConfirmCancel}
            onConfirm={onConfirmSync}
          />
        )}
      </div>

      {/* Status bar — appears below the card during the active sync
          flow and its terminal states. .curi-glass ties it back to
          the card visually; mt-3 mirrors the form-action spacing the
          PreferencesForm uses. aria-live='polite' so screen readers
          announce state transitions without stealing focus. */}
      {(status.kind === 'syncing' ||
        status.kind === 'done' ||
        status.kind === 'error') && (
        <div className="mt-3 animate-enter-up" aria-live="polite">
          {status.kind === 'syncing' && <SyncingBar />}
          {status.kind === 'done' && (
            <DoneBar count={status.count} onOk={onDoneOk} />
          )}
          {status.kind === 'error' && (
            <ErrorBar
              username={status.username}
              code={status.code}
              onRetry={onRetry}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────────

function DisconnectedInput({
  inputRef,
  value,
  onChange,
  onSave,
  showSaveButton,
  disabled,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  showSaveButton: boolean;
  disabled: boolean;
}) {
  return (
    <>
      <p className="mb-3 text-sm text-fg-muted">
        Sync the artists you follow on SoundCloud so events featuring
        them rise to the top of your feed.
      </p>

      <label
        htmlFor="sc-username"
        className="flex items-center gap-2 rounded-pill border border-border bg-bg-deep px-3 py-2 transition focus-within:border-accent/50"
      >
        <span className="select-none whitespace-nowrap text-sm text-fg-dim">
          soundcloud.com/
        </span>
        <input
          id="sc-username"
          ref={inputRef}
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="your-username"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && showSaveButton) {
              e.preventDefault();
              onSave();
            }
          }}
          disabled={disabled}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-dim',
            'outline-none focus:outline-none',
            'disabled:opacity-60',
          )}
        />
        {showSaveButton && (
          <button
            type="button"
            onClick={onSave}
            disabled={disabled}
            className={cn(
              'shrink-0 rounded-pill bg-accent px-4 py-1.5',
              'font-display text-2xs font-semibold text-bg-deep shadow-glow-sm',
              'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
              'disabled:pointer-events-none disabled:opacity-50',
              // The slide-in animation. enter-up from tailwind.config.ts —
              // 280ms cubic-bezier(0.16, 1, 0.3, 1). The button mounts
              // when showSaveButton flips true (input value becomes
              // valid), so the animation runs once per save cycle.
              'animate-enter-up',
            )}
          >
            Save
          </button>
        )}
      </label>
    </>
  );
}

function ConnectedSummary({
  username,
  lastSyncedAt,
  onRefresh,
  disabled,
}: {
  username: string;
  lastSyncedAt: string | null;
  onRefresh: () => void;
  disabled: boolean;
}) {
  const ageLabel = useMemo(
    () => (lastSyncedAt ? formatRelativeAge(lastSyncedAt) : null),
    [lastSyncedAt],
  );

  return (
    <div className="flex items-center gap-3">
      {/* Phase 5.6.6 — amber dot matches SoundCloud's brand orange,
          giving "this is your SC connection" a distinct color
          vocabulary from cyan (which is reserved for primary actions
          + transient success states). Same color used on the
          EventCard avatar follow-dot and the LineupList avatar
          follow-dot, so the SC-follow signal reads consistently
          across the app. */}
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full bg-amber shadow-glow-amber-sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg-primary">
          Connected as{' '}
          <span className="text-amber">@{username}</span>
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
    </div>
  );
}

function ConfirmationOverlay({
  username,
  onCancel,
  onConfirm,
}: {
  username: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm SoundCloud sync"
      className={cn(
        'absolute inset-0 z-10 flex items-center justify-center',
        // Slight backdrop blur scrim over the card so the underlying
        // input UI dims cleanly. Per Apple HIG: blur to indicate
        // dismissibility, not as decoration.
        'rounded-2xl bg-bg-deep/70 backdrop-blur-glass',
        'animate-enter-up',
      )}
    >
      <div className="curi-glass mx-3 w-full max-w-sm rounded-xl p-4 shadow-card">
        <p className="font-display text-sm font-semibold text-fg-primary">
          Sync your SoundCloud follows
        </p>
        <p className="mt-1.5 text-2xs text-fg-muted">
          We&apos;ll import the artists you follow on SoundCloud
          (
          <span className="text-accent">@{username}</span>
          ) so events featuring them rise to the top of your feed.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'rounded-pill px-3 py-1.5',
              'text-2xs font-medium text-fg-muted',
              'transition hover:text-fg-primary active:scale-[0.97]',
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'inline-flex items-center justify-center rounded-pill bg-accent px-4 py-1.5',
              'font-display text-2xs font-semibold text-bg-deep shadow-glow-sm',
              'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
            )}
          >
            Sync follows
          </button>
        </div>
      </div>
    </div>
  );
}

function SyncingBar() {
  return (
    <div className="curi-glass rounded-2xl p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-accent"
          strokeWidth={2.5}
          aria-hidden
        />
        <span className="text-2xs font-medium text-fg-muted">
          Syncing your follows…
        </span>
      </div>
      {/* Indeterminate progress bar — Tailwind's animate-pulse cycles
          opacity, which reads as "in progress" without needing a
          custom keyframe in globals.css. Sized to ~3px tall so it
          feels like a status indicator, not a content element. */}
      <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-border">
        <div
          aria-hidden
          className="h-full w-full animate-pulse bg-accent/50"
        />
      </div>
    </div>
  );
}

function DoneBar({ count, onOk }: { count: number; onOk: () => void }) {
  // "Imported 247 artists you follow on SoundCloud" — copy locked
  // by spec. Pluralization handled inline.
  const label =
    count === 0
      ? "You don't follow anyone on SoundCloud yet"
      : count === 1
        ? 'Imported 1 artist you follow on SoundCloud'
        : `Imported ${count.toLocaleString()} artists you follow on SoundCloud`;
  return (
    <div className="curi-glass rounded-2xl p-4 shadow-card">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-glow-sm"
        />
        <p className="min-w-0 flex-1 text-2xs font-medium text-fg-primary tabular">
          {label}
        </p>
        <button
          type="button"
          onClick={onOk}
          autoFocus
          className={cn(
            'shrink-0 rounded-pill bg-accent px-4 py-1.5',
            'font-display text-2xs font-semibold text-bg-deep shadow-glow-sm',
            'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
          )}
        >
          OK
        </button>
      </div>
    </div>
  );
}

function ErrorBar({
  username,
  code,
  onRetry,
}: {
  username: string;
  code: NonNullable<ErrorOf<SyncResult>>;
  onRetry: () => void;
}) {
  const message = errorMessage(code, username);
  // Same amber palette + tone as the onboarding signin-step error
  // toast — borders/30 + bg-amber-chip + text-amber.
  return (
    <div className="rounded-2xl border border-amber/30 bg-amber-chip p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber"
        />
        <p className="min-w-0 flex-1 text-2xs font-medium text-amber">
          {message}
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
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Strip the `soundcloud.com/` prefix from user input. Matches the
 * server action's normalization — the input has a permanent prefix
 * label, but a paste from the user's own profile URL might include
 * it as part of the value. Friendly to accept either.
 */
function stripPrefix(s: string): string {
  return s
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?soundcloud\.com\//i, '')
    .replace(/^\/+/, '')
    .split('/')[0] ?? '';
}

/**
 * Render an ISO timestamp as a coarse relative age, sized for the
 * "Last synced X" label. Coarseness is intentional — minutes/hours
 * resolution would feel pedantic for a sync that happens every few
 * days. Returns the raw ISO date as a fallback for very old syncs.
 */
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

  // Very old — fall back to a static date label.
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function errorMessage(code: NonNullable<ErrorOf<SyncResult>>, username: string): string {
  switch (code) {
    case 'unauth':
      return 'Sign in required. Refresh the page and sign in again.';
    case 'invalid_username':
      return "That doesn't look like a SoundCloud username — letters, numbers, dashes, and underscores only.";
    case 'user_not_found':
      return `Couldn't find @${username} on SoundCloud. Double-check the spelling and that the profile is public.`;
    case 'scrape_failed':
      return "Something went wrong syncing your follows. Try again in a moment.";
  }
}
