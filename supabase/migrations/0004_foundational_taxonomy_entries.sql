-- 2a follow-up: add foundational taxonomy_map entries.
--
-- Why: Jaccard similarity on short bare tags ("house", "techno") was tying
-- against multiple N-word subgenres (e.g. "acid house" vs "afro house" both
-- scoring 0.5), picking the map-iteration winner. Giving each broad MB tag its
-- own direct row anchors the match so we don't need similarity at all for these.
--
-- Two tiers:
--   - Foundational parents: bare genre tags with real genre[]/flavor[] buckets
--   - Known-noise tags:     non-electronic tags (hip hop, pop, rock, ...) get
--     empty arrays so the resolver returns a clean "known, ignore" result
--     rather than logging to unmapped_artists.log.
--
-- Note: 'reggaeton' is intentionally NOT in the noise list — dembow-leaning
-- electronic artists (DJ Python etc.) use this tag and it's a legit Curi
-- signal. Left unmapped so it gets a proper mapping in a future curation pass.

insert into taxonomy_map (input_tag, genres, flavors) values
  -- foundational parents
  ('house',            array['house'],        array['groovy', 'club-focused']),
  ('techno',           array['techno'],       array['peak-time', 'club-focused']),
  -- 'drum and bass' already exists in the base seed; skip to avoid duplicate in VALUES
  ('bass music',       array['bass'],         array['club-focused']),
  ('garage',           array['garage'],       array['groovy']),
  ('trance',           array['trance'],       array['melodic']),
  ('experimental',     array['experimental'], array[]::text[]),
  ('breaks',           array['breaks'],       array['groovy']),
  ('breakbeats',       array['breaks'],       array['groovy']),
  ('dnb',              array['dnb'],          array['peak-time', 'club-focused']),
  ('jungle music',     array['dnb'],          array['peak-time']),
  -- known-noise
  ('electronic',       array[]::text[],       array[]::text[]),
  ('electronica',      array[]::text[],       array[]::text[]),
  ('dance',            array[]::text[],       array[]::text[]),
  ('edm',              array[]::text[],       array[]::text[]),
  ('hip hop',          array[]::text[],       array[]::text[]),
  ('hip-hop',          array[]::text[],       array[]::text[]),
  ('rap',              array[]::text[],       array[]::text[]),
  ('rnb',              array[]::text[],       array[]::text[]),
  ('r&b',              array[]::text[],       array[]::text[]),
  ('soul',             array[]::text[],       array[]::text[]),
  ('funk',             array[]::text[],       array[]::text[]),
  ('pop',              array[]::text[],       array[]::text[]),
  ('indie',            array[]::text[],       array[]::text[]),
  ('indie pop',        array[]::text[],       array[]::text[]),
  ('rock',             array[]::text[],       array[]::text[]),
  ('indie rock',       array[]::text[],       array[]::text[]),
  ('jazz',             array[]::text[],       array[]::text[]),
  ('reggae',           array[]::text[],       array[]::text[])
on conflict (input_tag) do nothing;
