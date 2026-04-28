// Per-artist full enrichment pipeline — extracted from backfill-run.ts so
// both the one-shot backfill orchestrator AND the daily cron can share
// the exact same flow:
//
//   1. Spotify lookup (with hard 15s timeout) — gives the LLM prior
//      evidence and writes spotify_id / followers / popularity / image.
//   2. LLM enrichment (Sonnet 4.6 tool-use loop) — genres / subgenres /
//      vibes / opportunistic SC+BC popularity from Firecrawl self-tags.
//   3. Standalone popularity-discovery — homonym-guarded SC/BC follower
//      lookup when the LLM didn't escalate to Firecrawl. Includes the
//      Phase 4f.X DBBD fix: ranks slug-matching candidates by follower
//      count so squatters don't beat the real artist.
//   4. Per-artist DB commit — only overwrites with non-null values to
//      preserve any data from earlier passes.
//
// The previous architecture inlined the entire pipeline inside
// backfill-run.ts, which meant the daily Railway cron (cli.ts → runner.ts
// → normalizer.ts) only got MusicBrainz tags and stopped there — leaving
// 50%+ of newly-scraped artists with null spotify_url / soundcloud_url
// indefinitely. Extracting here lets cli.ts chain a bounded enrichment
// pass after each scrape so the gap stays small over time.
//
// All functions here are PURE in the sense that they don't read CLI
// args, write logs to stdout, or touch the filesystem. The orchestrator
// (backfill-run main() or post-scrape-enrich) owns presentation.
import type { Database } from './db-types.js';
import {
  enrichArtistWithLLM,
  type EnrichmentContext,
  type EnrichmentResult,
  type EnrichmentConfidence,
} from './llm-enrichment.js';
import { supabase } from './supabase.js';
import {
  discoverPopularity,
  type PopularityResult,
} from './popularity-discovery.js';
import {
  searchArtistOnSpotify,
  type SpotifyArtistMatch,
} from './spotify.js';
import { resolveTags } from './taxonomy.js';

type ArtistUpdate = Database['public']['Tables']['artists']['Update'];

// ── Constants ─────────────────────────────────────────────────────────

export const PAGE_SIZE = 1000;

// Hard timeout on the Spotify lookup. Native fetch has none; without
// this a stalled TCP/DNS or rate-limit-cooldown loop could freeze the
// whole orchestrator.
export const SPOTIFY_LOOKUP_TIMEOUT_MS = 15_000;

// Heuristic for "worth spending Firecrawl credits on standalone
// popularity lookup". Substring match against electronic genre/tag
// names likely to predict SC/BC presence. Conservative — a folk act
// tagged "ambient folk" might slip through, but that's fine: the
// homonym guard in popularity-discovery.ts is the real defense.
export const ELECTRONIC_PATTERN =
  /electro|house|techno|trance|dance|club|dub|ambient|bass|dnb|drum-?and-?bass|garage|idm|breakbeat|jungle|grime|hyperpop|footwork|leftfield/i;

// ── Types ─────────────────────────────────────────────────────────────

export interface Artist {
  id: string;
  name: string;
  slug: string;
  mb_tags: Array<{ name: string; count?: number }> | null;
  last_enriched_at: string | null;
  soundcloud_url: string | null;
  bandcamp_url: string | null;
}

export interface VenueRow {
  slug: string | null;
  default_genres: string[] | null;
  default_vibes: string[] | null;
}

export interface EventRow {
  id: string;
  title: string | null;
  starts_at: string;
  venues: VenueRow | VenueRow[] | null;
}

export interface EventArtistRow {
  artist_id: string;
  event_id: string;
  events: EventRow | EventRow[] | null;
}

export interface EventContext {
  eventsByArtist: Map<string, EventRow[]>;
  artistsByEvent: Map<string, string[]>;
  nameById: Map<string, string>;
}

