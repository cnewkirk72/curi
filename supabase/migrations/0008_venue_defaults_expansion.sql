-- 0008_venue_defaults_expansion.sql
--
-- Expand the venue defaults seed introduced in 0007. After the first Railway
-- cron run on the Phase 3.16 code, 129 upcoming events were still untagged.
-- The dominant clusters were at rooms we had intentionally left null in 0007
-- ("broad programming") but which, in practice, have a narrow enough booking
-- rhythm to justify a floor. This migration adds 7 more venues. See
-- normalizer.ts `rollup()` for the fallback semantics: defaults only apply
-- when the higher-priority layers produced zero signal in the given
-- dimension (genre or flavor), so a one-off indie night at Elsewhere still
-- wins over the default when RA tags the event as "Indie".
--
-- Seed rationale (per venue):
--   elsewhere            — Bushwick, indie/electronic variety with strong
--                          underground identity. Biggest untagged cluster
--                          (21 events) after 3.16. Chose indie + electronic
--                          instead of house/techno so club-only defaults
--                          don't tag their many guitar-led nights.
--   signal               — Bushwick warehouse, techno/house focus.
--   apollo-studio        — Bushwick club, house/techno dance.
--   silence-please       — Listening bar; electronic/ambient + club-focused.
--   refuge               — Warehouse techno/house room.
--   le-bain              — Standard rooftop club; house/pop, queer flavor.
--   delirium             — Bushwick underground techno/house.
--
-- Slugs validated against public.venues 2026-04-19.
-- Flavor values restricted to existing taxonomy tags (club-focused,
-- underground, warehouse, queer, peak-time, daytime).

update public.venues set
  default_genres  = array['indie','electronic'],
  default_flavors = array['underground']
where slug = 'elsewhere';

update public.venues set
  default_genres  = array['techno','house'],
  default_flavors = array['warehouse']
where slug = 'signal';

update public.venues set
  default_genres  = array['house','techno'],
  default_flavors = array['club-focused']
where slug = 'apollo-studio';

update public.venues set
  default_genres  = array['electronic','ambient'],
  default_flavors = array['club-focused']
where slug = 'silence-please';

update public.venues set
  default_genres  = array['techno','house'],
  default_flavors = array['warehouse']
where slug = 'refuge';

update public.venues set
  default_genres  = array['house','pop'],
  default_flavors = array['club-focused','queer']
where slug = 'le-bain';

update public.venues set
  default_genres  = array['techno','house'],
  default_flavors = array['underground']
where slug = 'delirium';
