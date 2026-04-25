// Shared hero-image resolver for event surfaces.
//
// The home-feed `EventCard` and the `/events/[id]` detail screen both
// face the same problem: scrapers don't always return a flyer/hero
// image (~13% of upcoming events on the 30-day window). A grid of
// plain gradient tiles reads as "no data" even when we have plenty
// of lineup richness.
//
// Cascade through the best available visual asset instead of jumping
// straight to the gradient. Headliner avatar → any-lineup avatar →
// venue photo → gradient. Each step degrades gracefully, and the
// gradient is still the ultimate floor.
//
// This used to live inline in `event-card.tsx`. Lifted here in Phase
// 3.17.1 so the detail page can share the exact same fallback chain
// (the home card showed the WhoMadeWho photo via fallback while the
// detail page for the same event was rendering the bare "house"
// gradient — visual inconsistency for the same event).
//
// Both `FeedEvent` and `DetailEvent` satisfy `HeroEventLike`, so this
// module is consumed identically from both surfaces.

/**
 * Minimum shape required by `resolveHero`. Both `FeedEvent` and
 * `DetailEvent` already match — we don't import them here so this
 * module stays cycle-free with `lib/events.ts`.
 */
export type HeroEventLike = {
  image_url: string | null;
  venue: { image_url: string | null } | null;
  lineup: ReadonlyArray<{
    is_headliner: boolean;
    image_url: string | null;
  }>;
};

/**
 * Resolved hero source. The `kind` discriminator lets callers tune
 * crop + scrim per source — e.g. Spotify avatars are square so
 * `object-top` keeps faces in frame when displayed at 5:3, and
 * artist/venue heroes get a "FEATURING" / "VENUE" pill so the eye
 * doesn't mistake an artist headshot for the event flyer.
 */
export type HeroSource =
  | { kind: 'event'; url: string }
  | { kind: 'artist'; url: string }
  | { kind: 'venue'; url: string }
  | { kind: 'none' };

/**
 * Pick the best available hero image, in priority:
 *   1. event.image_url            — curated flyer/show art
 *   2. headliner Spotify avatar   — first `is_headliner` with image_url
 *   3. any lineup Spotify avatar  — covers single-act bills where
 *                                    `is_headliner` is missing/false
 *   4. venue.image_url            — per-venue hero (migration 0016)
 *   5. none                       — caller draws the gradient floor
 */
export function resolveHero(event: HeroEventLike): HeroSource {
  if (event.image_url) return { kind: 'event', url: event.image_url };

  const headlinerAvatar = event.lineup.find(
    (a) => a.is_headliner && a.image_url,
  )?.image_url;
  if (headlinerAvatar) return { kind: 'artist', url: headlinerAvatar };

  const anyAvatar = event.lineup.find((a) => a.image_url)?.image_url;
  if (anyAvatar) return { kind: 'artist', url: anyAvatar };

  if (event.venue?.image_url)
    return { kind: 'venue', url: event.venue.image_url };

  return { kind: 'none' };
}
