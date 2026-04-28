-- Phase 6.3 v2 — smart search infrastructure.
--
-- Adds:
--   1. pg_trgm extension for typo-tolerant fuzzy matching (so "deborah"
--      matches "Deborah De Luca" and "publi recrds" matches "Public Records").
--   2. GIN trigram indexes on lower(events.title), lower(artists.name),
--      lower(venues.name). All three are read by `search_suggestions`
--      below; indexed on the lowered expression so case-insensitive
--      `%` matches use the index instead of a seq scan.
--   3. `search_suggestions(q text)` RPC — single round-trip that returns
--      three buckets (events / artists / venues) ranked by trigram
--      similarity. Results are LIMITed per bucket (10 / 5 / 3) so the
--      payload is bounded regardless of how broad the query is.
--
-- Search semantics:
--   - Events bucket only includes upcoming shows (starts_at >= now()) so
--     stale past events don't pollute the dropdown.
--   - Artists bucket suppresses very-low confidence enrichments (the
--     same rule already used by the lineup-aggregation UI in
--     apps/web/src/lib/events.ts), since those rows are usually scraping
--     stubs that the user wouldn't recognise.
--   - The RPC is `stable security invoker` — RLS still applies to the
--     callers (anon and authenticated). All three source tables are
--     publicly readable, so this is a no-op in practice but keeps the
--     security model consistent if we ever tighten read policies.
--
-- Index sizing (rough): with ~700 events, ~1900 artists, ~few hundred
-- venues, GIN trigram indexes are ~2-3MB each. Negligible.

create extension if not exists pg_trgm;

create index if not exists idx_events_title_trgm
  on public.events using gin (lower(title) gin_trgm_ops);

create index if not exists idx_artists_name_trgm
  on public.artists using gin (lower(name) gin_trgm_ops);

create index if not exists idx_venues_name_trgm
  on public.venues using gin (lower(name) gin_trgm_ops);

-- ── search_suggestions RPC ────────────────────────────────────────
--
-- Single-call typeahead source for the GlobalSearch dropdown. Returns
-- a flat result set with a `kind` discriminator so the client can
-- group rows into Events / Artists / Venues sections.
--
-- Argument:
--   q — raw user input, lowercased + trimmed inside the function. No
--       length validation here; the client should bail before calling
--       on an empty string. Trigram operator `%` requires the argument
--       to share at least one trigram with the candidate, so a single-
--       character query just returns nothing rather than the full table.
--
-- Return columns:
--   kind        — 'event' | 'artist' | 'venue'
--   id          — the row's primary key (uuid). Used for keys and
--                 (for events) navigating to the detail page via
--                 `?event=<id>`. Artists/venues use slug for routing.
--   slug        — artists.slug / venues.slug. NULL for events (events
--                 don't have a slug column).
--   title       — display name (event title / artist name / venue name).
--   subtitle    — secondary text. For events, the venue name. For venues,
--                 the neighborhood. NULL for artists (the dropdown shows
--                 just the artist name and avatar).
--   image_url   — preferred thumbnail. Cascaded for events and artists
--                 (see comments inline) so the dropdown matches the
--                 feed's avatar fallback chain. Venues use venues.image_url
--                 directly, falling back to NULL (client renders gradient).
--   score       — trigram similarity in [0, 1]. The client uses this for
--                 the entity-button threshold (>= 0.7 surfaces "Show
--                 events with [X]" / "Show events at [X]").
--   starts_at   — only set for events; lets the client tiebreak on
--                 chronological order when two events have identical
--                 similarity scores.

create or replace function public.search_suggestions(q text)
returns table (
  kind text,
  id uuid,
  slug text,
  title text,
  subtitle text,
  image_url text,
  score real,
  starts_at timestamptz
)
language sql
stable
security invoker
as $$
  with q_norm as (
    select lower(trim(q)) as needle
    where length(trim(q)) >= 1
  )
  -- Events: title trigram match. Cascade image_url through the same
  -- chain the EventCard uses on the home feed (event hero → venue
  -- photo) so the dropdown thumbnails match what the user sees on the
  -- card after they tap through.
  (
    select
      'event'::text as kind,
      e.id,
      null::text as slug,
      e.title,
      v.name as subtitle,
      coalesce(e.image_url, v.image_url) as image_url,
      similarity(lower(e.title), (select needle from q_norm))::real as score,
      e.starts_at
    from public.events e
    left join public.venues v on v.id = e.venue_id
    where e.starts_at >= now()
      and (
        e.title % (select needle from q_norm)
        or lower(e.title) like '%' || (select needle from q_norm) || '%'
      )
    order by score desc, e.starts_at asc
    limit 10
  )
  union all
  -- Artists: name trigram match. Cascade image_url through the same
  -- spotify → soundcloud → bandcamp chain the lineup avatars use.
  -- Suppress very-low confidence rows so scraper stubs don't surface.
  (
    select
      'artist'::text as kind,
      a.id,
      a.slug,
      a.name as title,
      null::text as subtitle,
      coalesce(a.spotify_image_url, a.soundcloud_image_url, a.bandcamp_image_url) as image_url,
      similarity(lower(a.name), (select needle from q_norm))::real as score,
      null::timestamptz as starts_at
    from public.artists a
    where a.name % (select needle from q_norm)
      and (a.enrichment_confidence is null or a.enrichment_confidence <> 'very-low')
    order by score desc
    limit 5
  )
  union all
  -- Venues: name trigram match. No cascade — venues only have one
  -- image source. NULL renders as a gradient placeholder client-side.
  (
    select
      'venue'::text as kind,
      v.id,
      v.slug,
      v.name as title,
      v.neighborhood as subtitle,
      v.image_url,
      similarity(lower(v.name), (select needle from q_norm))::real as score,
      null::timestamptz as starts_at
    from public.venues v
    where v.name % (select needle from q_norm)
    order by score desc
    limit 3
  );
$$;

-- Public read RPC — anon (logged-out users) and authenticated both
-- need to call this from the search dropdown.
grant execute on function public.search_suggestions(text) to anon, authenticated;
