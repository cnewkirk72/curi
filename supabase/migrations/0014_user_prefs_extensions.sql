-- ────────────────────────────────────────────────────────────────────────
-- Curi — Phase 5.1/5.2: user_prefs extensions for onboarding
--
-- Adds six columns used by the onboarding flow and the feed's
-- personalization pipeline. Everything lands on user_prefs (not
-- profiles) because all of these are behavioral/taste fields — they
-- must stay under the owner-only RLS from 0005.
--
--   preferred_subgenres      taste (Phase 5.4 picker writes here)
--   default_when             taste (lands the feed on a window)
--   notify_artist_drops      notification opt-in
--   location_opt_in          consent flag for future "near me" UX
--   calendar_opt_in          consent flag for future .ics export
--   onboarding_completed_at  gates /onboarding middleware redirect
--
-- RLS stays exactly as 0005 wrote it — owner-only across the board —
-- because every new column here is private. No policy changes needed.
-- ────────────────────────────────────────────────────────────────────────

-- ── Taste / feed biasing ────────────────────────────────────────────
--
-- preferred_subgenres is the parallel of preferred_genres but for the
-- auto-created subgenre layer from migration 0003. The feed scorer
-- can prefer events whose artists' `subgenres[]` overlaps this array
-- to get a tighter personalization signal than genres alone.
alter table public.user_prefs
  add column preferred_subgenres text[] not null default '{}';

-- default_when seeds the feed's date filter when a signed-in user
-- lands on `/` with no `?when=` in the URL. Nullable — null means
-- "no preference, show everything upcoming" (the current default).
-- The CHECK keeps the domain aligned with DateFilter in lib/filters.ts
-- (minus 'all' and 'tomorrow' — those don't make sense as a *default*
-- home-feed window, since 'all' is already the fallback and 'tomorrow'
-- is too transient).
alter table public.user_prefs
  add column default_when text
    check (default_when in ('weekend', 'tonight', 'week'));

-- ── Notifications / consent flags ───────────────────────────────────
--
-- All three default to false so we never silently opt a user into
-- notifications, location probes, or calendar integration. The
-- onboarding flow surfaces them as explicit toggles; without that
-- affirmative action, they stay off.
alter table public.user_prefs
  add column notify_artist_drops boolean not null default false;

alter table public.user_prefs
  add column location_opt_in     boolean not null default false;

alter table public.user_prefs
  add column calendar_opt_in     boolean not null default false;

-- ── Onboarding completion marker ────────────────────────────────────
--
-- Nullable timestamp. The middleware redirect gate (Phase 5.2, task
-- #6) reads this: if the signed-in user's user_prefs row is missing
-- or this column is null, they get bounced to /onboarding. Stamped
-- at the end of the flow via the server action. Nullable (not
-- boolean) so we both know *that* they onboarded and *when*, which
-- is useful for analytics + for bumping users through a re-onboarding
-- flow if we change the schema later.
alter table public.user_prefs
  add column onboarding_completed_at timestamptz;