export interface EnrichOptions {
  /** Skip popularity-discovery (Exa + Firecrawl) entirely. Used for
   *  --skip-popularity backfills and any future "spotify-only" mode. */
  skipPopularity?: boolean;
  /** Skip the Spotify lookup. Used when we know we're rate-limited
   *  (Run 2 of the 519/141 cohort backfill, etc.). */
  skipSpotify?: boolean;
}

export interface ArtistLog {
  id: string;
  name: string;
  slug: string;
  startedAt: string;
  elapsedMs: number;
  enrichment?: EnrichmentResult;
  popularity?: PopularityResult | null;
  spotify?: SpotifyArtistMatch | null;
  spotifyAttempted?: boolean;
  tier?: EnrichmentConfidence;
  stalled?: boolean;
  error?: string;
}

function asOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

// ── Event-title detection ────────────────────────────────────────────
//
// Scraper title-parsers occasionally land event/party titles into the
// artists table (e.g. "The 2016 Party: Party like it's 2016", "DJ X
// Presents Future Funk Night"). MusicBrainz fuzzy-tagging can attach
// plausible-looking tags to these phantom rows, so they slip through
// every downstream filter that goes "has mb_tags ⇒ legit artist."
//
// We catch them with a name-shape heuristic and skip them at:
//   1. The cohort loaders (backfill-run + post-scrape-enrich) — saves
//      the Spotify / LLM / Firecrawl spend before processArtist runs.
//   2. processArtist itself — defensive backstop in case a future
//      caller forgets to pre-filter.
//
// Patterns flagged:
//   - Colon followed by 3+ tokens: "The 2016 Party: Party like it's 2016"
//   - "Presents" anywhere: "DJ X Presents Future Funk"
//   - "The X Party" shape: "The Disco Party"
//   - Dash + event-promo keyword in tail: "Cabros Chicos - Peso Pluma
//     Tribute Mexican Dance Parrty" / "Wednesday JAmZZ - All Day Long"
//
// We deliberately avoid filtering on bare-dash, "vs." / "feat." since
// legit collabs and live-set titles use those (e.g. "Honey Dijon b2b
// The Blessed Madonna", "Tale of Us - Afterlife", "Artist - Live Set").
// The dash pattern only fires when the tail contains a strong event
// keyword (tribute|party|fiesta|festival|showcase|anniversary|
// celebration|all day long).
//
// This is a triage filter, not a permanent classification — the right
// long-term fix is to (a) tighten scraper title-parsers and (b) add a
// `kind` column to artists with values 'artist' | 'event' | 'unknown'.
export function isLikelyEventTitle(name: string): {
  flagged: boolean;
  reason?: string;
} {
  const n = name.trim();
  // Colon + 3+ tokens of tail: classic event-subtitle shape.
  if (/^[^:]+:\s+\S+(\s+\S+){2,}/.test(n)) {
    return { flagged: true, reason: 'colon-with-multi-token-tail' };
  }
  // "Presents" anywhere — strong event-promotion signal.
  if (/\bpresents\b/i.test(n)) {
    return { flagged: true, reason: 'contains-presents' };
  }
  // "The X Party" — recurring scraper-leaked shape.
  if (/^the\s+.+\bparty\b/i.test(n)) {
    return { flagged: true, reason: 'the-x-party' };
  }
  // Dash (hyphen / en-dash / em-dash with surrounding spaces) followed
  // by an event-promo keyword in the tail. Catches the
  // "Cabros Chicos - Peso Pluma Tribute Mexican Dance Parrty" shape.
  // Keyword list is conservative: words that almost never appear in a
  // real artist's name but are stock event-promo vocabulary.
  // "parr?ty" handles the common "Parrty" misspelling we keep seeing
  // in scraper-source titles.
  if (
    /\s[-–—]\s.*\b(tribute|parr?ty|fiesta|festival|showcase|anniversary|celebration|all[-\s]day[-\s]long)\b/i.test(
      n,
    )
  ) {
    return { flagged: true, reason: 'dash-with-event-keyword' };
  }
  return { flagged: false };
}

