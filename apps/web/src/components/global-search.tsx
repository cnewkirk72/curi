'use client';

// Phase 6.3 v2 — GlobalSearch is now a typeahead-with-dropdown surface.
//
// The original v1 just debounced 350ms and pushed `?q=` to the URL.
// v2 keeps the `?q=` behavior on Enter / blur (per Christian's
// preference — the URL param is shareable and stays compatible with
// existing event-title search) and layers a suggestion dropdown on
// top: trigram-fuzzy matches across events, artists, and venues from
// the `search_suggestions` RPC.
//
// State machine:
//   idle           — input empty, no popover
//   typing         — popover open, AbortController-cancellable RPC
//                    in flight, spinner visible
//   results        — popover renders 3 buckets + entity buttons
//   selected       — clicking a row pushes:
//                      ?event=<id> for events (legacy detail-modal hook)
//                      ?artist=<slug> for artist filter
//                      ?venue=<slug> for venue filter
//                    The `q` param is cleared on selection so the
//                    chip row doesn't render both a query AND a
//                    filter chip for the same intent.
//   committed      — Enter on a non-highlighted row falls through
//                    to the original `?q=` behavior.
//
// Why fire on the FIRST character (Christian's call): with ~700 events
// and ~1900 artists, the trigram operator is fast enough that 1-char
// queries are responsive, and showing immediate visual change makes
// the input feel alive. The RPC short-circuits to empty for queries
// that don't share a trigram, so a single character that matches
// nothing just renders the empty state — not a perf concern.
//
// Outside-click closes the popover. We bind on `pointerdown` rather
// than `click` so a tap on a different button doesn't fire BOTH the
// outside-click handler AND the button's onClick — pointerdown fires
// first and our handler short-circuits the popover before the click
// reaches the button.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  searchSuggestions,
  SearchAbortedError,
  type SearchSuggestions as Suggestions,
} from '@/lib/search';
import {
  SearchSuggestions as SuggestionsPopover,
  type SelectTarget,
  type KeyHandler,
} from '@/components/search-suggestions';

