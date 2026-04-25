-- Phase 3.18: genre vocabulary cleanup + remap.
--
-- The artist enrichment pipeline ingests MusicBrainz tags and Spotify
-- genres without a strict allowlist, and over time accumulated junk in
-- both `artists.genres` and (via the events-reaggregate rollup)
-- `events.genres`. This migration normalizes the vocabulary so the
-- frontend filter UI can reliably render filters that map back to real
-- data.
--
-- Three classes of change:
--
--   (1) DELETE — junk strings that aren't genres at all (descriptors,
--       country codes, identity tags, label names, typos with no
--       legitimate version, platform names). Cleaned from both tables;
--       no replacement.
--
--   (2) RENAME — known typos or non-canonical spellings get rewritten
--       in place. No parent-child semantics change.
--
--   (3) MOVE-TO-SUBGENRE — strings like 'hardcore', 'hardgroove',
--       'industrial', 'psychedelic' are real but were ingested at the
--       wrong granularity (parent-genre slot when they're actually
--       subgenres of a parent). For each: drop from `genres`, add the
--       canonical parent to `genres` if missing, and add the renamed
--       subgenre to `artists.subgenres` (events don't carry subgenres
--       directly — the feed resolves them through artists).
--
-- Audit:
--   Every affected row gets snapshotted into events_audit_backup /
--   artists_audit_backup BEFORE mutation, with category='3.18-genre-
--   cleanup' so the changeset is reversible if something looks off.
--
-- Re-aggregation:
--   This migration only touches the artists.genres / events.genres
--   data. The vibes column is unchanged (it stayed correct — the
--   problem there was UI vocabulary, not data quality). After this
--   ships, run `pnpm --filter @curi/ingestion reaggregate --apply`
--   so events.genres reflects the cleaned-up artist data, then run
--   the new derive-setting script to populate events.setting.

-- ── (0) Audit backup ───────────────────────────────────
--
-- Snapshot every affected events row into events_audit_backup. The
-- "affected" set is any event whose `genres` array contains at least
-- one of the slugs we're about to mutate. Grouped under a single
-- category so a future inverse-script can find the changeset.

with affected_event_ids as (
  select id from public.events
  where genres && array[
    -- delete list
    'rave','disc-jockeys','queer','film','poetry','ramp','spoken-word',
    'wonky','albums','alliteration','beats','brainfeeder','actor','tiktok',
    'transgender','tribute',
    -- rename list
    'synthpop','electrnica','ghettotech','noise-rock','arab','tunisia','tunisian',
    -- move-to-subgenre list
    'hardcore','hardgroove','industrial','psychedelic'
  ]::text[]
)
insert into public.events_audit_backup (original_id, original_row, category, action, notes)
select
  e.id,
  to_jsonb(e),
  '3.18-genre-cleanup',
  'mutate',
  'Pre-mutation snapshot for genre vocabulary cleanup; see migration 0018.'
from public.events e
where e.id in (select id from affected_event_ids);

with affected_artist_ids as (
  select id from public.artists
  where genres && array[
    'rave','disc-jockeys','queer','film','poetry','ramp','spoken-word',
    'wonky','albums','alliteration','beats','brainfeeder','actor','tiktok',
    'transgender','tribute',
    'synthpop','electrnica','ghettotech','noise-rock','arab','tunisia','tunisian',
    'hardcore','hardgroove','industrial','psychedelic'
  ]::text[]
)
insert into public.artists_audit_backup (original_id, original_row, category, action, notes)
select
  a.id,
  to_jsonb(a),
  '3.18-genre-cleanup',
  'mutate',
  'Pre-mutation snapshot for genre vocabulary cleanup; see migration 0018.'
from public.artists a
where a.id in (select id from affected_artist_ids);


-- ── (1) DELETE — junk slugs ──────────────────────────────────
--
-- These are not genres in any meaningful taxonomic sense. Removed
-- entirely — no replacement, no fallback. After this block, an event
-- that had ONLY junk genres ends up with an empty genres array; the
-- subsequent reaggregate run will refill it from the (cleaned) artist
-- data and venue defaults.

update public.events
  set genres = array_remove(genres, 'rave')
  where 'rave' = any(genres);
update public.events
  set genres = array_remove(genres, 'disc-jockeys')
  where 'disc-jockeys' = any(genres);
update public.events
  set genres = array_remove(genres, 'queer')
  where 'queer' = any(genres);
update public.events
  set genres = array_remove(genres, 'film')
  where 'film' = any(genres);
update public.events
  set genres = array_remove(genres, 'poetry')
  where 'poetry' = any(genres);
update public.events
  set genres = array_remove(genres, 'ramp')
  where 'ramp' = any(genres);
update public.events
  set genres = array_remove(genres, 'spoken-word')
  where 'spoken-word' = any(genres);
update public.events
  set genres = array_remove(genres, 'wonky')
  where 'wonky' = any(genres);