// ── Event context loader ──────────────────────────────────────────────

/**
 * Load every event_artist row + its embedded event + venue, plus the
 * full artist-name lookup table. Used to seed `EnrichmentContext`
 * (co-billed artists, venue defaults, most-recent-event date).
 *
 * Paginated because Supabase silently caps unpaginated SELECTs at 1000
 * rows — a bug we hit during the 4e dry run and are not repeating.
 */
export async function loadEventContext(): Promise<EventContext> {
  const client = supabase();
  const eventsByArtist = new Map<string, EventRow[]>();
  const artistsByEvent = new Map<string, string[]>();
  const nameById = new Map<string, string>();

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('event_artists')
      .select(
        'artist_id, event_id, events!inner(id, title, starts_at, venues(slug, default_genres, default_vibes))',
      )
      .order('artist_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as EventArtistRow[];
    for (const r of rows) {
      const ev = asOne(r.events);
      if (!ev) continue;
      if (!eventsByArtist.has(r.artist_id)) eventsByArtist.set(r.artist_id, []);
      eventsByArtist.get(r.artist_id)!.push(ev);
      if (!artistsByEvent.has(r.event_id)) artistsByEvent.set(r.event_id, []);
      artistsByEvent.get(r.event_id)!.push(r.artist_id);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select('id, name')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const r of rows) nameById.set(r.id, r.name);
    if (rows.length < PAGE_SIZE) break;
  }

  return { eventsByArtist, artistsByEvent, nameById };
}

// ── Context builder ───────────────────────────────────────────────────

function buildContext(
  artist: Artist,
  ctx: EventContext,
  spotifyMatch: SpotifyArtistMatch | null,
): EnrichmentContext {
  const context: EnrichmentContext = { eventCity: 'NYC' };
  if (artist.mb_tags && artist.mb_tags.length) {
    context.existingMbTags = artist.mb_tags
      .map((t) => t.name)
      .filter((n): n is string => !!n);
  }
  // Spotify genre injection — only feed the model confirmed matches
  // (confidence !== 'low' and genres.length > 0). Low-confidence Spotify
  // matches are fuzzy and poison the prompt with wrong-artist genres
  // (e.g. an unrelated "Yaya" on Spotify mapping to a local DJ).
  if (
    spotifyMatch &&
    spotifyMatch.confidence !== 'low' &&
    spotifyMatch.genres.length > 0
  ) {
    context.spotifyGenres = spotifyMatch.genres;
  }
  const events = (ctx.eventsByArtist.get(artist.id) ?? [])
    .filter((e) => !!e && !!e.starts_at)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const mostRecent = events[0];
  if (mostRecent) {
    const venue = asOne(mostRecent.venues);
    if (venue) {
      context.venueDefaults = {
        genres: venue.default_genres ?? [],
        vibes: venue.default_vibes ?? [],
      };
    }
    const coArtists = (ctx.artistsByEvent.get(mostRecent.id) ?? [])
      .filter((id) => id !== artist.id)
      .map((id) => ctx.nameById.get(id))
      .filter((n): n is string => !!n);
    if (coArtists.length) context.coBilledArtists = coArtists.slice(0, 10);
    context.eventDate = mostRecent.starts_at;
  }
  return context;
}

function hasElectronicSignal(
  artist: Artist,
  context: EnrichmentContext,
  enrichment: EnrichmentResult,
): boolean {
  if (
    artist.mb_tags?.some((t) => t.name && ELECTRONIC_PATTERN.test(t.name))
  ) {
    return true;
  }
  if (context.venueDefaults?.genres.some((g) => ELECTRONIC_PATTERN.test(g))) {
    return true;
  }
  if (context.venueDefaults?.vibes.some((v) => ELECTRONIC_PATTERN.test(v))) {
    return true;
  }
  if (context.spotifyGenres?.some((g) => ELECTRONIC_PATTERN.test(g))) {
    return true;
  }
  if (enrichment.genres.some((g) => ELECTRONIC_PATTERN.test(g))) return true;
  if (enrichment.subgenres.some((s) => ELECTRONIC_PATTERN.test(s))) {
    return true;
  }
  return false;
}

