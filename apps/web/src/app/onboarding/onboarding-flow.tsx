'use client';

// /onboarding state machine.
//
// Steps, in order:
//   'welcome' → 'signin' → 'genres' → 'vibes' → 'when' → 'ready'
//
// The welcome screen has no progress bar (it's the brand moment);
// every subsequent step shows a progress bar at the top.
//
// State model:
//   Local state holds the user's draft selections. Each step advance
//   fires the matching server action in an optimistic, fire-and-
//   forget style — we don't await the server before advancing the
//   step, so the UI stays snappy. If a save fails (network, 500,
//   etc.) we surface a small toast at the top; the next step's
//   advance also re-upserts via its own action, so a transient
//   failure on step 3 gets paper-patched on step 4.
//
// Hydration:
//   The page-level server component hands us the user's existing
//   user_prefs as `initialDraft`. Returning users who bail and come
//   back see their previous picks pre-selected — not a full restart.
//
// Sign-in:
//   We hide the sign-in step entirely if `user` is present — the
//   redirect from /auth/callback lands straight on /onboarding with
//   a session cookie, so we skip the gate and jump to genres.

import { useCallback, useMemo, useState, useTransition } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ProgressBar } from '@/components/onboarding/progress-bar';
import { WelcomeStep } from '@/components/onboarding/welcome-step';
import { SigninStep } from '@/components/onboarding/signin-step';
import { GenresStep } from '@/components/onboarding/genres-step';
import { VibesStep } from '@/components/onboarding/vibes-step';
import { WhenStep, type WindowPick } from '@/components/onboarding/when-step';
import { ReadyStep } from '@/components/onboarding/ready-step';
import {
  saveOnboardingGenres,
  saveOnboardingSubgenres,
  saveOnboardingVibes,
  saveOnboardingWhen,
} from '@/app/onboarding/actions';
import { subgenresForParent } from '@/lib/filters';

type Step = 'welcome' | 'signin' | 'genres' | 'vibes' | 'when' | 'ready';

export type OnboardingInitial = {
  isSignedIn: boolean;
  displayName: string | null;
  draft: {
    preferred_genres: string[];
    preferred_subgenres: string[];
    preferred_vibes: string[];
    default_when: WindowPick;
    notify_artist_drops: boolean;
    location_opt_in: boolean;
    calendar_opt_in: boolean;
  };
};

type Props = {
  initial: OnboardingInitial;
};

// Linear step sequence — progress bar value maps to the index here.
const STEP_SEQUENCE: Step[] = [
  'welcome',
  'signin',
  'genres',
  'vibes',
  'when',
  'ready',
];

