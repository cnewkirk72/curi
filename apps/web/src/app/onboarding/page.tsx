// /onboarding — entry point for the 5-step taste flow.
//
// This is the first screen a brand-new signed-in user hits after
// auth/callback (see migration 0013's handle_new_user trigger).
// It's also the screen the middleware gate in Task #6 bounces
// returning-signed-in users to when `onboarding_completed_at` is
// still null.
//
// Responsibilities:
//   1. Auth check — we allow anon viewers through (the Welcome +
//      Skip path is explicitly designed for a pre-signed-in user).
//   2. Completion check — signed-in users with a stamped
//      onboarding_completed_at have already been here; we redirect
//      them to the feed so they can't accidentally re-run the flow
//      by typing /onboarding into the URL.
//   3. Hydration — fetch the user's existing profile + prefs so
//      returning-but-unfinished users see their prior picks
//      pre-selected instead of a blank slate.
//   4. Render — hand everything to <OnboardingFlow> as `initial`.
//
// We don't render the global AppHeader or BottomNav here. Onboarding
// is a chromeless, full-bleed experience — ambient blobs + step
// content + progress bar only.

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getMyProfile } from '@/lib/profile';
import { getUserPrefs, DEFAULT_PREFS } from '@/lib/preferences';
import { AmbientBlobs } from '@/components/onboarding/ambient-blobs';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';

// Always run on the server and never cache — cookie state + per-user
// RLS reads mean there's nothing reusable across requests here.
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Signed-in user with finished onboarding → bounce to feed. Done
  // here as a soft gate; the middleware in Task #6 handles the
  // inverse case (signed-in but unfinished should be redirected
  // *to* /onboarding from other routes).
  //
  // Anon viewers (Skip-for-now path, or users who hit /onboarding
  // before signing in at all) are allowed through — we can't read
  // their prefs, so they get DEFAULT_PREFS as the initial draft.
  let prefs = DEFAULT_PREFS;
  let displayName: string | null = null;

  if (user) {
    const [fetchedPrefs, profile] = await Promise.all([
      getUserPrefs(),
      getMyProfile(),
    ]);

    if (fetchedPrefs.onboarding_completed_at) {
      // Already done — send them to the feed (which lives at `/`).
      // A future "re-run onboarding" entry from Profile could
      // special-case a `?force=1` param here, but we don't
      // support that yet.
      redirect('/');
    }

    prefs = fetchedPrefs;
    displayName = profile?.display_name ?? null;
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-bg-deep text-fg-primary">
      {/* Same cyan + violet blob pair as /login — keeps the brand
          continuity tight across the auth/onboarding seam. `calm`
          makes them pulse a beat slower so the hero screen feels
          less frantic. */}
      <AmbientBlobs calm />

      {/* Flow is a stacking context above the blobs. */}
      <div className="relative z-10">
        <OnboardingFlow
          initial={{
            isSignedIn: !!user,
            displayName,
            draft: {
              preferred_genres: prefs.preferred_genres,
              preferred_subgenres: prefs.preferred_subgenres,
              preferred_vibes: prefs.preferred_vibes,
              default_when: prefs.default_when,
              notify_artist_drops: prefs.notify_artist_drops,
              location_opt_in: prefs.location_opt_in,
              calendar_opt_in: prefs.calendar_opt_in,
            },
          }}
        />
      </div>
    </main>
  );
}
