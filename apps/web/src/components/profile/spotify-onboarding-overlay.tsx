'use client';

// Phase 5.7 — Spotify onboarding overlay card.
//
// 4-page swipeable glass overlay that walks the user through getting
// their Spotify profile URL out of the Spotify mobile app, then
// accepts the URL paste to kick off the bot-driven sync.
//
// Layout shape (all pages share the same chrome):
//   ┌─────────────────────────────────────┐
//   │ [×]                                 │   ← top-left close
//   │                                      │
//   │    ┌──────────────────────────┐      │
//   │    │  step illustration       │      │   ← page-specific visual
//   │    └──────────────────────────┘      │
//   │                                      │
//   │    Step N of 4 · uppercase tag       │
//   │    Heading body                       │
//   │    Caption body, smaller              │
//   │                                      │
//   │    ● ○ ○ ○                           │   ← page dots (active = green)
//   │                                      │
//   │                          [Skip →]    │   ← bottom-right; becomes
//   └─────────────────────────────────────┘     [Submit] on page 4
//
// Backdrop: `fixed inset-0 z-50` with `bg-bg-deep/70 backdrop-blur-glass`
// so the underlying /profile dims cleanly. Dismissed by tapping × or
// Esc. Focus trap inside the card so keyboard nav doesn't escape.
//
// Brand alignment:
//   - .curi-glass card chrome matching identity + preferences cards
//   - animate-enter-up on mount (280ms expo-out)
//   - Cyan accent on close button + page indicator inactive state
//   - Spotify-green on the page-dot active state + Submit pill +
//     final input border focus-within
//   - Amber error palette for the inline error toast
//
// State machine:
//   browsing → submitting → success | error
//   browsing → (×|Esc) → closed
//   error → browsing (back to last page)

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { ArrowRight, Check, ListMusic, Share, User, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  syncSpotifyFollows,
  type SyncResult,
} from '@/app/actions/sync-spotify-follows';

type ErrorOf<T> = T extends { ok: false; error: infer E } ? E : never;

type Status =
  | { kind: 'browsing'; page: 0 | 1 | 2 | 3 }
  | { kind: 'submitting'; page: 3 }
  | { kind: 'success'; count: number }
  | { kind: 'error'; page: 0 | 1 | 2 | 3; code: NonNullable<ErrorOf<SyncResult>> };

type Props = {
  /** Mounted in the parent's tree but conditionally rendered — the
   *  parent (SpotifyConnectCard) controls visibility. When `open`
   *  flips false, the parent unmounts the overlay. */
  open: boolean;
  /** Tapping ×, Esc, or backdrop fires this to close from the parent. */
  onClose: () => void;
  /** After a successful sync, the parent triggers its own hard
   *  refresh (window.location.href = '/') so the home + saved feeds
   *  re-render with the new follow set. The overlay shows the
   *  success card briefly, then calls this to dismiss + refresh. */
  onSuccess: (count: number) => void;
};

const TOTAL_PAGES = 4;

