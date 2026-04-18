-- ─────────────────────────────────────────────────────────────────────────────
-- Curi — Phase 2 taxonomy extensions
--
-- Adds auto-created subgenres layer. The `taxonomy_map` table stays 100%
-- human-curated — auto-inference writes to `taxonomy_subgenres` and links
-- back to the matched parent entry.
--
-- Also adds `artists.subgenres text[]` so the PWA can filter by subgenre
-- independently of the high-level `artists.genres[]`.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.taxonomy_subgenres (
  id               uuid primary key default gen_random_uuid(),
  input_tag        text not null unique,
  parent_tag_id    uuid not null references public.taxonomy_map(id) on delete cascade,
  genres           text[] not null default '{}',
  flavors          text[] not null default '{}',
  confidence       numeric(3,2) not null,
  auto_created_at  timestamptz not null default now(),
  constraint taxonomy_subgenres_confidence_range
    check (confidence >= 0 and confidence <= 1)
);

create index taxonomy_subgenres_input_lower_idx
  on public.taxonomy_subgenres (lower(input_tag));
create index taxonomy_subgenres_parent_idx
  on public.taxonomy_subgenres (parent_tag_id);

alter table public.taxonomy_subgenres enable row level security;

create policy taxonomy_subgenres_public_read on public.taxonomy_subgenres
  for select using (true);

-- Artists gain a parallel `subgenres[]` alongside the existing `genres[]`.
alter table public.artists
  add column subgenres text[] not null default '{}';

create index artists_subgenres_gin on public.artists using gin (subgenres);