// ── Confidence tier ───────────────────────────────────────────────────

/**
 * Post-hoc confidence tier derivation. Combines the LLM's self-reported
 * confidence with whatever external grounding we have for the artist
 * (MusicBrainz tags, confirmed Spotify match). The DB stores this tier
 * — not the LLM's raw output — so downstream readers get a single
 * composite signal.
 *
 *   very-low → stall fallback fired (nothing else matters)
 *   high     → LLM='high' AND at least one external source confirms the
 *              artist exists (MB tags OR Spotify hit)
 *   medium   → LLM='high' without external grounding, OR LLM='medium',
 *              OR LLM='low' but Spotify boosted it into the middle
 *   low      → LLM='low' with no external grounding
 */
export function deriveConfidenceTier(
  enrichment: EnrichmentResult,
  artist: Artist,
  spotifyMatch: SpotifyArtistMatch | null,
): EnrichmentConfidence {
  if (enrichment.confidence === 'very-low') return 'very-low';

  const hasMbTags = !!artist.mb_tags && artist.mb_tags.length > 0;
  const hasSpotify =
    !!spotifyMatch &&
    spotifyMatch.confidence !== 'low' &&
    (spotifyMatch.genres.length > 0 || spotifyMatch.popularity >= 10);
  const hasExternalGrounding = hasMbTags || hasSpotify;

  const totalTags =
    enrichment.genres.length +
    enrichment.subgenres.length +
    enrichment.vibes.length;
  if (totalTags === 0 && !hasExternalGrounding) return 'very-low';

  switch (enrichment.confidence) {
    case 'high':
      return hasExternalGrounding ? 'high' : 'medium';
    case 'medium':
      return 'medium';
    case 'low':
      return hasSpotify ? 'medium' : 'low';
    default:
      return 'low';
  }
}

// ── Spotify (timeout-wrapped) ─────────────────────────────────────────

/**
 * Non-blocking Spotify lookup. Network/auth errors return null rather
 * than bubbling — Spotify being down should not block the whole pass.
 * Returns both the match (if any) and whether we actually attempted,
 * so the commit layer can distinguish "null because skipped" from
 * "null because no match" (the latter sets spotify_discovery_failed_at,
 * the former doesn't).
 */