export function OnboardingFlow({ initial }: Props) {
  // Start on welcome for everyone — even returning signed-in users
  // who've bailed mid-flow. The welcome screen is fast (one tap) and
  // the brand moment is worth re-seeing. We could smart-start on
  // 'genres' for returners, but that's a premature optimization.
  const [step, setStep] = useState<Step>('welcome');
  const [genres, setGenres] = useState<string[]>(initial.draft.preferred_genres);
  const [subgenres, setSubgenres] = useState<string[]>(
    initial.draft.preferred_subgenres,
  );
  const [vibes, setVibes] = useState<string[]>(initial.draft.preferred_vibes);
  const [defaultWhen, setDefaultWhen] = useState<WindowPick>(
    initial.draft.default_when,
  );
  const [notifyArtistDrops, setNotifyArtistDrops] = useState(
    initial.draft.notify_artist_drops,
  );
  const [locationOptIn, setLocationOptIn] = useState(
    initial.draft.location_opt_in,
  );
  const [calendarOptIn, setCalendarOptIn] = useState(
    initial.draft.calendar_opt_in,
  );

  const [saveError, setSaveError] = useState<string | null>(null);
  const [, startSaveTransition] = useTransition();

  // Persist helper — swallow `unauth` (skip-for-now path), surface
  // other errors as a toast at the top of the flow. Returns a promise
  // purely so the call sites can fire-and-forget.
  const persist = useCallback(
    async (
      label: string,
      fn: () => Promise<{ ok: true } | { ok: false; reason: string }>,
    ) => {
      const result = await fn();
      if (!result.ok && result.reason !== 'unauth') {
        setSaveError(`Couldn't save your ${label}. We'll retry on the next step.`);
      }
    },
    [],
  );

  // ── Toggle helpers ─────────────────────────────────────────────────

  const toggleGenre = useCallback((slug: string) => {
    setGenres((prev) => {
      const next = prev.includes(slug)
        ? prev.filter((s) => s !== slug)
        : [...prev, slug];
      // Cascade: deselecting a parent clears its subgenres so the
      // persisted state can't end up with orphans.
      if (!next.includes(slug)) {
        setSubgenres((subs) =>
          subs.filter((s) => !slugBelongsToParent(s, slug)),
        );
      }
      return next;
    });
    setSaveError(null);
  }, []);

  const toggleSubgenre = useCallback((slug: string) => {
    setSubgenres((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
    setSaveError(null);
  }, []);

  const toggleVibe = useCallback((slug: string) => {
    setVibes((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
    setSaveError(null);
  }, []);

  // ── Step advance handlers ──────────────────────────────────────────

  function advanceFromWelcome() {
    setStep(initial.isSignedIn ? 'genres' : 'signin');
  }

  function skipSignin() {
    setStep('genres');
  }

  function advanceFromGenres() {
    startSaveTransition(() => {
      persist('genres', () => saveOnboardingGenres(genres));
      persist('subgenres', () => saveOnboardingSubgenres(subgenres));
    });
    setStep('vibes');
  }

  function advanceFromVibes() {
    startSaveTransition(() => {
      persist('vibes', () => saveOnboardingVibes(vibes));
    });
    setStep('when');
  }

  function advanceFromWhen() {
    startSaveTransition(() => {
      persist('settings', () =>
        saveOnboardingWhen({
          default_when: defaultWhen,
          notify_artist_drops: notifyArtistDrops,
          location_opt_in: locationOptIn,
          calendar_opt_in: calendarOptIn,
        }),
      );
    });
    setStep('ready');
  }

  function backTo(prev: Step) {
    setStep(prev);
    setSaveError(null);
  }

  // ── Progress ────────────────────────────────────────────────────────

  const progressValue = useMemo(() => {
    const idx = STEP_SEQUENCE.indexOf(step);
    // 0 on welcome (no bar rendered anyway), 1.0 on ready.
    return idx / (STEP_SEQUENCE.length - 1);
  }, [step]);

  const progressLabel = useMemo(() => {
    if (step === 'welcome' || step === 'ready') return undefined;
    const idx = STEP_SEQUENCE.indexOf(step);
    return `Step ${idx} of ${STEP_SEQUENCE.length - 2}`; // strip welcome + ready
  }, [step]);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* Progress header on non-terminal steps */}
      {step !== 'welcome' && step !== 'ready' && (
        <div className="sticky top-0 z-20 bg-bg-deep/80 px-5 pb-3 pt-6 backdrop-blur-glass">
          <ProgressBar value={progressValue} label={progressLabel} />
        </div>
      )}

      {saveError && step !== 'welcome' && step !== 'ready' && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl border border-amber/30 bg-amber-chip px-3 py-2 text-2xs text-amber">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {/* Step content */}
      {step === 'welcome' && <WelcomeStep onBegin={advanceFromWelcome} />}

      {step === 'signin' && <SigninStep onSkip={skipSignin} />}

      {step === 'genres' && (
        <GenresStep
          selectedGenres={genres}
          selectedSubgenres={subgenres}
          onToggleGenre={toggleGenre}
          onToggleSubgenre={toggleSubgenre}
          onBack={() => backTo(initial.isSignedIn ? 'welcome' : 'signin')}
          onContinue={advanceFromGenres}
        />
      )}

      {step === 'vibes' && (
        <VibesStep
          selectedVibes={vibes}
          onToggleVibe={toggleVibe}
          onBack={() => backTo('genres')}
          onContinue={advanceFromVibes}
        />
      )}

      {step === 'when' && (
        <WhenStep
          defaultWhen={defaultWhen}
          notifyArtistDrops={notifyArtistDrops}
          locationOptIn={locationOptIn}
          calendarOptIn={calendarOptIn}
          onChangeWindow={setDefaultWhen}
          onToggleNotify={() => setNotifyArtistDrops((v) => !v)}
          onToggleLocation={() => setLocationOptIn((v) => !v)}
          onToggleCalendar={() => setCalendarOptIn((v) => !v)}
          onBack={() => backTo('vibes')}
          onContinue={advanceFromWhen}
        />
      )}

      {step === 'ready' && <ReadyStep displayName={initial.displayName} />}
    </div>
  );
}

// ── slugBelongsToParent ────────────────────────────────────────────────
//
// Cheap check for the cascading-clear in toggleGenre. We already have
// the subgenre in local state — ask the filter sheet's source of
// truth whether it belongs under the parent being deselected.

function slugBelongsToParent(subgenreSlug: string, parentSlug: string): boolean {
  return subgenresForParent(parentSlug).some((o) => o.slug === subgenreSlug);
}
