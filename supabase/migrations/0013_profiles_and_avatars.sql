-- ────────────────────────────────────────────────────────────────────────
-- Curi — Phase 5.1: profiles table, OAuth seed trigger, avatars bucket
--
-- Splits user-facing identity (username, display name, avatar) away
-- from user_prefs, which stays private. The split is deliberate:
--
--   profiles    — PUBLIC-read. Anyone signed in can look up a username,
--                 see someone's display name + avatar. This is what
--                 powers @handle lookups, friend-of-friend "who's
--                 going" UI, and the forthcoming social layer. There
--                 is nothing on this row that leaks behavior.
--
--   user_prefs  — OWNER-only. Taste preferences, notification opt-ins,
--                 location/calendar consent, onboarding completion
--                 marker. These are behavioral and must not be
--                 readable by other users.
--
-- Rows are seeded automatically on auth.users insert via a
-- SECURITY DEFINER trigger, so the first time a Google-OAuth user
-- hits the site we already have display_name + avatar_url populated
-- from their id_token claims. The trigger is ON CONFLICT DO NOTHING
-- so re-seeding (e.g. during backfill) is safe.
--
-- citext powers case-insensitive username uniqueness: `curi` and
-- `CURI` collide at the DB layer, so we don't need a lower(…) unique
-- index or app-side normalization.
-- ────────────────────────────────────────────────────────────────────────

create extension if not exists citext;

-- ── profiles ────────────────────────────────────────────────────────
create table public.profiles (
  -- PK == auth.users.id. `on delete cascade` means nuking the auth
  -- row automatically tears down the profile (and everything that
  -- cascades off it via FK chains) — no orphaned profile rows after
  -- a GDPR-style account deletion.
  id              uuid primary key references auth.users(id) on delete cascade,

  -- Case-insensitive unique handle. Nullable because a freshly-
  -- signed-in user doesn't have one until they pick one during
  -- onboarding (or in Profile settings). citext + UNIQUE means
  -- the first person to claim a casing "owns" every casing.
  username        citext unique,

  -- Human-readable name. Seeded from Google id_token's `full_name`
  -- (fallback `name`) on first login; editable later. Kept separate
  -- from `username` so users can change either independently.
  display_name    text,

  -- Absolute URL to the user's avatar. Initially points at the
  -- Google-hosted `picture` URL from raw_user_meta_data; once the
  -- user uploads a custom image via the Storage flow below, this
  -- gets rewritten to the Supabase Storage public URL. Nullable so
  -- a user with no Google picture and no custom upload is still
  -- representable (the UI renders initials in that case).
  avatar_url      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- ── auto-seed on new auth.users insert ──────────────────────────────
--
-- SECURITY DEFINER is required because the trigger fires inside the
-- auth schema (which the anon role can't write to by itself). Pinning
-- search_path to '' matches the pattern from 0002_harden_functions
-- and sidesteps the `function_search_path_mutable` advisory.
--
-- We look for the display-name claim under both `full_name` (Google's
-- canonical key in Supabase's OAuth flow) and `name` (some providers
-- use this), and the picture under both `picture` (Google) and
-- `avatar_url` (GitHub, etc.). This keeps the trigger provider-agnostic
-- for when we add more sign-in methods later.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    coalesce(
      new.raw_user_meta_data ->> 'picture',
      new.raw_user_meta_data ->> 'avatar_url'
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ── backfill for existing auth.users ────────────────────────────────
--
-- The trigger only fires on future inserts. Christian + any other
-- pre-existing auth rows (e.g. Ahmed's test account) need one-shot
-- backfill so the profile lookup doesn't 404 for them after this
-- migration lands. Same coalesce pattern as the trigger; ON CONFLICT
-- DO NOTHING keeps this idempotent if it somehow gets re-run.
insert into public.profiles (id, display_name, avatar_url)
select
  u.id,
  coalesce(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name'
  ),
  coalesce(
    u.raw_user_meta_data ->> 'picture',
    u.raw_user_meta_data ->> 'avatar_url'
  )
from auth.users u
on conflict (id) do nothing;

-- ── RLS ─────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Public-read. Intentional — this is the row that powers @username
-- lookups and "who's going" UI. There's nothing on it that leaks
-- behavior; everything private lives on user_prefs.
create policy profiles_public_read on public.profiles
  for select using (true);

-- Owner-only insert. The `with check` half stops a client from
-- inserting a row with someone else's id (even if the trigger means
-- we don't expect inserts from clients in normal operation — if a
-- user deletes their profile and later recreates it, the app will
-- insert from the client side).
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);

-- Owner-only update. Both `using` and `with check` gated on the
-- same predicate so a user can't reassign a row away from themselves
-- mid-update.
create policy profiles_update_own on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Owner-only delete. Rare in practice — account deletion cascades
-- from auth.users — but exposed so "reset my profile" flows work
-- without an admin round-trip.
create policy profiles_delete_own on public.profiles
  for delete using (auth.uid() = id);

-- ── avatars Storage bucket ──────────────────────────────────────────
--
-- Public bucket: objects are served from a stable public URL so the
-- PWA can drop them into <img src> without signing URLs. Per-user
-- folder pattern means each user can only write to `avatars/<uid>/…`;
-- writes to another user's folder are rejected at the RLS layer.
--
-- We don't set file_size_limit / allowed_mime_types here — those are
-- enforced client-side in the upload flow (Phase 5.1 profile-form).
-- If we later want DB-level enforcement we can alter the bucket row.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Public read on anything in the bucket — this is what makes
-- `avatar_url` directly linkable from <img>. Matches the bucket's
-- `public = true` flag but is explicit so the intent is obvious
-- when someone's reading policies.
create policy avatars_public_read on storage.objects
  for select using (bucket_id = 'avatars');

-- Per-user folder writes. `storage.foldername(name)` splits a path
-- like `<uid>/avatar.png` into `{'<uid>', 'avatar.png'}`, and we
-- compare the first segment to auth.uid(). Any upload that lands
-- outside the user's own folder is rejected.
create policy avatars_insert_own on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy avatars_update_own on storage.objects
  for update using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy avatars_delete_own on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
