-- Phase 5.7 — Spotify follow-graph schema.
-- Mirrors migration 0022's user_soundcloud_follows shape.

create table public.user_spotify_follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  spotify_artist_id text not null,
  display_name text,
  followed_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (user_id, spotify_artist_id)
);

-- Same RLS pattern as user_soundcloud_follows: owner-only read/write.
alter table public.user_spotify_follows enable row level security;

create policy "user_spotify_follows_select_own"
  on public.user_spotify_follows
  for select using (auth.uid() = user_id);

create policy "user_spotify_follows_insert_own"
  on public.user_spotify_follows
  for insert with check (auth.uid() = user_id);

create policy "user_spotify_follows_update_own"
  on public.user_spotify_follows
  for update using (auth.uid() = user_id);

create policy "user_spotify_follows_delete_own"
  on public.user_spotify_follows
  for delete using (auth.uid() = user_id);

-- Index for the per-user read path (replace-not-merge sync hits this
-- on every refresh).
create index user_spotify_follows_user_idx
  on public.user_spotify_follows (user_id);

-- Index for the lineup-match path (per-event check during candidate-
-- pool augmentation: "events whose lineup features any artist with
-- spotify_id ∈ user's follow set"). Maps to the existing
-- artists.spotify_id column from Phase 4 enrichment.
create index user_spotify_follows_artist_idx
  on public.user_spotify_follows (spotify_artist_id);

-- user_prefs additions: the Spotify user ID we extracted from the URL,
-- and the sync timestamp. Mirrors user_prefs.soundcloud_username +
-- user_prefs.soundcloud_last_synced_at from migration 0022.
alter table public.user_prefs
  add column if not exists spotify_user_id text,
  add column if not exists spotify_last_synced_at timestamptz;

-- artists.spotify_id already exists from Phase 4 enrichment. No
-- backfill needed — every artist with a spotify_url already has a
-- spotify_id populated.