export async function safeSpotifyLookup(
  name: string,
  skip: boolean,
): Promise<{ match: SpotifyArtistMatch | null; attempted: boolean }> {
  if (skip) return { match: null, attempted: false };
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `spotify lookup exceeded ${SPOTIFY_LOOKUP_TIMEOUT_MS}ms timeout`,
            ),
          ),
        SPOTIFY_LOOKUP_TIMEOUT_MS,
      ),
    );
    const match = await Promise.race([
      searchArtistOnSpotify(name),
      timeout,
    ]);
    return { match, attempted: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  spotify lookup failed for ${name}: ${msg}`);
    return { match: null, attempted: true };
  }
}

// ── DB commit ─────────────────────────────────────────────────────────

export async function commitArtist(
  artist: Artist,
  enrichment: EnrichmentResult,
  popularity: PopularityResult | null,
  spotifyMatch: SpotifyArtistMatch | null,
  spotifyAttempted: boolean,
  tier: EnrichmentConfidence,
): Promise<void> {
  const client = supabase();
  const now = new Date().toISOString();

  const updatePayload: ArtistUpdate = {
    genres: enrichment.genres,
    subgenres: enrichment.subgenres,
    vibes: enrichment.vibes,
    enrichment_confidence: tier,
    last_enriched_at: now,
  };

  if (popularity?.attempted) {
    // Only overwrite a URL/followers column with a non-null value —
    // preserves data from earlier passes if this one came up empty.
    if (popularity.soundcloudUrl) {
      updatePayload.soundcloud_url = popularity.soundcloudUrl;
    }
    if (
      typeof popularity.soundcloudFollowers === 'number' &&
      Number.isFinite(popularity.soundcloudFollowers)
    ) {
      updatePayload.soundcloud_followers = popularity.soundcloudFollowers;
    }
    if (popularity.soundcloudImageUrl) {
      updatePayload.soundcloud_image_url = popularity.soundcloudImageUrl;
    }
    if (popularity.bandcampUrl) {
      updatePayload.bandcamp_url = popularity.bandcampUrl;
    }
    if (
      typeof popularity.bandcampFollowers === 'number' &&
      Number.isFinite(popularity.bandcampFollowers)
    ) {
      updatePayload.bandcamp_followers = popularity.bandcampFollowers;
    }
    if (popularity.bandcampImageUrl) {
      updatePayload.bandcamp_image_url = popularity.bandcampImageUrl;
    }

    const foundAny = !!(popularity.soundcloudUrl || popularity.bandcampUrl);
    if (foundAny) {
      updatePayload.popularity_checked_at = now;
    } else {
      updatePayload.popularity_discovery_failed_at = now;
    }
  }

  // Spotify: same "only overwrite with real values" pattern. If the
  // match is null (no candidate OR low-confidence fuzzy) but we DID
  // attempt, record the timestamp so we don't re-query forever.
  if (spotifyAttempted) {
    if (spotifyMatch && spotifyMatch.confidence !== 'low') {
      updatePayload.spotify_id = spotifyMatch.spotifyId;
      updatePayload.spotify_url = spotifyMatch.spotifyUrl;
      if (
        typeof spotifyMatch.followers === 'number' &&
        Number.isFinite(spotifyMatch.followers)
      ) {
        updatePayload.spotify_followers = spotifyMatch.followers;
      }
      if (
        typeof spotifyMatch.popularity === 'number' &&
        Number.isFinite(spotifyMatch.popularity)
      ) {
        updatePayload.spotify_popularity = spotifyMatch.popularity;
      }
      if (spotifyMatch.imageUrl) {
        updatePayload.spotify_image_url = spotifyMatch.imageUrl;
      }
      updatePayload.spotify_checked_at = now;
    } else {
      updatePayload.spotify_discovery_failed_at = now;
    }
  }

  const { error } = await client
    .from('artists')
    .update(updatePayload)
    .eq('id', artist.id);
  if (error) throw error;

  // Register novel subgenres via Phase 2 Jaccard inference. Best-effort
  // — a taxonomy insert race shouldn't fail the whole artist commit.
  if (enrichment.subgenres.length) {
    const pairs = enrichment.subgenres.map((s) => ({ name: s, count: 1 }));
    try {
      await resolveTags(pairs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  taxonomy resolve failed for ${artist.name}: ${msg}`);
    }
  }
}

// ── Per-artist orchestrator ───────────────────────────────────────────

/**
 * Run the full enrichment pipeline against one artist and commit the
 * result. Never throws — errors are captured into the returned
 * `ArtistLog.error` so the caller's worker pool keeps moving.
 *
 * Includes the DBBD homonym fix: when the LLM captures a SoundCloud
 * URL with < 100 followers (squatter signal), we override with a
 * domain-scoped discoverPopularity pass that ranks slug-matched
 * candidates by follower count.
 */
