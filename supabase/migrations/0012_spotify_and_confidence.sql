-- Phase 4f.8: Spotify enrichment capture, normalized confidence tier,
-- and reversible audit backup tables used by audit-cleanup.ts.

-- ── artists: Spotify columns + confidence ────────────────────────
ALTER TABLE public.artists
  ADD COLUMN IF NOT EXISTS spotify_id                   text,
  ADD COLUMN IF NOT EXISTS spotify_url                  text,
  ADD COLUMN IF NOT EXISTS spotify_followers            integer,
  ADD COLUMN IF NOT EXISTS spotify_popularity           integer,
  ADD COLUMN IF NOT EXISTS spotify_image_url            text,
  ADD COLUMN IF NOT EXISTS spotify_checked_at           timestamptz,
  ADD COLUMN IF NOT EXISTS spotify_discovery_failed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS enrichment_confidence        text;

COMMENT ON COLUMN public.artists.enrichment_confidence IS
  'One of: high | medium | low | very-low. Enforced at app level so new tiers do not need a migration. very-low = stall-fallback; UI suppresses these from event aggregation + chip rendering.';

-- Monthly Spotify refresh queue index.
CREATE INDEX IF NOT EXISTS idx_artists_spotify_checked_at
  ON public.artists (spotify_checked_at NULLS FIRST);

-- Fast filter for UI read-side (suppress very-low rollups).
CREATE INDEX IF NOT EXISTS idx_artists_enrichment_confidence
  ON public.artists (enrichment_confidence);

-- ── artists_audit_backup ────────────────────────────────────
-- Reversible paper trail for every destructive / mutating op done by
-- audit-cleanup.ts --apply. One row per operation. Kept forever until
-- manually pruned.
CREATE TABLE IF NOT EXISTS public.artists_audit_backup (
  id           bigserial PRIMARY KEY,
  original_id  uuid NOT NULL,
  original_row jsonb NOT NULL,
  category     text NOT NULL,     -- audit category name
  action       text NOT NULL,     -- 'delete' | 'merge_loser' | 'rename' | 'reset_enrichment'
  applied_at   timestamptz NOT NULL DEFAULT now(),
  notes        text
);

CREATE INDEX IF NOT EXISTS idx_artists_audit_backup_applied_at
  ON public.artists_audit_backup (applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_artists_audit_backup_original_id
  ON public.artists_audit_backup (original_id);

ALTER TABLE public.artists_audit_backup ENABLE ROW LEVEL SECURITY;
-- No policies. Service-role only writes/reads; bypasses RLS.

-- ── events_audit_backup ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.events_audit_backup (
  id           bigserial PRIMARY KEY,
  original_id  uuid NOT NULL,
  original_row jsonb NOT NULL,
  category     text NOT NULL,
  action       text NOT NULL,     -- 'delete' | 'merge_loser'
  applied_at   timestamptz NOT NULL DEFAULT now(),
  notes        text
);

CREATE INDEX IF NOT EXISTS idx_events_audit_backup_applied_at
  ON public.events_audit_backup (applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_audit_backup_original_id
  ON public.events_audit_backup (original_id);

ALTER TABLE public.events_audit_backup ENABLE ROW LEVEL SECURITY;