export function SpotifyOnboardingOverlay({
  open,
  onClose,
  onSuccess,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'browsing', page: 0 });
  const [inputValue, setInputValue] = useState('');
  const [isPending, startTransition] = useTransition();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ─── Lifecycle ────────────────────────────────────────────────────────

  // Reset state when the overlay re-opens. Parent can mount/unmount
  // to fully dispose, but in practice it just toggles `open`.
  useEffect(() => {
    if (open) {
      setStatus({ kind: 'browsing', page: 0 });
      setInputValue('');
    }
  }, [open]);

  // Esc to close — only when browsing/error, not while a sync is
  // in-flight (avoid orphaning a server action).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status.kind !== 'submitting') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, status.kind, onClose]);

  // Focus the card on mount so keyboard nav (arrows, tab) works
  // immediately without the user having to click into it.
  useEffect(() => {
    if (open) cardRef.current?.focus();
  }, [open]);

  // Auto-focus the input on page 4 entry.
  useEffect(() => {
    if (status.kind === 'browsing' && status.page === 3) {
      // Slight delay so the swipe transition finishes before focus
      // moves — otherwise iOS Safari sometimes scrolls the page.
      const id = window.setTimeout(() => inputRef.current?.focus(), 80);
      return () => window.clearTimeout(id);
    }
    return;
  }, [status]);

  // ─── Navigation ────────────────────────────────────────────────────────

  const currentPage =
    status.kind === 'browsing' || status.kind === 'error'
      ? status.page
      : (3 as const);

  const goToPage = useCallback((next: 0 | 1 | 2 | 3) => {
    setStatus({ kind: 'browsing', page: next });
  }, []);

  const goNext = useCallback(() => {
    if (currentPage < (TOTAL_PAGES - 1)) {
      goToPage((currentPage + 1) as 0 | 1 | 2 | 3);
    }
  }, [currentPage, goToPage]);

  const goPrev = useCallback(() => {
    if (currentPage > 0) {
      goToPage((currentPage - 1) as 0 | 1 | 2 | 3);
    }
  }, [currentPage, goToPage]);

  // Keyboard nav: ←/→ swipe pages.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (status.kind !== 'browsing') return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, status, goNext, goPrev]);

  // Touch swipe — minimal pointermove tracking. We don't pull in a
  // gesture lib for one component; pointermove + an x-delta threshold
  // matches the Apple HIG ~64px swipe distance to commit.
  const dragStartX = useRef<number | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (status.kind !== 'browsing') return;
    dragStartX.current = e.clientX;
  }, [status.kind]);
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragStartX.current === null) return;
      const dx = e.clientX - dragStartX.current;
      dragStartX.current = null;
      if (Math.abs(dx) < 64) return;
      if (dx < 0) goNext();
      else goPrev();
    },
    [goNext, goPrev],
  );

  // ─── Submit ────────────────────────────────────────────────────────────

  const onSubmit = useCallback(() => {
    const value = inputValue.trim();
    if (!value) return;
    setStatus({ kind: 'submitting', page: 3 });
    startTransition(async () => {
      const result = await syncSpotifyFollows(value);
      if (result.ok) {
        setStatus({ kind: 'success', count: result.count });
        // Brief success card, then parent dismisses + hard-refreshes.
        window.setTimeout(() => onSuccess(result.count), 1500);
      } else {
        setStatus({ kind: 'error', page: 3, code: result.error });
      }
    });
  }, [inputValue, startTransition, onSuccess]);

  const onRetry = useCallback(() => {
    if (status.kind === 'error') {
      setStatus({ kind: 'browsing', page: status.page });
    }
  }, [status]);

  // ─── Render ────────────────────────────────────────────────────────────

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="spotify-onboarding-heading"
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center px-4',
        'bg-bg-deep/70 backdrop-blur-glass',
        'animate-fade-in',
      )}
      onClick={(e) => {
        // Click outside the card → dismiss. Skip during submit so a
        // mis-tap doesn't cancel an in-flight sync.
        if (
          e.target === e.currentTarget &&
          status.kind !== 'submitting' &&
          status.kind !== 'success'
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        className={cn(
          'curi-glass relative w-full max-w-md rounded-2xl shadow-card',
          'animate-enter-up outline-none',
          'overflow-hidden',
        )}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        {/* Close button — top-LEFT per spec */}
        <button
          type="button"
          onClick={onClose}
          disabled={status.kind === 'submitting'}
          aria-label="Close"
          className={cn(
            'absolute left-3 top-3 z-10',
            'flex h-8 w-8 items-center justify-center rounded-full',
            'border border-border bg-bg-elevated text-fg-muted',
            'transition duration-micro ease-expo',
            'hover:bg-bg-elevated-hover hover:text-fg-primary active:scale-[0.95]',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <X className="h-4 w-4" strokeWidth={2.25} />
        </button>

        {/* Page content. Conditional render of success/error covers
            the terminal states; otherwise show the current page. */}
        {status.kind === 'success' ? (
          <SuccessCard count={status.count} />
        ) : status.kind === 'error' ? (
          <ErrorCard code={status.code} onRetry={onRetry} />
        ) : (
          <PageContent
            page={currentPage}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onSubmit={onSubmit}
            inputRef={inputRef}
            disabled={status.kind === 'submitting' || isPending}
          />
        )}

        {/* Footer: page dots + Skip/Submit. Hidden in success +
            in-flight states. */}
        {status.kind !== 'success' && status.kind !== 'submitting' && (
          <div className="flex items-center justify-between gap-3 px-5 pb-5">
            <PageDots
              total={TOTAL_PAGES}
              current={currentPage}
              onSelect={(i) => goToPage(i as 0 | 1 | 2 | 3)}
            />
            <FooterAction
              page={currentPage}
              inputValue={inputValue}
              onSkip={() => goToPage(3)}
              onSubmit={onSubmit}
              disabled={status.kind === 'error'}
            />
          </div>
        )}

        {/* In-flight state — preserve the card chrome but lock
            controls and show a subtle "Importing your follows…"
            line. */}
        {status.kind === 'submitting' && <SubmittingFooter />}
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function PageContent({
  page,
  inputValue,
  onInputChange,
  onSubmit,
  inputRef,
  disabled,
}: {
  page: 0 | 1 | 2 | 3;
  inputValue: string;
  onInputChange: (next: string) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  disabled: boolean;
}) {
  // Each page has the same outer chrome (illustration + step copy).
  // Pages 0–2 are instructional; page 3 is the URL paste form.
  return (
    <div className="px-5 pb-3 pt-12">
      <div className="mb-4 flex items-center justify-center">
        <PageIllustration page={page} />
      </div>

      <div className="mb-4 text-center">
        <p className="font-display text-2xs uppercase tracking-widest text-spotify-green">
          Step {page + 1} of {TOTAL_PAGES}
        </p>
        <h3
          id="spotify-onboarding-heading"
          className="mt-1.5 font-display text-lg font-semibold leading-tight tracking-display text-fg-primary"
        >
          {PAGES[page].heading}
        </h3>
        <p className="mt-2 text-2xs leading-relaxed text-fg-muted">
          {PAGES[page].body}
        </p>
      </div>

      {page === 3 && (
        <div className="mt-4">
          <label
            htmlFor="spotify-url-input"
            className={cn(
              'flex items-center gap-2 rounded-pill border bg-bg-deep px-3 py-2 transition',
              'border-border',
              'focus-within:border-spotify-green/60',
            )}
          >
            <input
              id="spotify-url-input"
              ref={inputRef}
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://open.spotify.com/user/..."
              value={inputValue}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && inputValue.trim().length > 0) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
              disabled={disabled}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-dim',
                'outline-none focus:outline-none',
                'disabled:opacity-60',
              )}
            />
            {inputValue.trim().length > 0 && (
              <Check
                className="h-4 w-4 shrink-0 text-spotify-green"
                strokeWidth={2.5}
                aria-hidden
              />
            )}
          </label>
        </div>
      )}
    </div>
  );
}

const PAGES = [
  {
    heading: 'Open Spotify and tap your profile picture',
    body: 'Top-left corner of the home tab.',
  },
  {
    heading: 'Tap "View profile"',
    body: 'First option in the menu that opens.',
  },
  {
    heading: 'Tap the Share icon, then "Copy link to profile"',
    body: 'Spotify copies your profile URL to your clipboard.',
  },
  {
    heading: 'Paste your profile URL',
    body: "We'll find your followed artists from this. Make sure your Spotify profile is set to public.",
  },
] as const;

function PageIllustration({ page }: { page: 0 | 1 | 2 | 3 }) {
  const iconMap = [User, ListMusic, Share, Check] as const;
  const Icon = iconMap[page];
  return (
    <div
      className={cn(
        'relative flex h-32 w-32 items-center justify-center rounded-2xl',
        'curi-glass',
      )}
    >
      <Icon
        className="h-12 w-12 text-spotify-green"
        strokeWidth={1.75}
        aria-hidden
      />
    </div>
  );
}

function PageDots({
  total,
  current,
  onSelect,
}: {
  total: number;
  current: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onSelect(i)}
          aria-label={`Go to step ${i + 1}`}
          aria-current={i === current}
          className={cn(
            'h-1.5 rounded-full transition-all duration-micro ease-expo',
            i === current
              ? 'w-6 bg-spotify-green'
              : 'w-1.5 bg-fg-dim hover:bg-fg-muted',
          )}
        />
      ))}
    </div>
  );
}