update public.events
  set genres = array_remove(genres, 'albums')
  where 'albums' = any(genres);
update public.events
  set genres = array_remove(genres, 'alliteration')
  where 'alliteration' = any(genres);
update public.events
  set genres = array_remove(genres, 'beats')
  where 'beats' = any(genres);
update public.events
  set genres = array_remove(genres, 'brainfeeder')
  where 'brainfeeder' = any(genres);
update public.events
  set genres = array_remove(genres, 'actor')
  where 'actor' = any(genres);
update public.events
  set genres = array_remove(genres, 'tiktok')
  where 'tiktok' = any(genres);
update public.events
  set genres = array_remove(genres, 'transgender')
  where 'transgender' = any(genres);
update public.events
  set genres = array_remove(genres, 'tribute')
  where 'tribute' = any(genres);

update public.artists
  set genres = array_remove(genres, 'rave')
  where 'rave' = any(genres);
update public.artists
  set genres = array_remove(genres, 'disc-jockeys')
  where 'disc-jockeys' = any(genres);
update public.artists
  set genres = array_remove(genres, 'queer')
  where 'queer' = any(genres);
update public.artists
  set genres = array_remove(genres, 'film')
  where 'film' = any(genres);
update public.artists
  set genres = array_remove(genres, 'poetry')
  where 'poetry' = any(genres);
update public.artists
  set genres = array_remove(genres, 'ramp')
  where 'ramp' = any(genres);
update public.artists
  set genres = array_remove(genres, 'spoken-word')
  where 'spoken-word' = any(genres);
update public.artists
  set genres = array_remove(genres, 'wonky')
  where 'wonky' = any(genres);
update public.artists
  set genres = array_remove(genres, 'albums')
  where 'albums' = any(genres);
update public.artists
  set genres = array_remove(genres, 'alliteration')
  where 'alliteration' = any(genres);
update public.artists
  set genres = array_remove(genres, 'beats')
  where 'beats' = any(genres);
update public.artists
  set genres = array_remove(genres, 'brainfeeder')
  where 'brainfeeder' = any(genres);
update public.artists
  set genres = array_remove(genres, 'actor')
  where 'actor' = any(genres);
update public.artists
  set genres = array_remove(genres, 'tiktok')
  where 'tiktok' = any(genres);
update public.artists
  set genres = array_remove(genres, 'transgender')
  where 'transgender' = any(genres);
update public.artists
  set genres = array_remove(genres, 'tribute')
  where 'tribute' = any(genres);


-- ── (2) RENAME — typos and country tags ────────────────────────────────
--
-- Each rename is two statements: add the canonical slug if not already
-- there, then remove the old slug. Two-step keeps `array_remove` from
-- creating accidental duplicates while still being a no-op on rows
-- that already have the canonical version.

-- synthpop → synth-pop
update public.events
  set genres = genres || array['synth-pop']::text[]
  where 'synthpop' = any(genres) and not ('synth-pop' = any(genres));
update public.events
  set genres = array_remove(genres, 'synthpop')
  where 'synthpop' = any(genres);
update public.artists
  set genres = genres || array['synth-pop']::text[]
  where 'synthpop' = any(genres) and not ('synth-pop' = any(genres));
update public.artists
  set genres = array_remove(genres, 'synthpop')
  where 'synthpop' = any(genres);

-- electrnica → electronic (typo)
update public.events
  set genres = genres || array['electronic']::text[]
  where 'electrnica' = any(genres) and not ('electronic' = any(genres));
update public.events
  set genres = array_remove(genres, 'electrnica')
  where 'electrnica' = any(genres);
update public.artists
  set genres = genres || array['electronic']::text[]
  where 'electrnica' = any(genres) and not ('electronic' = any(genres));
update public.artists
  set genres = array_remove(genres, 'electrnica')
  where 'electrnica' = any(genres);

-- ghettotech → ghetto-tech
update public.events
  set genres = genres || array['ghetto-tech']::text[]
  where 'ghettotech' = any(genres) and not ('ghetto-tech' = any(genres));
update public.events
  set genres = array_remove(genres, 'ghettotech')
  where 'ghettotech' = any(genres);
update public.artists
  set genres = genres || array['ghetto-tech']::text[]
  where 'ghettotech' = any(genres) and not ('ghetto-tech' = any(genres));
update public.artists
  set genres = array_remove(genres, 'ghettotech')
  where 'ghettotech' = any(genres);

-- noise-rock → noise (rolled into experimental parent on subgenre side later)
update public.events
  set genres = genres || array['noise']::text[]
  where 'noise-rock' = any(genres) and not ('noise' = any(genres));
update public.events
  set genres = array_remove(genres, 'noise-rock')
  where 'noise-rock' = any(genres);
update public.artists
  set genres = genres || array['noise']::text[]
  where 'noise-rock' = any(genres) and not ('noise' = any(genres));
