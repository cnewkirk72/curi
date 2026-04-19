// Venue / location card for the event detail screen.
//
// We intentionally avoid embedding a real map here — a map SDK (Mapbox,
// Google Maps) would add ~200KB+ of JS, an API key env var, and a
// billing dependency, none of which are worth it for a "see where this
// is" use case. Instead we show a stylized glass card and hand off to
// the user's native maps app via a universal geo/https URL. Apple Maps
// and Google Maps both accept `https://maps.google.com/?q=...`, and
// iOS will prompt to open in Apple Maps when installed.

import { MapPin, ArrowUpRight, Globe } from 'lucide-react';

type Venue = {
  name: string;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
};

/**
 * Build the best-available maps URL:
 *  - With lat/lng: drop a pin at the coords (most precise)
 *  - Without:     fall back to a name + neighborhood query
 *
 * Using `maps.google.com` because it's the one universal endpoint
 * that (a) resolves on every OS/browser combo and (b) iOS Safari
 * will intercept and offer to open in Apple Maps.
 */
function mapsUrlFor(venue: Venue): string {
  if (venue.lat != null && venue.lng != null) {
    return `https://maps.google.com/?q=${venue.lat},${venue.lng}`;
  }
  const query = [venue.name, venue.neighborhood, 'New York, NY']
    .filter(Boolean)
    .join(', ');
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}

export function LocationCard({ venue }: { venue: Venue }) {
  const mapsUrl = mapsUrlFor(venue);
  const hasCoords = venue.lat != null && venue.lng != null;

  return (
    <div className="curi-glass overflow-hidden rounded-2xl shadow-card">
      {/* Stylized "map" backdrop — a subtle radial glow that evokes a
          pin on a map without actually rendering one. Keeps the card
          feeling like a location card while staying on-brand. */}
      <div className="relative h-24 overflow-hidden border-b border-border bg-gradient-to-br from-accent/15 via-accent/5 to-transparent">
        <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(rgba(34,211,238,0.15)_1px,transparent_1px)] [background-size:16px_16px]" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-accent/40 bg-bg-deep/80 shadow-glow-sm backdrop-blur">
            <MapPin className="h-4 w-4 text-accent" />
          </div>
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div>
          <div className="font-display text-lg font-semibold leading-tight tracking-display text-fg-primary">
            {venue.name}
          </div>
          {venue.neighborhood && (
            <div className="mt-1 text-sm text-fg-muted">
              {venue.neighborhood} · New York, NY
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-bg-elevated px-4 py-2.5 text-xs font-medium text-fg-primary transition hover:bg-bg-elevated-hover"
          >
            <MapPin className="h-3.5 w-3.5" />
            {hasCoords ? 'Open in Maps' : 'Find on Maps'}
            <ArrowUpRight className="h-3 w-3 opacity-70" />
          </a>

          {venue.website && (
            <a
              href={venue.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-border bg-bg-elevated px-4 py-2.5 text-xs font-medium text-fg-muted transition hover:bg-bg-elevated-hover hover:text-fg-primary"
            >
              <Globe className="h-3.5 w-3.5" />
              Venue site
              <ArrowUpRight className="h-3 w-3 opacity-70" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