function FooterAction({
  page,
  inputValue,
  onSkip,
  onSubmit,
  disabled,
}: {
  page: number;
  inputValue: string;
  onSkip: () => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  if (page < 3) {
    return (
      <button
        type="button"
        onClick={onSkip}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill px-4 py-2',
          'border border-border bg-bg-elevated text-fg-muted',
          'font-display text-2xs font-medium',
          'transition duration-micro ease-expo',
          'hover:bg-bg-elevated-hover hover:text-fg-primary active:scale-[0.97]',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        Skip
        <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
      </button>
    );
  }

  const canSubmit = inputValue.trim().length > 0;
  return (
    <button
      type="button"
      onClick={onSubmit}
      disabled={disabled || !canSubmit}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-5 py-2',
        'bg-spotify-green text-bg-deep shadow-glow-spotify-sm',
        'font-display text-2xs font-semibold',
        'transition duration-micro ease-expo',
        'hover:opacity-90 active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      Submit
      <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
    </button>
  );
}

function SubmittingFooter() {
  return (
    <div
      className="flex items-center justify-center gap-2 px-5 pb-5 pt-1"
      aria-live="polite"
    >
      <span className="font-display text-2xs uppercase tracking-widest text-fg-muted">
        Importing your follows…
      </span>
    </div>
  );
}

function SuccessCard({ count }: { count: number }) {
  const label =
    count === 0
      ? "You don't follow anyone on Spotify yet"
      : count === 1
        ? 'Imported 1 artist you follow on Spotify'
        : `Imported ${count.toLocaleString()} artists you follow on Spotify`;
  return (
    <div className="px-5 pb-8 pt-12 text-center">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-spotify-green/15 shadow-glow-spotify">
        <Check
          className="h-8 w-8 text-spotify-green"
          strokeWidth={2.5}
          aria-hidden
        />
      </div>
      <h3 className="font-display text-lg font-semibold tracking-display text-fg-primary">
        Connected!
      </h3>
      <p className="mt-2 text-2xs text-fg-muted tabular">{label}</p>
    </div>
  );
}

function ErrorCard({
  code,
  onRetry,
}: {
  code: NonNullable<ErrorOf<SyncResult>>;
  onRetry: () => void;
}) {
  return (
    <div className="px-5 pb-5 pt-12">
      <div className="rounded-2xl border border-amber/30 bg-amber-chip p-4">
        <p className="text-2xs font-medium text-amber">
          {errorMessage(code)}
        </p>
        {code !== 'unauth' && (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              'mt-3 inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5',
              'border-amber/40 bg-amber/10 text-amber',
              'font-display text-2xs font-medium',
              'transition hover:bg-amber/20 active:scale-[0.97]',
            )}
          >
            Try again
            <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}

function errorMessage(code: NonNullable<ErrorOf<SyncResult>>): string {
  switch (code) {
    case 'unauth':
      return 'Sign in required. Refresh the page and sign in again.';
    case 'invalid_url':
      return "That doesn't look like a Spotify profile URL — paste the full link from Spotify's share menu.";
    case 'private_profile':
      return "Couldn't find any followed artists for that profile. Make sure your Spotify profile is set to public.";
    case 'bot_auth_failed':
      return "We're having trouble with our Spotify lookup service. Try again in a few minutes.";
    case 'scrape_failed':
      return 'Something went wrong syncing your follows. Try again in a moment.';
  }
}
