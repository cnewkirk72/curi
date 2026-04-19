'use client';

// Preferences form on /profile.
//
// Design language mirrors the FilterSheet option grid — same
// accent-chip pill for "on", same border-bg-elevated pill for
// "off" — so users read "preferred genres / vibes" and the feed
// filter as the same vocabulary applied to different intents
// (one scoped to the request, one remembered across sessions).
//
// State model:
//   - `saved`: the last-persisted prefs, passed in from the
//     server. Used to compute `dirty` and to re-seed on reset.
//   - `draft`: the local editing state. Save sends this up.
//   - useTransition drives the disabled/"Saving…" state on the
//     submit pill and rebroadcasts server revalidation.
//
// We do NOT auto-save on every toggle — the server action does a
// real upsert and revalidates `/` and `/profile`, which is too
// expensive to fire on every chip click. An explicit Save is
// also clearer about what's happening.

import { useMemo, useState, useTransition } from 'react';
import { Check, Mail } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GENRE_OPTIONS, VIBE_OPTIONS, type FilterOption } from '@/lib/filters';
import { upsertUserPrefs } from '@/lib/preferences-actions';
import type { UserPrefs } from '@/lib/preferences';

type Props = {
  /** Server-provided initial prefs — DEFAULT_PREFS for first-visit
   *  viewers, the persisted row otherwise. */
  initial: UserPrefs;
};

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

export function PreferencesForm({ initial }: Props) {
  const [saved, setSaved] = useState<UserPrefs>(initial);
  const [draft, setDraft] = useState<UserPrefs>(initial);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<SaveState>({ kind: 'idle' });

  const dirty = useMemo(() => !prefsEqual(draft, saved), [draft, saved]);

  function toggleGenre(slug: string) {
    setDraft((d) => ({
      ...d,
      preferred_genres: toggleList(d.preferred_genres, slug),
    }));
    setStatus({ kind: 'idle' });
  }

  function toggleVibe(slug: string) {
    setDraft((d) => ({
      ...d,
      preferred_vibes: toggleList(d.preferred_vibes, slug),
    }));
    setStatus({ kind: 'idle' });
  }

  function toggleDigest() {
    setDraft((d) => ({ ...d, digest_email: !d.digest_email }));
    setStatus({ kind: 'idle' });
  }

  function reset() {
    setDraft(saved);
    setStatus({ kind: 'idle' });
  }

  function save() {
    // Snapshot `draft` now so if the user toggles during the
    // in-flight save we still commit-what-you-saw on success.
    const payload = draft;
    startTransition(async () => {
      const result = await upsertUserPrefs(payload);
      if (result.ok) {
        setSaved(payload);
        setStatus({ kind: 'saved' });
      } else if (result.reason === 'unauth') {
        setStatus({
          kind: 'error',
          message: 'Sign in to save preferences.',
        });
      } else {
        setStatus({
          kind: 'error',
          message: 'Could not save preferences. Try again in a moment.',
        });
      }
    });
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Your taste
        </h3>
        <span className="text-2xs text-fg-dim">
          Biases the feed toward what you&apos;re into
        </span>
      </div>

      <div className="curi-glass rounded-2xl p-5 shadow-card">
        {/* Genres */}
        <OptionBlock
          label="Preferred genres"
          hint="Tap to toggle"
          options={GENRE_OPTIONS}
          selected={draft.preferred_genres}
          onToggle={toggleGenre}
        />

        <div className="my-5 h-px bg-border/60" aria-hidden />

        {/* Vibes */}
        <OptionBlock
          label="Preferred vibes"
          hint="Tap to toggle"
          options={VIBE_OPTIONS}
          selected={draft.preferred_vibes}
          onToggle={toggleVibe}
        />

        <div className="my-5 h-px bg-border/60" aria-hidden />

        {/* Digest email */}
        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
              Weekly digest
            </span>
          </div>
          <button
            type="button"
            onClick={toggleDigest}
            aria-pressed={draft.digest_email}
            className={cn(
              'flex w-full items-center gap-4 rounded-2xl border p-4 text-left',
              'transition duration-micro ease-expo active:scale-[0.99]',
              draft.digest_email
                ? 'border-accent/40 bg-accent-chip/60'
                : 'border-border bg-bg-elevated hover:bg-bg-elevated-hover',
            )}
          >
            <div
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-pill',
                draft.digest_email
                  ? 'bg-accent text-bg-deep'
                  : 'border border-border bg-bg-deep text-fg-muted',
              )}
            >
              <Mail className="h-4 w-4" strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg-primary">
                Weekly email digest
              </div>
              <div className="text-2xs text-fg-muted">
                {draft.digest_email
                  ? "On — we'll send a Friday roundup of events that match your taste."
                  : 'Off — no emails. Flip this on to get a Friday roundup.'}
              </div>
            </div>
            <Toggle on={draft.digest_email} />
          </button>
        </div>

        {/* Footer actions */}
        <div className="mt-5 flex items-center gap-3 border-t border-border pt-4">
          <div className="min-h-[18px] text-2xs text-fg-muted" aria-live="polite">
            {status.kind === 'saved' && !dirty ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                Saved
              </span>
            ) : status.kind === 'error' ? (
              <span className="text-fg-primary">{status.message}</span>
            ) : dirty ? (
              <span>Unsaved changes</span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={reset}
            disabled={!dirty || isPending}
            className={cn(
              'text-xs font-medium text-fg-muted transition hover:text-fg-primary',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || isPending}
            className={cn(
              'inline-flex items-center justify-center rounded-pill bg-accent px-5 py-2',
              'font-display text-xs font-semibold text-bg-deep shadow-glow',
              'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
              'disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none',
            )}
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function toggleList(list: string[], slug: string): string[] {
  return list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
}

function prefsEqual(a: UserPrefs, b: UserPrefs): boolean {
  if (a.digest_email !== b.digest_email) return false;
  if (!arrayEq(a.preferred_genres, b.preferred_genres)) return false;
  if (!arrayEq(a.preferred_vibes, b.preferred_vibes)) return false;
  return true;
}

function arrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // Order-insensitive — user clicks don't preserve stable order
  // and we don't want a pure reorder to register as dirty.
  const set = new Set(a);
  for (const s of b) if (!set.has(s)) return false;
  return true;
}

// ── subcomponents ────────────────────────────────────────────────────

function OptionBlock({
  label,
  hint,
  options,
  selected,
  onToggle,
}: {
  label: string;
  hint?: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          {label}
        </span>
        {hint && <span className="text-2xs text-fg-dim">{hint}</span>}
      </div>
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
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill border transition',
        on
          ? 'border-accent/40 bg-accent/80'
          : 'border-border bg-bg-deep',
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-fg-primary shadow-card transition',
          on ? 'left-5 bg-bg-deep' : 'left-1',
        )}
      />
    </span>
  );
}
