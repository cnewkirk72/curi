-- Phase 3.16 — pre-insert duplicate detection for events.
--
-- Context: the existing UNIQUE (source, source_id) constraint prevents a
-- single scraper from ingesting the same event twice, but DOES NOT prevent
-- cross-source duplicates. The observed failure mode (2026-04-22 audit):
-- RA-NYC returns the same physical event from multiple promoter crews under
-- different source_ids — "Sunny Side Up presents: Annicka 04/24",
-- "Easy Tiger presents: Annicka 04/24", "Annicka 04/24" — all at Unveiled,
-- all at 9 PM, all with the same [Annicka] lineup. The constraint is happy
-- because each has a distinct (ra-nyc, <source_id>) pair.
--
-- This function is called by the ingestion normalizer (packages/ingestion/
-- src/normalizer.ts) BEFORE upserting a new event. It returns the first
-- existing event that shares:
--   (a) the same venue_id
--   (b) a starts_at within ±60 minutes
--   (c) at least one artist (by slug) with the incoming lineup
--
-- Excludes rows with the same (source, source_id) as the incoming event so
-- a repeat-ingest of the same scraper row doesn't look like a duplicate of
-- itself — that path is handled by the existing upsert onConflict clause.
--
-- Returns at most one row (LIMIT 1, earliest-created match wins). The caller
-- interprets "found = skip insert, merge what's safe"; "not found = proceed
-- with upsert as normal". Multi-room venues are protected because different
-- rooms have disjoint lineups — no shared artist slug → no false match.

CREATE OR REPLACE FUNCTION public.find_dupe_event_by_artist(
  p_venue_id uuid,
  p_starts_at timestamptz,
  p_artist_slugs text[],
  p_exclude_source text,
  p_exclude_source_id text
)
RETURNS TABLE (
  id uuid,
  title text,
  source text,
  source_id text,
  starts_at timestamptz,
  image_url text,
  description text,
  ticket_url text,
  price_min numeric,
  price_max numeric,
  ends_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT e.id, e.title, e.source, e.source_id, e.starts_at,
         e.image_url, e.description, e.ticket_url,
         e.price_min, e.price_max, e.ends_at
  FROM events e
  WHERE e.venue_id = p_venue_id
    AND e.starts_at BETWEEN (p_starts_at - INTERVAL '60 minutes')
                        AND (p_starts_at + INTERVAL '60 minutes')
    AND NOT (e.source = p_exclude_source AND e.source_id = p_exclude_source_id)
    AND EXISTS (
      SELECT 1 FROM event_artists ea
      JOIN artists a ON a.id = ea.artist_id
      WHERE ea.event_id = e.id
        AND a.slug = ANY (p_artist_slugs)
    )
  ORDER BY e.created_at ASC
  LIMIT 1;
$$;

-- Let the ingestion worker (service_role) and authenticated app call it.
-- The app won't generally need this; granting for symmetry.
GRANT EXECUTE ON FUNCTION public.find_dupe_event_by_artist(
  uuid, timestamptz, text[], text, text
) TO service_role, authenticated;

COMMENT ON FUNCTION public.find_dupe_event_by_artist IS
  'Phase 3.16. Pre-insert dedup detection: returns a single existing event at same venue + ±60 min + ≥1 shared artist slug, excluding (source, source_id) of the caller. Used by packages/ingestion/src/normalizer.ts to prevent cross-promoter RA duplicates.';
