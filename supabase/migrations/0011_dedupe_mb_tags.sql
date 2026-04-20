-- One-time cleanup: collapse duplicate entries within artists.mb_tags.
--
-- Prior MusicBrainz ingestion occasionally wrote the same tag name multiple
-- times into a single artist's mb_tags jsonb array
-- (e.g. [{"name":"house","count":3},{"name":"house","count":1}]).
-- 219 of 235 tagged rows (93%) were affected at the time this migration was
-- authored.
--
-- Phase 4f uses mb_tags as Sonnet context for tier-1 artists, so duplicates
-- dilute the signal. This collapses to one entry per tag name with counts
-- summed, preserving frequency-descending order so the most-tagged genre
-- surfaces first in the prompt.
--
-- Safe to re-run: the aggregate is a no-op on already-unique arrays.

UPDATE artists
SET mb_tags = (
  SELECT jsonb_agg(
           jsonb_build_object('name', t.name, 'count', t.total)
           ORDER BY t.total DESC, t.name
         )
  FROM (
    SELECT elem->>'name' AS name,
           SUM(COALESCE((elem->>'count')::int, 1)) AS total
    FROM jsonb_array_elements(artists.mb_tags) elem
    WHERE elem->>'name' IS NOT NULL
      AND length(trim(elem->>'name')) > 0
    GROUP BY elem->>'name'
  ) t
)
WHERE mb_tags IS NOT NULL
  AND jsonb_typeof(mb_tags) = 'array'
  AND jsonb_array_length(mb_tags) > 0;
