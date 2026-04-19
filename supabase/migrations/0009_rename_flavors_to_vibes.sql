-- Phase 4a: rename "flavors" columns to "vibes" for product-vocabulary
-- alignment. Six columns across six tables. No data copy required.
--
-- Already applied to the live Supabase project (gnglasgrlgervpgqwrvj) via
-- the Supabase MCP on 2026-04-19, recorded with name
-- "0006_rename_flavors_to_vibes" (the repo-local file is numbered 0009
-- because the repo was already at 0008 when we applied it — DB migrations
-- are keyed by timestamp, not filename, so the version is stable either way).
--
-- Verified: no views / indexes / functions / policies reference any of the
-- renamed columns, so ALTER TABLE ... RENAME COLUMN is safe to run in a
-- single transaction.

begin;

alter table public.artists             rename column flavors           to vibes;
alter table public.events              rename column flavors           to vibes;
alter table public.taxonomy_map        rename column flavors           to vibes;
alter table public.taxonomy_subgenres  rename column flavors           to vibes;
alter table public.user_prefs          rename column preferred_flavors to preferred_vibes;
alter table public.venues              rename column default_flavors   to default_vibes;

commit;
