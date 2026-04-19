-- 0007_venue_defaults.sql
--
-- Venue default tags (genre + flavor) — used by the ingestion normalizer as
-- a fallback rollup signal when every other layer (RA-curated event tags,
-- per-artist MB tags) came back empty. See normalizer.ts `rollup()` for the
-- weighting rules (venue defaults only apply when no higher-priority signal
-- produced any tags — so a Nowadays "house/techno" default never overrides
-- a one-off country night the venue is actually hosting).
--
-- Why the fallback layer exists:
--   In Phase 3.15 we discovered 410/548 MBID-matched artists have zero tags
--   on MusicBrainz. At known-identity rooms (Nowadays, Public Records) that
--   meant events rendered untagged in the feed even though the room's
--   entire programming is one or two genres. Seeding a venue default gives
--   us a reasonable floor without depending on the MB community's coverage
--   of NYC's electronic scene.
--
-- Slug values validated against public.venues as of 2026-04-19. Genre/flavor
-- values restricted to tags currently present in public.taxonomy_map.
-- Venues with broad/varied programming (Knockdown Center, Webster Hall,
-- Brooklyn Steel, House of Yes) are intentionally left null — over-tagging
-- them would hide legitimate one-off nights.

alter table public.venues
  add column if not exists default_genres text[],
  add column if not exists default_flavors text[];

comment on column public.venues.default_genres is
  'Fallback genre slugs applied by the ingestion normalizer when no other rollup signal (RA event tags, per-artist MB tags) produced any genres. Keep short (1–3 entries) — this is the venue''s house identity, not a wish list.';

comment on column public.venues.default_flavors is
  'Same fallback semantics as default_genres but for flavor/vibe tags (e.g. club-focused, warehouse, underground, queer).';

-- Seed block. Only venues with a narrow, well-known identity and meaningful
-- upcoming event volume. Edit rule: if a venue's booking widens, clear its
-- defaults rather than fighting the rollup.

-- Public Records (Gowanus hi-fi soundsystem, house/techno + listening-room)
update public.venues set
  default_genres  = array['house','techno'],
  default_flavors = array['club-focused','underground']
where slug = 'public-records';

-- Nowadays (Ridgewood indoor/outdoor dance club — house, techno, daytime)
update public.venues set
  default_genres  = array['house','techno'],
  default_flavors = array['club-focused','daytime']
where slug = 'nowadays';

-- Bossa Nova Civic Club (Bushwick underground dance)
update public.venues set
  default_genres  = array['house','techno'],
  default_flavors = array['club-focused','underground']
where slug = 'bossa-nova-civic-club';

-- Jupiter Disco (Bushwick electronic dance bar)
update public.venues set
  default_genres  = array['house','techno'],
  default_flavors = array['club-focused']
where slug = 'jupiter-disco';

-- Good Room (Greenpoint — house/techno club)
update public.venues set
  default_genres  = array['house','techno'],
  default_flavors = array['club-focused']
where slug = 'good-room';

-- H0L0 (Ridgewood experimental/electronic)
update public.venues set
  default_genres  = array['techno','experimental'],
  default_flavors = array['underground','warehouse']
where slug = 'h0l0';

-- Paragon (new Brooklyn warehouse-style techno)
update public.venues set
  default_genres  = array['techno','house'],
  default_flavors = array['warehouse','peak-time']
where slug = 'paragon';

-- Basement (techno club under Knockdown Center — distinct identity from
-- the parent venue, which is too broad to default)
update public.venues set
  default_genres  = array['techno','house'],
  default_flavors = array['peak-time','warehouse']
where slug = 'basement';

-- The Brooklyn Monarch (Bushwick warehouse)
update public.venues set
  default_genres  = array['techno','house'],
  default_flavors = array['warehouse','peak-time']
where slug = 'the-brooklyn-monarch';

-- Mood Ring (Bushwick queer dance bar — broadly dance-pop, queer flavor)
update public.venues set
  default_genres  = array['house','pop'],
  default_flavors = array['queer','club-focused']
where slug = 'mood-ring';

-- 3 Dollar Bill (Bushwick queer dance + concert venue)
update public.venues set
  default_genres  = array['house','pop'],
  default_flavors = array['queer','club-focused']
where slug = '3-dollar-bill';

-- Market Hotel (DIY indie/rock loft)
update public.venues set
  default_genres  = array['indie','rock'],
  default_flavors = array['underground']
where slug = 'market-hotel';

-- Moondog Hifi (hi-fi listening bar — club-focused vinyl culture)
update public.venues set
  default_genres  = array['house','electronic'],
  default_flavors = array['club-focused']
where slug = 'moondog-hifi';
