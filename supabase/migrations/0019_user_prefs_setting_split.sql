-- Phase 3.18 follow-up: split user_prefs.preferred_vibes into vibes + setting,
-- and migrate stale genre slugs to the new vocabulary.
--
-- Context:
--   The Phase 3.18 vocabulary rebuild reframed "vibes" as artist-mood
--   only (groovy, hypnotic, dark, ...) and introduced a new Setting
--   filter (warehouse, basement, daytime, ...) backed by events.setting
--   from migration 0017. Existing user_prefs rows mixed the two — many
--   stored 'warehouse', 'daytime', 'peak-time' in preferred_vibes
--   because that's what the old onboarding step offered.
--
-- This migration:
--   (1) adds preferred_setting text[] to user_prefs
--   (2) walks each row: any value in preferred_vibes that matches the
--       new SETTING_OPTIONS vocabulary moves to preferred_setting; the
--       rest stays in preferred_vibes (filtered to the new VIBE_OPTIONS
--       vocabulary)
--   (3) renames jungle → dnb in preferred_genres (jungle was a parent
--       in the MVP, dropped in Phase 3.18 since data has 0 events at
--       the parent level)
--
-- No audit backup since user_prefs is a personalization layer; the
-- destructive side is recoverable by re-running onboarding.

alter table public.user_prefs
  add column if not exists preferred_setting text[] not null default '{}';

comment on column public.user_prefs.preferred_setting is
  'Phase 3.18 — selected event-context settings (warehouse, basement, daytime, peak-time, late-night, outdoor, underground). Distinct from preferred_vibes (artist-mood). Vocabulary matches lib/filters.ts SETTING_OPTIONS.';

-- (1) Move setting-vocab values from preferred_vibes → preferred_setting
update public.user_prefs
  set
    preferred_setting = (
      select coalesce(array_agg(distinct v), array[]::text[])
      from unnest(coalesce(preferred_vibes, array[]::text[])) v
      where v in ('warehouse','basement','outdoor','daytime',
                  'peak-time','late-night','underground')
    ),
    preferred_vibes = (
      select coalesce(array_agg(distinct v), array[]::text[])
      from unnest(coalesce(preferred_vibes, array[]::text[])) v
      where v not in ('warehouse','basement','outdoor','daytime',
                      'peak-time','late-night','underground',
                      -- Drop slugs that no longer exist in the new
                      -- VIBE_OPTIONS vocabulary at all (e.g. 'queer'
                      -- was removed from settings AND vibes).
                      'queer','industrial')
    );

-- (2) jungle → dnb in preferred_genres
update public.user_prefs
  set preferred_genres = preferred_genres || array['dnb']::text[]
  where 'jungle' = any(preferred_genres) and not ('dnb' = any(preferred_genres));
update public.user_prefs
  set preferred_genres = array_remove(preferred_genres, 'jungle')
  where 'jungle' = any(preferred_genres);