export async function processArtist(
  artist: Artist,
  ctx: EventContext,
  opts: EnrichOptions = {},
): Promise<ArtistLog> {
  const skipSpotify = opts.skipSpotify ?? false;
  const skipPopularity = opts.skipPopularity ?? false;
  const startedAt = new Date().toISOString();
  const start = Date.now();

  // Defensive backstop: skip phantom-artist rows whose names look like
  // event/party titles. Cohort loaders also pre-filter, but we re-check
  // here so any new caller (one-off scripts, future cron variants) gets
  // the protection for free.
  const eventCheck = isLikelyEventTitle(artist.name);
  if (eventCheck.flagged) {
    return {
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
      startedAt,
      elapsedMs: Date.now() - start,
      error: `skipped: looks like event title (${eventCheck.reason})`,
    };
  }

  try {
    // Spotify first — cheap, fast, gives the LLM prior evidence.
    const { match: spotifyMatch, attempted: spotifyAttempted } =
      await safeSpotifyLookup(artist.name, skipSpotify);

    const context = buildContext(artist, ctx, spotifyMatch);

    const enrichment = await enrichArtistWithLLM(artist.name, context);
    let popularity: PopularityResult | null = null;

    if (!skipPopularity) {
      const llmPop = enrichment.popularity;
      // DBBD-class sanity gate: LLM-captured SoundCloud popularity
      // bypasses the homonym guard in popularity-discovery.ts (it
      // trusts whatever URL the model handed in). That blew up on
      // short/common handles where a squatter and the real artist
      // share a slug. Treat any LLM-captured SC URL with < 100
      // followers as unverified and re-run domain-scoped discovery
      // (which now ranks slug-matched candidates by follower count, so
      // the real artist wins).
      const llmScFollowers = llmPop?.soundcloudFollowers;
      const llmScSuspicious =
        !!llmPop?.soundcloudUrl &&
        typeof llmScFollowers === 'number' &&
        llmScFollowers < 100;

      if (llmPop && !llmScSuspicious) {
        popularity = llmPop;
      } else if (hasElectronicSignal(artist, context, enrichment)) {
        const discovered = await discoverPopularity(artist.name);
        if (llmScSuspicious && llmPop) {
          // Discovery's verdict overrides the suspicious LLM SC URL.
          // If discovery returns no SC URL (no slug match), drop the
          // URL rather than persist the squatter — better no playlist
          // than the wrong one. Bandcamp data the LLM captured still
          // survives if discovery didn't touch BC.
          popularity = {
            attempted: true,
            soundcloudUrl: discovered.soundcloudUrl ?? null,
            soundcloudFollowers: discovered.soundcloudFollowers ?? null,
            soundcloudImageUrl: discovered.soundcloudImageUrl ?? null,
            bandcampUrl: discovered.bandcampUrl ?? llmPop.bandcampUrl ?? null,
            bandcampFollowers:
              discovered.bandcampFollowers ?? llmPop.bandcampFollowers ?? null,
            bandcampImageUrl:
              discovered.bandcampImageUrl ?? llmPop.bandcampImageUrl ?? null,
            sources: [...llmPop.sources, ...discovered.sources],
          };
        } else {
          popularity = discovered;
        }
      } else {
        // Non-electronic act, enrichment didn't touch Firecrawl. Skip
        // discovery — a folk/jazz act on SC is a low-value signal at
        // Firecrawl credit cost.
        popularity = llmScSuspicious
          ? { attempted: true, sources: llmPop?.sources ?? [] }
          : llmPop ?? { attempted: false, sources: [] };
      }
    }

    const tier = deriveConfidenceTier(enrichment, artist, spotifyMatch);

    await commitArtist(
      artist,
      enrichment,
      popularity,
      spotifyMatch,
      spotifyAttempted,
      tier,
    );

    const elapsedMs = Date.now() - start;
    return {
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
      startedAt,
      elapsedMs,
      enrichment,
      popularity,
      spotify: spotifyMatch,
      spotifyAttempted,
      tier,
      stalled: enrichment.stalled,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
      startedAt,
      elapsedMs,
      error: msg,
    };
  }
}
