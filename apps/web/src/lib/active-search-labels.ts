// Phase 6.3 v2 — server-side resolver for the active-filter chip
// labels.
//
// The home page URL stores `?artist=courtesy` / `?venue=public-records`
// as slugs (clean, shareable, stable across artist re-imports). The
// active-chip row needs the *display name* to render — "Courtesy"
// instead of "courtesy", "Public Records" instead of "public-records".
//
// Resolved server-side in page.tsx and threaded into FilterBar /
// DesktopActiveSearchChip via props. One round-trip per filter, both
// hit unique-indexed columns (artists.slug + venues.slug from migration
// 0001), so the cost is negligible.
//
// Returns null for an unresolvable slug rather than throwing — the
// feed query already short-circuits to empty results in that case
// (see lib/events.ts), and surfacing a half-rendered chip with the
// raw slug as label would be confusing.

import { createClient } from '@/lib/supabase/server';

export type ActiveSearchLabels = {
  artist: { slug: string; name: string } | null;
  venue: { slug: string; name: string } | null;
};

export async function getActiveSearchLabels(
  artistSlug: string | null,
  venueSlug: string | null,
): Promise<ActiveSearchLabels> {
  if (!artistSlug && !venueSlug) {
    return { artist: null, venue: null };
  }

  const supabase = createClient();

  // Run both lookups in parallel; either may be null.
  const [artistRes, venueRes] = await Promise.all([
    artistSlug
      ? supabase
          .from('artists')
          .select('slug, name')
          .eq('slug', artistSlug)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    venueSlug
      ? supabase
          .from('venues')
          .select('slug, name')
          .eq('slug', venueSlug)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  return {
    artist:
      artistRes.data && !artistRes.error
        ? {
            slug: (artistRes.data as { slug: string }).slug,
            name: (artistRes.data as { name: string }).name,
          }
        : null,
    venue:
      venueRes.data && !venueRes.error
        ? {
            slug: (venueRes.data as { slug: string }).slug,
            name: (venueRes.data as { name: string }).name,
          }
        : null,
  };
}
