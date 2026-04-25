-- Phase 4f.1: SoundCloud + Bandcamp profile image fallback for artist
-- avatars.
--
-- Today the lineup avatar in apps/web sources `image_url` exclusively
-- from `artists.spotify_image_url` (see apps/web/src/lib/events.ts).
-- 1163/1863 artists (62%) don't have a Spotify image — Spotify either
-- never matched, or stripped the image field after the Nov 2024 API
-- policy change. About half of those (592) DO have a SoundCloud or
-- Bandcamp URL we already discovered, and both platforms expose the
-- artist avatar via og:image on the profile page.
--
-- Adding two nullable columns lets the projection layer cascade:
--   spotify_image_url ?? soundcloud_image_url ?? bandcamp_image_url
--
-- Two columns rather than a single `external_image_url` so the
-- projection is explicit about source ordering, and so a future
-- per-source policy change (e.g. drop one platform if its ToS shifts)
-- can be expressed without re-deriving which CDN a stored URL came
-- from.
--
-- Capture path: the existing fetchArtistSelfTags Firecrawl scrape
-- already opens the profile page for tag/follower extraction.
-- Extending its extract schema with `imageUrl` adds zero incremental
-- API cost — Firecrawl bills by scrape, not by extracted-field count.
-- Going forward all enrichment paths (LLM tier-3, popularity
-- discovery, monthly refresh cron) capture profile images
-- automatically; no separate flag needed.
--
-- No index — these columns are read only via the artists join in the
-- lineup projection, which already drives off the artist PK.

alter table public.artists
  add column if not exists soundcloud_image_url text,
  add column if not exists bandcamp_image_url text;

comment on column public.artists.soundcloud_image_url is
  'Optional SoundCloud profile avatar URL captured from og:image during Firecrawl self-tag scrape. Hot-linked from i1.sndcdn.com — used as a fallback when spotify_image_url is null.';

comment on column public.artists.bandcamp_image_url is
  'Optional Bandcamp profile avatar URL captured from og:image during Firecrawl self-tag scrape. Hot-linked from f4.bcbits.com — used as a fallback when both spotify_image_url and soundcloud_image_url are null.';
