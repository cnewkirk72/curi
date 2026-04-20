-- Phase 4f: capture SoundCloud + Bandcamp profile URLs and follower counts
-- for every artist.
--
-- Populated opportunistically during the Phase 4f backfill (the same Firecrawl
-- call that pulls self-tags is extended to also return follower count +
-- canonical profile URL) or via a dedicated popularity-discovery pass with a
-- name-in-slug homonym guard for artists that resolve without hitting
-- Firecrawl.
--
-- Refreshed monthly by a cron job using the stored URLs — no Exa / LLM
-- roundtrip needed after the initial capture.

ALTER TABLE artists
  ADD COLUMN IF NOT EXISTS soundcloud_url text,
  ADD COLUMN IF NOT EXISTS soundcloud_followers integer,
  ADD COLUMN IF NOT EXISTS bandcamp_url text,
  ADD COLUMN IF NOT EXISTS bandcamp_followers integer,
  ADD COLUMN IF NOT EXISTS popularity_checked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS popularity_discovery_failed_at timestamp with time zone;

-- Index the queue column for the monthly refresh:
--   SELECT ... FROM artists
--   WHERE popularity_checked_at IS NULL
--      OR popularity_checked_at < now() - interval '30 days'
--   ORDER BY popularity_checked_at ASC NULLS FIRST
--
-- NULLS FIRST so newly-inserted artists (no capture yet) surface at the top
-- of the queue.
CREATE INDEX IF NOT EXISTS idx_artists_popularity_checked_at
  ON artists (popularity_checked_at NULLS FIRST);
