-- ────────────────────────────────────────────────────────────────────────
-- Curi — Phase 1 initial schema
--
-- Tables:  venues, artists, events, event_artists, user_saves, taxonomy_map
-- RLS:     venues / artists / events / taxonomy_map are publicly readable;
--          user_saves is owner-only.
-- ────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ── updated_at helper ───────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── venues ───────────────────────────────────────────────────────────────────────────────
create table public.venues (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  neighborhood   text,
  lat            double precision,
  lng            double precision,
  website        text,
  created_at     timestamptz not null default now()
);

-- ── artists ─────────────────────────────────────────────────────────────────────────────
create table public.artists (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text not null unique,
  musicbrainz_id    text unique,
  mb_tags           jsonb,
  genres            text[] not null default '{}',
  flavors           text[] not null default '{}',
  last_enriched_at  timestamptz
);

create index artists_genres_gin on public.artists using gin (genres);
create index artists_flavors_gin on public.artists using gin (flavors);
create index artists_name_lower_idx on public.artists (lower(name));

-- ── events ───────────────────────────────────────────────────────────────────────────────
create table public.events (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  venue_id     uuid references public.venues(id) on delete set null,
  city         text not null default 'NYC',
  price_min    numeric(8,2),
  price_max    numeric(8,2),
  ticket_url   text,
  source       text not null,
  source_id    text not null,
  description  text,
  image_url    text,
  genres       text[] not null default '{}',
  flavors      text[] not null default '{}',
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint events_source_uniq unique (source, source_id),
  constraint events_time_sane check (ends_at is null or ends_at >= starts_at),
  constraint events_price_sane check (
    (price_min is null and price_max is null) or
    (price_min is not null and price_max is not null and price_max >= price_min)
  )
);

create index events_starts_at_idx   on public.events (starts_at);
create index events_venue_id_idx    on public.events (venue_id);
create index events_genres_gin      on public.events using gin (genres);
create index events_flavors_gin     on public.events using gin (flavors);
create index events_city_starts_idx on public.events (city, starts_at);

create trigger events_set_updated_at
before update on public.events
for each row execute function public.set_updated_at();

-- ── event_artists (m:n, composite pk) ──────────────────────────────────────────────
create table public.event_artists (
  event_id     uuid not null references public.events(id)  on delete cascade,
  artist_id    uuid not null references public.artists(id) on delete cascade,
  is_headliner boolean not null default false,
  position     int not null default 0,
  primary key (event_id, artist_id)
);

create index event_artists_artist_idx on public.event_artists (artist_id);

-- ── user_saves (owner-only) ──────────────────────────────────────────────────────────
create table public.user_saves (
  user_id    uuid not null references auth.users(id) on delete cascade,
  event_id   uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index user_saves_user_idx on public.user_saves (user_id);

-- ── taxonomy_map ───────────────────────────────────────────────────────────────────────
create table public.taxonomy_map (
  id         uuid primary key default gen_random_uuid(),
  input_tag  text not null unique,
  genres     text[] not null default '{}',
  flavors    text[] not null default '{}'
);

create index taxonomy_map_input_lower_idx on public.taxonomy_map (lower(input_tag));

-- ── RLS ─────────────────────────────────────────────────────────────────────────────────
alter table public.venues        enable row level security;
alter table public.artists       enable row level security;
alter table public.events        enable row level security;
alter table public.event_artists enable row level security;
alter table public.taxonomy_map  enable row level security;
alter table public.user_saves    enable row level security;

-- Public read on reference tables
create policy venues_public_read        on public.venues        for select using (true);
create policy artists_public_read       on public.artists       for select using (true);
create policy events_public_read        on public.events        for select using (true);
create policy event_artists_public_read on public.event_artists for select using (true);
create policy taxonomy_public_read      on public.taxonomy_map  for select using (true);

-- user_saves: owner-only (select + insert + delete)
create policy user_saves_select_own on public.user_saves
  for select using (auth.uid() = user_id);

create policy user_saves_insert_own on public.user_saves
  for insert with check (auth.uid() = user_id);

create policy user_saves_delete_own on public.user_saves
  for delete using (auth.uid() = user_id);

-- NOTE: no write policies on venues/artists/events/event_artists/taxonomy_map.
-- Writes come exclusively from the ingestion worker via the service role key,
-- which bypasses RLS. App users cannot mutate these tables.
