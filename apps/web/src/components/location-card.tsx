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

  const mapEmbedQuery = hasCoords
    ? `${venue.lat},${venue.lng}`
    : [venue.name, venue.neighborhood, 'New York, NY'].filter(Boolean).join(', ');
  const mapEmbedUrl = `https://maps.google.com/maps?q=${encodeURIComponent(mapEmbedQuery)}&output=embed`;

  return (
    <div className="curi-glass overflow-hidden rounded-2xl shadow-card">
      <div className="relative h-40 overflow-hidden border-b border-border">
        <iframe
          src={mapEmbedUrl}
          title="Venue map"
          className="w-full border-0"
          style={{
            height: 'calc(100% + 160px)',
            marginTop: '-50px',
            filter: 'invert(1) hue-rotate(180deg) saturate(0.25) brightness(0.75)',
          }}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
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
