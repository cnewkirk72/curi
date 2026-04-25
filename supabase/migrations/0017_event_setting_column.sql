-- Phase 3.18: events.setting column for the new Setting filter dimension.
--
-- Until now the filter taxonomy was: genre + vibe + subgenre. Vibes were
-- meant to capture "the feel of the night" (warehouse, peak-time,
-- basement, daytime, queer, underground), but the artist-enrichment
-- pipeline was explicitly told NOT to generate those (see
-- packages/ingestion/src/llm-enrichment.ts:177-178). So `events.vibes`
-- ended up populated entirely with artist-level musical-character
-- descriptors (groovy, hypnotic, dark, soulful, driving, ...) — which
-- meant the original "Vibe" filter had a vocabulary the data was
-- instructed never to produce.
--
-- The fix splits the concept in two:
--
--   `events.vibes`   — keeps the artist-mood vocabulary the LLM
--                       already produces (groovy/hypnotic/dark/...).
--                       Filter UI calls this "Vibe" and treats it as
--                       a taste signal that personalizes ordering.
--
--   `events.setting` — NEW, this column. Event-context tags derived
--                       deterministically (no LLM): warehouse, basement,
--                       outdoor, daytime, peak-time, late-night,
--                       underground. Populated by
--                       packages/ingestion/src/derive-setting.ts from
--                       venue type + start_at + lineup follower totals.
--
-- Why a separate column rather than overloading vibes: the two
-- dimensions are produced by entirely different pipelines (LLM-tagged
-- vs deterministic), have different update cadences (vibes change with
-- artist re-enrichment, setting changes only with venue/time edits),
-- and serve different user intents (sound vs scene). Keeping them
-- in one column would force every consumer to know the bucket map.
--
-- GIN index because the home feed filters with `setting && array[...]`
-- (PostgREST .overlaps()), the same access pattern as events.genres /
-- events.vibes which already have GIN indexes.

alter table public.events
  add column if not exists setting text[];

create index if not exists events_setting_gin
  on public.events using gin (setting);

comment on column public.events.setting is
  'Phase 3.18: derived event-context tags from a fixed vocabulary: warehouse, basement, outdoor, daytime, peak-time, late-night, underground. Populated by packages/ingestion/src/derive-setting.ts (deterministic — venue + start_at + lineup follower totals). Distinct from events.vibes (artist-level mood, LLM-tagged).';
