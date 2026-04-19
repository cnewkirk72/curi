'use client';

// Bottom sheet for filter editing.
//
// Filter state is ultimately owned by the URL — that's what makes
// filter URLs shareable and makes the back button work. The sheet
// holds its own *draft* state while open so a user can tick/untick
// options without triggering a server round-trip on every change; on
// Apply we serialize the draft and `router.push` the new URL, which
// re-runs `getUpcomingEvents` on the server.
//
// We use `useTransition` so the Apply click feels responsive — the
// sheet closes immediately and the card list pulses via the returned
// `isPending` flag while the server refetches.

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DATE_OPTIONS,
  GENRE_OPTIONS,
  VIBE_OPTIONS,
  serializeFilters,
  type DateFilter,
  type FilterState,
  type FilterOption,
} from '@/lib/filters';

type Props = {
  open: boolean;
  onClose: () => void;
  initialFilters: FilterState;
};

export function FilterSheet({ open, onClose, initialFilters }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState<FilterState>(initialFilters);

  // Re-seed the draft whenever the sheet opens — the URL might have
  // changed since the last open (e.g. user hit "Clear" on the bar),
  // and we want the sheet to reflect the current URL, not the draft
  // the user abandoned last time.
  useEffect(() => {
    if (open) setDraft(initialFilters);
  }, [open, initialFilters]);

  // Scroll lock while the sheet is open — keeps the feed beneath
  // from scrolling when a user drags inside the sheet.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC to close (keyboard a11y for anyone using a Bluetooth keyboard
  // with the PWA, and for the web-desktop fallback).
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [open, onClose]);

  function toggle(list: string[], slug: string): string[] {
    return list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
  }

  function apply() {
    const qs = serializeFilters(draft);
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
      onClose();
    });
  }

  function clearAll() {
    setDraft({ when: 'all', genres: [], vibes: [] });
  }

  return (
    <>
      {/* Backdrop ────────────────────────────────────────────────── */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-bg-deep/70 backdrop-blur-sm',
          'transition-opacity duration-sheet ease-expo',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      {/* Sheet ───────────────────────────────────────────────────── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filter events"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[430px]',
          'transition-transform duration-sheet ease-expo',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="curi-glass rounded-t-2xl border-t border-border shadow-card">
          {/* Handle — visual affordance that this panel is drag-up / tap-out.
              Not actually draggable; adding a real drag gesture is overkill for
              v1. Keyboard users get ESC, tap users get the backdrop + X. */}
          <div className="flex justify-center pt-2">
            <div className="h-1 w-10 rounded-pill bg-border-strong" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pb-2 pt-3">
            <h2 className="font-display text-base font-semibold tracking-display text-fg-primary">
              Filter events
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close filters"
              className="inline-flex h-8 w-8 items-center justify-center rounded-pill text-fg-muted transition hover:bg-bg-elevated-hover hover:text-fg-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Scrollable body — capped at ~70vh so the Apply/Clear row
              never scrolls out of reach on short phones. */}
          <div className="max-h-[70dvh] space-y-6 overflow-y-auto px-5 pb-4 pt-2">
            {/* When */}
            <Section label="When">
              <div className="flex flex-wrap gap-2">
                {DATE_OPTIONS.map((opt) => (
                  <SingleSelectPill
                    key={opt.slug}
                    active={draft.when === opt.slug}
                    onClick={() =>
                      setDraft((d) => ({ ...d, when: opt.slug as DateFilter }))
                    }
                  >
                    {opt.label}
                  </SingleSelectPill>
                ))}
              </div>
            </Section>

            {/* Genre */}
            <Section label="Genre" hint="Multi-select">
              <OptionGrid
                options={GENRE_OPTIONS}
                selected={draft.genres}
                onToggle={(slug) =>
                  setDraft((d) => ({ ...d, genres: toggle(d.genres, slug) }))
                }
              />
            </Section>

            {/* Vibe */}
            <Section label="Vibe" hint="Multi-select">
              <OptionGrid
                options={VIBE_OPTIONS}
                selected={draft.vibes}
                onToggle={(slug) =>
                  setDraft((d) => ({
                    ...d,
                    vibes: toggle(d.vibes, slug),
                  }))
                }
              />
            </Section>
          </div>

          {/* Footer — safe-area aware so the Apply button doesn't get
              eaten by the iPhone home indicator. */}
          <div className="flex items-center gap-3 border-t border-border px-5 pb-[max(env(safe-area-inset-bottom),16px)] pt-4">
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium text-fg-muted transition hover:text-fg-primary"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={isPending}
              className={cn(
                'ml-auto inline-flex items-center justify-center rounded-pill bg-accent px-6 py-2.5',
                'font-display text-xs font-semibold text-bg-deep shadow-glow',
                'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
                'disabled:opacity-60',
              )}
            >
              {isPending ? 'Applying…' : 'Apply filters'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          {label}
        </span>
        {hint && (
          <span className="text-2xs text-fg-dim">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function SingleSelectPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center rounded-pill border px-4 py-2 text-xs font-medium',
        'transition duration-micro ease-expo active:scale-[0.96]',
        active
          ? 'border-accent/40 bg-accent-chip text-accent shadow-glow-sm'
          : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}

function OptionGrid({
  options,
  selected,
  onToggle,
}: {
  options: FilterOption[];
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = selected.includes(opt.slug);
        return (
          <button
            key={opt.slug}
            type="button"
            onClick={() => onToggle(opt.slug)}
            aria-pressed={active}
            className={cn(
              'inline-flex items-center rounded-pill border px-3.5 py-1.5 text-xs font-medium',
              'transition duration-micro ease-expo active:scale-[0.96]',
              active
                ? 'border-accent/40 bg-accent-chip text-accent'
                : 'border-border bg-bg-elevated text-fg-muted hover:text-fg-primary',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
