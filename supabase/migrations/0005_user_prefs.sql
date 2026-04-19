-- ────────────────────────────────────────────────────────────────────────
-- Curi — Phase 3.11: user preferences
--
-- One row per auth user, owned by that user. Stores genre/flavor
-- preferences (used to bias the feed toward what the viewer is into)
-- and a single opt-in flag for a future weekly email digest.
--
-- Intentionally narrow: this is NOT a general-purpose KV bag. Each
-- field is a first-class column so RLS, validation, and query planner
-- behavior are all straightforward.
--
-- RLS mirrors user_saves: owners can select/insert/update/delete
-- their own row; no one else can read or write it. There is no
-- public-read policy — even signed-in users can't see each other's
-- preferences.
-- ────────────────────────────────────────────────────────────────────────

-- ── user_prefs ──────────────────────────────────────────────────────
create table public.user_prefs (
  user_id              uuid primary key references auth.users(id) on delete cascade,

  -- Genre slugs the viewer is into. Matches the `genres` column on
  -- events — so `overlaps('genres', preferred_genres)` is the natural
  -- "is this relevant to me" predicate, and the existing
  -- events_genres_gin index from 0001 serves that query plan.
  preferred_genres     text[] not null default '{}',

  -- Vibe slugs (same shape as events.flavors; events_flavors_gin
  -- likewise serves the overlap query).
  preferred_flavors    text[] not null default '{}',

  -- Opt-in for the future weekly email. Defaults to false so we
  -- don't accidentally ship a surprise-email product — every user
  -- has to explicitly tick the box.
  digest_email         boolean not null default false,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger user_prefs_set_updated_at
before update on public.user_prefs
for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
alter table public.user_prefs enable row level security;

-- Owner-only read. No public policy — user_prefs is private,
-- full stop. If we ever want shareable "taste profiles" that would
-- be a separate, explicitly-shared table.
create policy user_prefs_select_own on public.user_prefs
  for select using (auth.uid() = user_id);

-- Owner-only insert. The `with check` half enforces that a user
-- can't insert a row pointing at a different user_id — even if the
-- client tries to forge it.
create policy user_prefs_insert_own on public.user_prefs
  for insert with check (auth.uid() = user_id);

-- Owner-only update. Both `using` (which rows are updateable) and
-- `with check` (what the post-update row may look like) gated on
-- the same predicate, so a user can't reassign a row away from
-- themselves mid-update.
create policy user_prefs_update_own on public.user_prefs
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Owner-only delete (lets someone nuke their prefs as part of a
-- future "reset my data" flow without having to go through
-- GDPR-style account deletion).
create policy user_prefs_delete_own on public.user_prefs
  for delete using (auth.uid() = user_id);