export function GlobalSearch({ className }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputId = useId();

  const [value, setValue] = useState(searchParams.get('q') ?? '');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Suggestions | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeDescendant, setActiveDescendant] = useState<string | null>(null);
  // Listbox id is generated here (rather than inside the popover) so
  // the input's aria-controls can target the same element it later
  // mounts. Without this, screen readers don't know which listbox the
  // input is announcing arrows over.
  const listboxId = `${inputId}-listbox`;

  // Coalesce in-flight fetches: each keystroke aborts the previous
  // request before starting a new one. Without this, slow networks
  // can deliver stale results AFTER the fresh ones have rendered,
  // causing the dropdown to flicker between two states.
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const keyHandlerRef = useRef<KeyHandler | null>(null);

  // useTransition for the URL push so the input doesn't feel sluggish
  // when the home feed re-renders against new params.
  const [, startTransition] = useTransition();

  // Sync the input value when the URL changes externally (e.g. the
  // filter-bar's "Clear all" button blowing away ?q=).
  useEffect(() => {
    setValue(searchParams.get('q') ?? '');
  }, [searchParams]);

  // Outside-click: close the popover when the user taps anywhere
  // outside the wrapper. Using pointerdown so it fires before any
  // sibling button's click handler.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Fire-on-first-character. We don't debounce here — the RPC is
  // cheap (~10ms server-side, indexed) and the abort plumbing keeps
  // the network from getting flooded. Empty queries clear the data
  // so the popover collapses to nothing without flashing a stale
  // result set.
  useEffect(() => {
    const needle = value.trim();
    if (needle.length === 0) {
      abortRef.current?.abort();
      setData(null);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;

    setLoading(true);
    let cancelled = false;
    searchSuggestions(needle, ctl.signal)
      .then((res) => {
        if (cancelled || ctl.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof SearchAbortedError) return;
        // RPC failures fall back to an empty result set so the user
        // can still commit a `?q=` search via Enter.
        console.error('[search] suggestions failed', err);
        setData({
          events: [],
          artists: [],
          venues: [],
          topArtist: null,
          topVenue: null,
        });
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  function commitQuery(rawQuery: string) {
    const params = new URLSearchParams(searchParams.toString());
    const trimmed = rawQuery.trim();
    if (trimmed) params.set('q', trimmed);
    else params.delete('q');
    setOpen(false);
    startTransition(() => {
      router.replace(params.toString() ? `/?${params.toString()}` : '/');
    });
  }

  // useCallback so the SearchSuggestions popover's row-list useMemo
  // sees a stable reference and doesn't recompute on every keystroke
  // that doesn't change the data.
  const handleSelect = useCallback(
    (target: SelectTarget) => {
      const params = new URLSearchParams(searchParams.toString());
      // Selecting a suggestion is a stronger intent than the freeform
      // text query — we replace `?q=` with the structured filter so
      // the URL stays clean and the active-chip row doesn't double-up
      // (e.g. "techno" query AND "Techno Festival" event chip).
      params.delete('q');

      if (target.kind === 'event') {
        // Routes directly to the event detail page — matches the existing
        // EventCard tap target.
        setValue('');
        setOpen(false);
        startTransition(() => {
          router.push(`/events/${target.eventId}`);
        });
        return;
      }

      if (target.kind === 'artist') {
        params.delete('venue');
        params.set('artist', target.slug);
      } else {
        params.delete('artist');
        params.set('venue', target.slug);
      }
      setValue('');
      setOpen(false);
      startTransition(() => {
        router.replace(`/?${params.toString()}`);
      });
    },
    [router, searchParams],
  );

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);
    if (v.trim().length > 0) setOpen(true);
    else setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (open) {
        setOpen(false);
        e.preventDefault();
      }
      return;
    }
    // Defer arrow / Enter to the popover's handler if it's open. The
    // popover returns true when it consumes the event; otherwise we
    // fall through to commit the raw query on Enter.
    if (open && keyHandlerRef.current) {
      const consumed = keyHandlerRef.current(e);
      if (consumed) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitQuery(value);
    }
  }

  function clear() {
    setValue('');
    setOpen(false);
    abortRef.current?.abort();
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    startTransition(() => {
      router.replace(params.toString() ? `/?${params.toString()}` : '/');
    });
    // Bring focus back so the user can keep typing.
    inputRef.current?.focus();
  }

  function onFocus() {
    // Re-open the popover on focus if there's already a query — useful
    // when the user clicks the input, glances elsewhere, then clicks
    // back to keep refining.
    if (value.trim().length > 0 && data) setOpen(true);
  }

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <div
        className={cn(
          'flex items-center gap-2 rounded-pill px-3 py-2',
          'border border-border bg-bg-elevated',
          'transition-colors duration-micro',
          open ? 'border-accent/60' : 'focus-within:border-accent/50',
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          value={value}
          onChange={onChange}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder="Search events, artists, venues…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // ARIA combobox pattern — the listbox lives in the popover
          // and is wired by id via aria-controls. aria-expanded mirrors
          // the popover's open state so screen readers announce it.
          // aria-activedescendant is updated by the popover via the
          // setActiveDescendant prop so VoiceOver / NVDA announce the
          // highlighted row as the user arrows through.
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open && activeDescendant ? activeDescendant : undefined}
          aria-autocomplete="list"
          className={cn(
            'min-w-0 flex-1 bg-transparent text-xs text-fg-primary outline-none',
            'placeholder:text-fg-dim',
            '[&::-webkit-search-cancel-button]:hidden',
          )}
        />
        {value && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="shrink-0 text-fg-muted transition-colors hover:text-fg-primary"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {open && value.trim().length > 0 && (
        <SuggestionsPopover
          rootRef={popoverRef}
          listboxId={listboxId}
          data={data}
          query={value}
          loading={loading}
          onSelect={handleSelect}
          onHighlightChange={setActiveDescendant}
          keyHandlerRef={keyHandlerRef}
        />
      )}
    </div>
  );
}
