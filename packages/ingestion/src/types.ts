// Shared ingestion types. Kept tiny and strict — the normalizer trusts this shape.
import { z } from 'zod';

export const RawEventSchema = z.object({
  /** Stable id from the source. Combined with `source` forms our upsert key. */
  sourceId: z.string().min(1),
  /** Source slug, e.g. "venue:public-records", "shotgun". */
  source: z.string().min(1),
  title: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable(),
  /** Venue slug — must match a row in `venues.slug` (or null for non-venue sources). */
  venueSlug: z.string().nullable(),
  priceMin: z.number().nonnegative().nullable(),
  priceMax: z.number().nonnegative().nullable(),
  ticketUrl: z.string().url().nullable(),
  imageUrl: z.string().url().nullable(),
  description: z.string().nullable(),
  /** Artist names as parsed from the title / lineup. Normalizer will upsert these. */
  artistNames: z.array(z.string().min(1)),
  /**
   * Genre strings supplied directly by the source (e.g. RA's event.genres).
   * Normalizer resolves these through taxonomy_map alongside the artist
   * rollup — they act as a high-precision base-layer tag signal that
   * doesn't depend on any individual artist having good MB coverage.
   * Optional: sources without a genre field (plain HTML scrapers) omit it.
   */
  sourceGenres: z.array(z.string().min(1)).optional().default([]),
  /** The untouched source payload — we keep this for debugging + future re-parse. */
  raw: z.record(z.unknown()),
});

export type RawEvent = z.infer<typeof RawEventSchema>;

export interface Scraper {
  source: string;
  scrape: () => Promise<RawEvent[]>;
}

export interface ScrapeRunResult {
  source: string;
  runAt: string;
  eventsFound: number;
  errors: string[];
}
