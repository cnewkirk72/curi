-- ─────────────────────────────────────────────────────────────────────────────
-- Curi — Phase 1 seed: NYC electronic venues + MusicBrainz taxonomy mappings.
-- Idempotent (on conflict do nothing) so it's safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── VENUES ────────────────────────────────────────────────────────────────────────
-- lat/lng intentionally omitted here — we'll fill from scrapers when available.
-- Neighborhoods and websites verified to best available knowledge; any marked
-- with a ⚠ comment should be double-checked before first ingestion run.
insert into public.venues (name, slug, neighborhood, website) values
  ('Public Records',             'public-records',    'Gowanus, Brooklyn',           'https://publicrecords.nyc'),
  ('Nowadays',                   'nowadays',          'Ridgewood, Queens',           'https://nowadays.nyc'),
  ('Basement',                   'basement',          'Maspeth, Queens',             'https://www.basement-ny.com'),
  ('Knockdown Center',           'knockdown-center',  'Maspeth, Queens',             'https://knockdown.center'),
  ('Elsewhere',                  'elsewhere',         'Bushwick, Brooklyn',          'https://www.elsewherebrooklyn.com'),
  ('Good Room',                  'good-room',         'Greenpoint, Brooklyn',        'https://goodroombk.com'),
  ('Bossa Nova Civic Club',      'bossa-nova-civic-club', 'Bushwick, Brooklyn',      'https://www.bossanovacivicclub.nyc'),
  ('House of Yes',               'house-of-yes',      'Bushwick, Brooklyn',          'https://houseofyes.org'),
  ('The Sultan Room',            'sultan-room',       'Bushwick, Brooklyn',          'https://www.thesultanroom.com'),
  ('3 Dollar Bill',              '3-dollar-bill',     'East Williamsburg, Brooklyn', 'https://www.3dollarbillbk.com'),
  ('TBA Brooklyn',               'tba-brooklyn',      'East Williamsburg, Brooklyn', 'https://tbabrooklyn.com'),
  ('Market Hotel',               'market-hotel',      'Bushwick, Brooklyn',          'https://markethotel.org')
on conflict (slug) do nothing;

