-- Phase 3.15b: Expand taxonomy beyond electronic-focused origin.
--
-- Why: After the 4/19 cron run, 855 artists got MB IDs but only 136 ended up
-- with non-empty genres[]. Root cause: the "known-noise" rows added in 0004
-- (hip hop, rock, pop, jazz, soul, funk, rnb, etc.) map to empty arrays, so
-- artists with those MB tags get enriched but dropped from rollup. Christian's
-- direction: Curi should be NYC-wide, not electronic-only — populate the noise
-- rows and add missing parent genres so no data gets lost.
--
-- Seed priorities driven by MB tag frequency across 855 MBID artists:
--   weighted_score = sum(mb tag count) across all artists that have the tag.
--   Top entries included here with weighted_score >= 15.
--
-- Works in tandem with the runtime smart-add logic in taxonomy.ts which will
-- now auto-create new taxonomy_map top-level entries for tags that don't fit
-- any existing parent (Jaccard < 0.3) — e.g. "bolero" → creates a bolero
-- parent genre, subsequent "cuban bolero" auto-creates as subgenre.

-- ── 1. Populate previously-empty "noise" rows with genre mappings ─────────────

update public.taxonomy_map set genres = array['electronic'],        flavors = array[]::text[] where input_tag = 'electronic';
update public.taxonomy_map set genres = array['electronic'],        flavors = array[]::text[] where input_tag = 'electronica';
update public.taxonomy_map set genres = array['electronic'],        flavors = array['peak-time'] where input_tag = 'edm';
update public.taxonomy_map set genres = array[]::text[],            flavors = array['groovy', 'crossover-friendly'] where input_tag = 'dance';
update public.taxonomy_map set genres = array['hip-hop'],           flavors = array[]::text[] where input_tag = 'hip hop';
update public.taxonomy_map set genres = array['hip-hop'],           flavors = array[]::text[] where input_tag = 'hip-hop';
update public.taxonomy_map set genres = array['hip-hop'],           flavors = array[]::text[] where input_tag = 'rap';
update public.taxonomy_map set genres = array['r&b', 'soul'],       flavors = array[]::text[] where input_tag = 'r&b';
update public.taxonomy_map set genres = array['r&b', 'soul'],       flavors = array[]::text[] where input_tag = 'rnb';
update public.taxonomy_map set genres = array['soul', 'r&b'],       flavors = array[]::text[] where input_tag = 'soul';
update public.taxonomy_map set genres = array['funk'],              flavors = array['groovy'] where input_tag = 'funk';
update public.taxonomy_map set genres = array['pop'],               flavors = array[]::text[] where input_tag = 'pop';
update public.taxonomy_map set genres = array['rock'],              flavors = array[]::text[] where input_tag = 'rock';
update public.taxonomy_map set genres = array['indie'],             flavors = array[]::text[] where input_tag = 'indie';
update public.taxonomy_map set genres = array['indie', 'rock'],     flavors = array[]::text[] where input_tag = 'indie rock';
update public.taxonomy_map set genres = array['indie', 'pop'],      flavors = array[]::text[] where input_tag = 'indie pop';
update public.taxonomy_map set genres = array['jazz'],              flavors = array[]::text[] where input_tag = 'jazz';
update public.taxonomy_map set genres = array['reggae'],            flavors = array[]::text[] where input_tag = 'reggae';

-- ── 2. Add missing parent genres & common variants (ordered by MB frequency) ──

insert into public.taxonomy_map (input_tag, genres, flavors) values
  -- Rock / alt / punk family
  ('alternative rock',   array['rock', 'indie'],       array[]::text[]),
  ('pop rock',           array['rock', 'pop'],         array[]::text[]),
  ('indie pop rock',     array['indie', 'rock', 'pop'], array[]::text[]),
  ('gothic rock',        array['rock'],                array['cinematic']),
  ('shoegaze',           array['indie', 'rock'],       array['ethereal', 'introspective']),
  ('dream pop',          array['indie', 'pop'],        array['ethereal', 'introspective']),
  ('post-punk',          array['punk', 'indie'],       array[]::text[]),
  ('pop punk',           array['punk', 'pop'],         array[]::text[]),
  ('punk',               array['punk'],                array[]::text[]),
  ('southern rock',      array['rock'],                array[]::text[]),

  -- Metal family
  ('metal',              array['metal'],               array['warehouse']),
  ('alternative metal',  array['metal'],               array[]::text[]),
  ('doom metal',         array['metal'],               array['warehouse', 'cinematic']),
  ('sludge metal',       array['metal'],               array['warehouse']),
  ('drone metal',        array['metal', 'experimental'], array['warehouse', 'ethereal']),
  ('funk metal',         array['metal', 'funk'],       array['groovy']),

  -- Jazz / classical / folk / singer-songwriter
  ('vocal jazz',         array['jazz'],                array[]::text[]),
  ('classical',          array['classical'],           array['introspective']),
  ('folk',               array['folk'],                array['introspective']),
  ('country',            array['country'],             array[]::text[]),
  ('singer-songwriter',  array['indie', 'folk'],       array['introspective']),
  ('swing',              array['jazz'],                array['groovy']),
  ('traditional pop',    array['pop'],                 array[]::text[]),
  ('dance-pop',          array['pop', 'electronic'],   array['groovy', 'crossover-friendly']),
  ('dance pop',          array['pop', 'electronic'],   array['groovy', 'crossover-friendly']),

  -- Latin family (common in NYC)
  ('latin',              array['latin'],               array[]::text[]),
  ('salsa',              array['latin'],               array['groovy']),
  ('bolero',             array['latin'],               array['introspective']),
  ('cumbia',             array['latin'],               array['groovy']),
  ('reggaeton',          array['latin', 'hip-hop'],    array['peak-time']),
  ('bossa nova',         array['latin', 'jazz'],       array['introspective']),
  ('afrobeats',          array['world'],               array['groovy']),

  -- Electronic subgenres missed by existing map
  ('melodic techno',     array['techno'],              array['melodic', 'peak-time']),
  ('melodic house',      array['house'],               array['melodic', 'groovy']),
  ('progressive house',  array['house'],               array['melodic', 'peak-time']),
  ('progressive trance', array['trance'],              array['melodic', 'peak-time']),
  ('indietronica',       array['indie', 'electronic'], array[]::text[]),
  ('glitch',             array['experimental', 'electronic'], array['ethereal']),
  ('industrial',         array['industrial'],          array['warehouse']),
  ('industrial rock',    array['industrial', 'rock'],  array['warehouse']),
  ('experimental hip hop', array['hip-hop', 'experimental'], array[]::text[]),
  ('noise',              array['experimental'],        array['warehouse']),
  ('plunderphonics',     array['experimental'],        array['ethereal']),
  ('club',               array[]::text[],              array['club-focused', 'peak-time'])
on conflict (input_tag) do nothing;

-- ── 3. After this, re-run the artist enrichment rollup.
-- The normalizer will hit these taxonomy_map entries on the next cron cycle
-- (or we can force-refresh by nulling last_enriched_at on affected artists).
