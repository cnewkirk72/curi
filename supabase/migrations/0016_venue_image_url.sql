-- Phase 3.17: venue image_url fallback.
--
-- The feed card renders a hero image at the top of each event card.
-- Ingestion populates `events.image_url` when the source (RA / EB /
-- promoter page) provides one, but ~13% of upcoming events have no
-- hero. The card falls back to a deterministic genre-colored gradient
-- in that case — functional, but visually flat when you scroll past
-- many in a row.
--
-- The fallback chain we want (see apps/web/src/components/event-card.tsx):
--   1. event.image_url                 — the ingested hero, if any
--   2. headliner artist Spotify avatar — already in lineup projection
--   3. any lineup artist Spotify avatar
--   4. venue.image_url                 — new, added here
--   5. gradient placeholder            — ultimate fallback
--
-- Step 4 needs a venues column. Nullable text — we'll backfill the
-- handful of venues that actually need it in a subsequent data-only
-- change (not in this migration so the schema move can ship cleanly
-- and the backfill is auditable separately).
--
-- We don't add an index: this column is only read via the venue join
-- on the feed query, and the join already drives off `venue_id` (PK).

alter table public.venues
  add column if not exists image_url text;

comment on column public.venues.image_url is
  'Optional external CDN URL for a high-quality photo of the venue. Used as a hero-image fallback on the feed card when the event itself has no image and the lineup has no Spotify avatars. No next/image optimization — raw <img> until Phase 3.7 ships the remotePatterns allowlist.';
