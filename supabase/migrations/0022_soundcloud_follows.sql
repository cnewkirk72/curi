-- Phase 5.6 — SoundCloud follow-graph personalized sort.
--
-- Adds:
--   1. user_soundcloud_follows — per-user public-follow-graph snapshot,
--      one row per (user, followed artist). Sourced by the Phase 5.6
--      scraper (api-v2 with anon client_id, Playwright fallback).
--      Refreshed on connect, weekly on Sunday cron, and lazily on app
--      open after a 14-day staleness threshold.
--   2. user_prefs.soundcloud_username + soundcloud_last_synced_at —
--      the user's *own* SC handle (the one we scrape) and connect-state
--      timestamp. Distinct from the followed-artist usernames above.
--   3. artists.soundcloud_username — normalized, lowercased SC profile
--      slug extracted from soundcloud_url. The join key between
--      user_soundcloud_follows.soundcloud_username and lineup artists,
--      used by enrichmentScore() in apps/web/src/lib/enrichment.ts to
--      add a FOLLOWED_ARTIST_BOOST when an event's lineup overlaps the
--      signed-in user's follow set.
--
-- Backfill:
--   The artists.soundcloud_username column is populated from existing
--   artists.soundcloud_url at migration time. Strict regex: only writes
--   when the URL is a clean profile URL (`soundcloud.com/<slug>` or
--   `.../<slug>/`). URLs with /tracks/ or /sets/ subpaths get NULL —
--   their first path segment isn't reliably the artist's profile slug.
--   ~1,295 of 1,303 rows backfill cleanly. The 8 misses are rows where
--   non-SoundCloud domains were stuffed into the soundcloud_url column
--   (custom artist sites masquerading as SC URLs); flagged for a
--   separate data-quality cleanup pass.
--
-- RLS:
--   user_soundcloud_follows is per-user owned with the same four
--   per-command policy pattern as user_prefs/profiles/user_saves.
--   artists already has artists_public_read so the new column inherits
--   read access without a new policy. user_prefs already has its own
--   four policies so the new columns inherit.
--
-- Index strategy:
--   Lower() is applied at write time (not at read time via
--   `lower(soundcloud_username)` in the join) so the b-tree index
--   matches naked equality without needing a functional expression
--   match. Partial index on user_prefs because un-connected users
--   have NULL there and shouldn't bloat the index.
--
-- Sizing (rough): the table is bounded by user count × per-user follow
-- count. At MVP scale (50-500 users × ~250 follows median) ~50-125k
-- rows; the lower(username) index adds ~5MB. Negligible.

-- Per-user SC follow graph: one row per (user, followed artist).
create table public.user_soundcloud_follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  soundcloud_username text not null,
  display_name text,
  followed_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (user_id, soundcloud_username)
);

alter table public.user_soundcloud_follows enable row level security;

create policy "user_soundcloud_follows_select_own"
  on public.user_soundcloud_follows for select
  using (auth.uid() = user_id);

create policy "user_soundcloud_follows_insert_own"
  on public.user_soundcloud_follows for insert
  with check (auth.uid() = user_id);

create policy "user_soundcloud_follows_update_own"
  on public.user_soundcloud_follows for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_soundcloud_follows_delete_own"
  on public.user_soundcloud_follows for delete
  using (auth.uid() = user_id);

create index idx_user_soundcloud_follows_username
  on public.user_soundcloud_follows (lower(soundcloud_username));

-- Connect-state columns on user_prefs. user_prefs already has its own RLS
-- so new columns inherit. soundcloud_username here is the user's *own* SC
-- handle (the one we scrape), distinct from the followed-artist usernames
-- in the table above.
alter table public.user_prefs
  add column soundcloud_username text,
  add column soundcloud_last_synced_at timestamptz;

-- Lookup index for the cron's "users due for re-sync" sweep. Partial
-- index because un-connected users have NULL here and don't need to be
-- in the index.
create index idx_user_prefs_soundcloud_username
  on public.user_prefs (lower(soundcloud_username))
  where soundcloud_username is not null;

-- Normalized username on artists for the join. Lower() index because SC
-- treats /Artistname and /artistname as the same profile.
alter table public.artists
  add column soundcloud_username text;

create index idx_artists_soundcloud_username
  on public.artists (lower(soundcloud_username));

-- Backfill from existing soundcloud_url. Strict regex: only writes when
-- the URL is a clean profile URL. URLs with /tracks/ or /sets/ subpaths
-- get NULL because their first path segment isn't reliably the artist's
-- profile slug.
update public.artists
set soundcloud_username = lower(
  split_part(
    regexp_replace(soundcloud_url, '^https?://(www\.)?soundcloud\.com/', '', 'i'),
    '/', 1
  )
)
where soundcloud_url is not null
  and soundcloud_url <> ''
  and soundcloud_url ~* '^https?://(www\.)?soundcloud\.com/[^/]+/?$';

comment on column public.artists.soundcloud_username is
  'Lowercased SoundCloud profile slug, extracted from soundcloud_url at write time. '
  'Join key for user_soundcloud_follows in the Phase 5.6 follow-boost sort.';

comment on column public.user_prefs.soundcloud_username is
  'The user''s own SoundCloud username (their account, not artists they follow). '
  'Set when the user connects SC on /profile.';

comment on column public.user_prefs.soundcloud_last_synced_at is
  'Last successful sync of the user''s public follow graph into '
  'user_soundcloud_follows. NULL until first sync completes.';

comment on table public.user_soundcloud_follows is
  'Per-user public-follow-graph snapshot from SoundCloud. Sourced by the '
  'Phase 5.6 scraper (api-v2 with anon client_id, Playwright fallback). '
  'Refreshed on connect, weekly on Sunday cron, and lazily on app open '
  'after a 14-day staleness threshold.';