-- ── TAXONOMY MAP ────────────────────────────────────────────────────────────────────────
-- Maps common MusicBrainz tags → Curi genres[] + flavors[].
insert into public.taxonomy_map (input_tag, genres, flavors) values
  -- drum & bass family
  ('liquid funk',         array['dnb'],                array['melodic','groovy']),
  ('neurofunk',           array['dnb'],                array['wubby','club-focused']),
  ('jungle',              array['dnb'],                array['organic','underground']),
  ('drum and bass',       array['dnb'],                array['club-focused']),
  ('jump up',             array['dnb'],                array['wubby','peak-time']),

  -- house family
  ('deep house',          array['house'],              array['groovy','introspective']),
  ('microhouse',          array['house'],              array['sleek','introspective']),
  ('tech house',          array['house','techno'],     array['groovy','club-focused']),
  ('acid house',          array['house'],              array['groovy','peak-time']),
  ('disco house',         array['house'],              array['groovy','crossover-friendly']),
  ('nu-disco',            array['house'],              array['groovy','crossover-friendly']),
  ('afro house',          array['house'],              array['organic','groovy']),
  ('amapiano',            array['house'],              array['organic','groovy']),

  -- techno family
  ('minimal techno',      array['techno'],             array['sleek','underground']),
  ('peak time techno',    array['techno'],             array['peak-time','club-focused']),
  ('hard techno',         array['techno'],             array['peak-time','warehouse']),
  ('dub techno',          array['techno'],             array['ethereal','introspective']),
  ('detroit techno',      array['techno'],             array['groovy','underground']),
  ('industrial techno',   array['techno'],             array['warehouse','peak-time']),
  ('ambient techno',      array['techno'],             array['ethereal','introspective']),
  ('hardgroove',          array['hardgroove','techno'],array['groovy','peak-time']),

  -- bass / dubstep / grime
  ('dubstep',             array['bass'],               array['wubby','club-focused']),
  ('grime',               array['bass'],               array['club-focused','underground']),
  ('bassline',            array['bass','garage'],      array['wubby','club-focused']),

  -- garage
  ('uk garage',           array['garage'],             array['groovy','crossover-friendly']),
  ('2-step',              array['garage'],             array['groovy','crossover-friendly']),
  ('speed garage',        array['garage'],             array['groovy','peak-time']),

  -- breaks / club
  ('breakbeat',           array['breaks'],             array['groovy','club-focused']),
  ('big beat',            array['breaks'],             array['crossover-friendly','peak-time']),
  ('footwork',            array['breaks','experimental'], array['club-focused','underground']),
  ('juke',                array['breaks'],             array['club-focused','underground']),
  ('jersey club',         array['breaks'],             array['queer','peak-time']),
  ('baltimore club',      array['breaks'],             array['queer','peak-time']),

  -- trance
  ('psytrance',           array['trance'],             array['peak-time','club-focused']),
  ('progressive trance',  array['trance'],             array['melodic','peak-time']),
  ('goa trance',          array['trance'],             array['peak-time','organic']),

  -- electro
  ('electro',             array['electro'],            array['sleek','club-focused']),
  ('electroclash',        array['electro'],            array['queer','peak-time']),
  ('synthwave',           array['electro'],            array['cinematic','crossover-friendly']),

  -- experimental / ambient
  ('idm',                 array['experimental'],       array['introspective','ethereal']),
  ('ambient',             array['ambient'],            array['ethereal','introspective']),
  ('drone',               array['ambient','experimental'], array['ethereal','introspective']),
  ('dark ambient',        array['ambient'],            array['cinematic','introspective']),
  ('downtempo',           array['ambient'],            array['introspective','daytime']),
  ('trip hop',            array['experimental'],       array['cinematic','introspective']),
  ('ballroom',            array['experimental'],       array['queer','peak-time']),
  ('gqom',                array['experimental','bass'],array['underground','club-focused']),

  -- foundational parents: bare genre tags so Jaccard doesn't tie-break
  -- arbitrarily between N-word subgenres when MB returns a plain "house" or
  -- "techno" tag.
  ('house',               array['house'],              array['groovy','club-focused']),
  ('techno',              array['techno'],             array['peak-time','club-focused']),
  -- 'drum and bass' already seeded above in the DNB family block
  ('dnb',                 array['dnb'],                array['peak-time','club-focused']),
  ('jungle music',        array['dnb'],                array['peak-time']),
  ('bass music',          array['bass'],               array['club-focused']),
  ('garage',              array['garage'],             array['groovy']),
  ('trance',              array['trance'],             array['melodic']),
  ('experimental',        array['experimental'],       array[]::text[]),
  ('breaks',              array['breaks'],             array['groovy']),
  ('breakbeats',          array['breaks'],             array['groovy']),

  -- known-noise tags: MB frequently returns these on electronic artists
  -- (Yaeji tagged 'hip hop', DJ Python tagged 'reggaeton', etc). Empty arrays
  -- = "recognized, ignored" — short-circuits before similarity match and
  -- keeps the unmapped log clean.
  ('electronic',          array[]::text[],             array[]::text[]),
  ('electronica',         array[]::text[],             array[]::text[]),
  ('dance',               array[]::text[],             array[]::text[]),
  ('edm',                 array[]::text[],             array[]::text[]),
  ('hip hop',             array[]::text[],             array[]::text[]),
  ('hip-hop',             array[]::text[],             array[]::text[]),
  ('rap',                 array[]::text[],             array[]::text[]),
  ('rnb',                 array[]::text[],             array[]::text[]),
  ('r&b',                 array[]::text[],             array[]::text[]),
  ('soul',                array[]::text[],             array[]::text[]),
  ('funk',                array[]::text[],             array[]::text[]),
  ('pop',                 array[]::text[],             array[]::text[]),
  ('indie',               array[]::text[],             array[]::text[]),
  ('indie pop',           array[]::text[],             array[]::text[]),
  ('rock',                array[]::text[],             array[]::text[]),
  ('indie rock',          array[]::text[],             array[]::text[]),
  ('jazz',                array[]::text[],             array[]::text[]),
  ('reggae',              array[]::text[],             array[]::text[])
  -- NB: intentionally not adding 'reggaeton' as noise — dembow-leaning
  -- electronic artists (DJ Python etc.) use this tag and it's a legit Curi
  -- signal. Leaving it to the unmapped log so it gets a proper mapping later.
on conflict (input_tag) do nothing;