update public.artists
  set genres = array_remove(genres, 'noise-rock')
  where 'noise-rock' = any(genres);

-- arab / tunisia / tunisian → world
update public.events
  set genres = genres || array['world']::text[]
  where (genres && array['arab','tunisia','tunisian']::text[])
    and not ('world' = any(genres));
update public.events
  set genres = array_remove(array_remove(array_remove(genres, 'arab'), 'tunisia'), 'tunisian')
  where genres && array['arab','tunisia','tunisian']::text[];
update public.artists
  set genres = genres || array['world']::text[]
  where (genres && array['arab','tunisia','tunisian']::text[])
    and not ('world' = any(genres));
update public.artists
  set genres = array_remove(array_remove(array_remove(genres, 'arab'), 'tunisia'), 'tunisian')
  where genres && array['arab','tunisia','tunisian']::text[];


-- ── (3) MOVE-TO-SUBGENRE — wrong-granularity tags ────────────────────
--
-- For each: ensure the parent genre is present on the artist, add the
-- canonical subgenre to artists.subgenres, then strip the old slug
-- from artists.genres. Events are handled the same way at the genre
-- level (parent added if missing, old slug removed). Subgenres only
-- live on artists; the events.genres-level move is just "delete and
-- promote to parent".
--
-- Note: events don't carry subgenres directly. The new artist
-- subgenre will surface to the feed via the existing
-- artists → event_artists → events lookup that the subgenre filter
-- already uses.

-- hardcore → techno parent + hardcore-techno subgenre
update public.artists
  set subgenres = coalesce(subgenres, array[]::text[]) || array['hardcore-techno']::text[]
  where 'hardcore' = any(genres)
    and not ('hardcore-techno' = any(coalesce(subgenres, array[]::text[])));
update public.artists
  set genres = genres || array['techno']::text[]
  where 'hardcore' = any(genres) and not ('techno' = any(genres));
update public.artists
  set genres = array_remove(genres, 'hardcore')
  where 'hardcore' = any(genres);
update public.events
  set genres = genres || array['techno']::text[]
  where 'hardcore' = any(genres) and not ('techno' = any(genres));
update public.events
  set genres = array_remove(genres, 'hardcore')
  where 'hardcore' = any(genres);

-- hardgroove → techno parent + hardgroove-techno subgenre (canonical
-- vocabulary already has 'hardgroove techno' for some artists; we
-- normalize to hyphenated form for new entries here).
update public.artists
  set subgenres = coalesce(subgenres, array[]::text[]) || array['hardgroove techno']::text[]
  where 'hardgroove' = any(genres)
    and not ('hardgroove techno' = any(coalesce(subgenres, array[]::text[])));
update public.artists
  set genres = genres || array['techno']::text[]
  where 'hardgroove' = any(genres) and not ('techno' = any(genres));
update public.artists
  set genres = array_remove(genres, 'hardgroove')
  where 'hardgroove' = any(genres);
update public.events
  set genres = genres || array['techno']::text[]
  where 'hardgroove' = any(genres) and not ('techno' = any(genres));
update public.events
  set genres = array_remove(genres, 'hardgroove')
  where 'hardgroove' = any(genres);

-- industrial → techno parent + industrial subgenre. Industrial-techno
-- is a recognized subgenre; for non-techno-leaning industrial acts the
-- existing artists.subgenres entry preserves the signal even after
-- their genre is widened to 'techno'. (Audit table preserves the
-- original for any post-hoc reclassification.)
update public.artists
  set subgenres = coalesce(subgenres, array[]::text[]) || array['industrial']::text[]
  where 'industrial' = any(genres)
    and not ('industrial' = any(coalesce(subgenres, array[]::text[])));
update public.artists
  set genres = genres || array['techno']::text[]
  where 'industrial' = any(genres) and not ('techno' = any(genres));
update public.artists
  set genres = array_remove(genres, 'industrial')
  where 'industrial' = any(genres);
update public.events
  set genres = genres || array['techno']::text[]
  where 'industrial' = any(genres) and not ('techno' = any(genres));
update public.events
  set genres = array_remove(genres, 'industrial')
  where 'industrial' = any(genres);

-- psychedelic → rock parent + psychedelic-rock subgenre
update public.artists
  set subgenres = coalesce(subgenres, array[]::text[]) || array['psychedelic-rock']::text[]
  where 'psychedelic' = any(genres)
    and not ('psychedelic-rock' = any(coalesce(subgenres, array[]::text[])));
update public.artists
  set genres = genres || array['rock']::text[]
  where 'psychedelic' = any(genres) and not ('rock' = any(genres));
update public.artists
  set genres = array_remove(genres, 'psychedelic')
  where 'psychedelic' = any(genres);
update public.events
  set genres = genres || array['rock']::text[]
  where 'psychedelic' = any(genres) and not ('rock' = any(genres));
update public.events
  set genres = array_remove(genres, 'psychedelic')
  where 'psychedelic' = any(genres);
