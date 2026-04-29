// Phase 4f.8 audit — single-use read-only scan of artists + events.
//
// Identifies pre-backfill hygiene issues so we don't burn enrichment tokens
// on junk rows. Outputs a JSON report under packages/ingestion/audit-reports/.
// Review the report, then run audit-cleanup.ts with --category=<x> --apply
// to mutate.
//
// Categories (mirrored with src/artist-parsing.ts classifyArtistName so the
// same rules reject at scrape time):
//   non_artist_names            — classifyArtistName rejects with 'noise' or 'event_title'
//   name_length                 — 'too_short' (< 2) or 'too_long' (> 80)
//   orphans_empty               — no events, no enrichment (flag-only)
//   orphans_enriched            — no events, has enrichment (informational)
//   name_collisions             — case-insensitive duplicate name clusters (merge)
//   empty_enrichment            — has events, no enrichment (backfill will handle)
//   empty_enrichment_attempted  — last_enriched_at set but arrays empty (re-queue)
//   punctuation_artifacts       — leading/trailing/doubled punct → propose rename
//   duplicate_events            — same venue + same day + fuzzy title (merge)
//   spotify_protected           — would classify as non_artist but has a
//                                 Spotify match at popularity ≥ 20, i.e.
//                                 real streaming signal — human review only
//
// Usage:
//   pnpm --filter @curi/ingestion audit [--output <path>] [--verbose]

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  artistCollisionKey,
  classifyArtistName,
  type ClassifyReason,
} from './artist-parsing.js';
import { supabase } from './supabase.js';
import { slugify } from './slug.js';

const PAGE_SIZE = 1000;

// Cross-event "same thing" fingerprint: lowercase, alphanum-only, drop
// stopwords and venue/promoter words, keep first 3 meaningful tokens.
// Loose enough to catch "Floating Points at Nowadays" vs "Nowadays presents
// Floating Points" — false positives are fine because duplicate_events is
// always a human-reviewed cluster before apply.
const EVENT_STOP: ReadonlySet<string> = new Set([
  'presents', 'present', 'pres', 'live', 'at', 'the', 'a', 'an',
  'with', 'feat', 'featuring', 'vs', 'and', 'party', 'night', 'show',
  'nyc', 'brooklyn', 'manhattan', 'club', 'room', 'bar', 'dj',
]);

function titleFingerprint(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !EVENT_STOP.has(w))
    .slice(0, 3)
    .join(' ');
}

interface Args {
  output: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  let output = path.resolve(
    process.cwd(),
    `audit-reports/audit-${ts}.json`,
  );
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--output') output = path.resolve(argv[++i] ?? output);
    else if (a === '--verbose') verbose = true;
  }
  return { output, verbose };
}

interface ArtistRow {
  id: string;
  name: string;
  slug: string;
  genres: string[] | null;
  subgenres: string[] | null;
  vibes: string[] | null;
  soundcloud_url: string | null;
  bandcamp_url: string | null;
  spotify_url: string | null;
  spotify_popularity: number | null;
  last_enriched_at: string | null;
}

/**
 * Phase 4f.10 — Tier-2 safety net for the expanded event-title classifier.
 *
 * The classifier in artist-parsing.ts is intentionally aggressive (plural
 * weekdays, "dance party", "boat party", etc.) so the audit can scoop up
 * pollution in one pass. A rule tight enough to be safe forever would also
 * miss a lot. The backstop: if the enrichment pipeline matched this row to
 * Spotify (spotify_url) OR to MusicBrainz (genres/subgenres populated from
 * mb_tags), we don't delete — we route to `spotify_protected` for human
 * review.
 *
 * Why not popularity? The Spotify Nov 2024 API change strips `popularity`
 * from /artists, so the column is universally null/zero in production. The
 * old `popularity ≥ 20` gate was effectively never triggering. Switching
 * to "any enrichment match" is conservative — validated against prod data
 * (1896 rows, 2026-04-28): 100% of pattern-caught phantoms have neither
 * spotify_url nor genre/subgenre data, so the rescue gate keeps real
 * artists safe without protecting any phantom.
 */

interface EventRow {
  id: string;
  title: string;
  starts_at: string;
  venue_id: string | null;
  source: string;
  source_id: string;
}

async function loadArtists(): Promise<ArtistRow[]> {
  const client = supabase();
  const rows: ArtistRow[] = [];
  for (let off = 0; ; off += PAGE_SIZE) {
    const { data, error } = await client
      .from('artists')
      .select(
        'id, name, slug, genres, subgenres, vibes, soundcloud_url, bandcamp_url, spotify_url, spotify_popularity, last_enriched_at',
      )
      .order('id', { ascending: true })
      .range(off, off + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as ArtistRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadEventCountsByArtist(): Promise<Map<string, number>> {
  const client = supabase();
  const counts = new Map<string, number>();
  for (let off = 0; ; off += PAGE_SIZE) {
    const { data, error } = await client
      .from('event_artists')
      .select('artist_id')
      .range(off, off + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ artist_id: string }>;
    for (const r of rows) {
      counts.set(r.artist_id, (counts.get(r.artist_id) ?? 0) + 1);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return counts;
}

async function loadEvents(): Promise<EventRow[]> {
  const client = supabase();
  const rows: EventRow[] = [];
  for (let off = 0; ; off += PAGE_SIZE) {
    const { data, error } = await client
      .from('events')
      .select('id, title, starts_at, venue_id, source, source_id')
      .order('starts_at', { ascending: true })
      .range(off, off + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as EventRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

interface CollisionCluster {
  key: string;
  winner: { id: string; name: string; slug: string; event_count: number };
  losers: Array<{ id: string; name: string; slug: string; event_count: number }>;
}

interface DuplicateEventCluster {
  venue_id: string | null;
  day: string;
  fingerprint: string;
  winner: { id: string; title: string; source: string; source_id: string; starts_at: string };
  losers: Array<{ id: string; title: string; source: string; source_id: string; starts_at: string }>;
}

interface PunctSample {
  id: string;
  current: string;
  proposed: string;
  collides_with: { id: string; name: string } | null;
}

const PUNCT_ARTIFACT_RX = /^[,&/\-()|+]|[,&/\-()|+]$|,,|&&|\/\/|--|\|\|/;

function proposePunctClean(name: string): string {
  let s = name.trim();
  s = s.replace(/^[,&/\-()|+\s]+/, '');
  s = s.replace(/[,&/\-()|+\s]+$/, '');
  s = s.replace(/,,+/g, ',').replace(/&&+/g, '&').replace(/\/\/+/g, '/').replace(/--+/g, '-').replace(/\|\|+/g, '|');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('Loading artists…');
  const artists = await loadArtists();
  console.log(`  ${artists.length} artists`);

  console.log('Loading event_artists…');
  const eventCounts = await loadEventCountsByArtist();
  console.log(`  ${eventCounts.size} artists have ≥1 event`);

  console.log('Loading events…');
  const events = await loadEvents();
  console.log(`  ${events.length} events`);

  const nonArtistNames: Array<{ id: string; name: string; reason: ClassifyReason; event_count: number }> = [];
  const spotifyProtected: Array<{ id: string; name: string; reason: ClassifyReason; event_count: number; spotify_url: string | null; has_mb_tags: boolean }> = [];
  const nameLength: Array<{ id: string; name: string; reason: 'too_short' | 'too_long'; event_count: number }> = [];
  const orphansEmpty: Array<{ id: string; name: string }> = [];
  const orphansEnriched: Array<{ id: string; name: string; genres: string[]; subgenres: string[] }> = [];
  const emptyEnrichment: Array<{ id: string; name: string; event_count: number }> = [];
  const emptyEnrichmentAttempted: Array<{ id: string; name: string; last_enriched_at: string | null }> = [];
  const punctSamples: PunctSample[] = [];

  for (const a of artists) {
    const eventCount = eventCounts.get(a.id) ?? 0;
    const classify = classifyArtistName(a.name);

    if (!classify.valid && (classify.reason === 'noise' || classify.reason === 'event_title')) {
      // Tier-2 enrichment-confidence bypass. If Spotify matched (spotify_url
      // set) OR MusicBrainz returned tags (genres/subgenres populated), the
      // row has external evidence of a real artist with this exact name —
      // route to manual review instead of deletion. Validated against prod
      // (1896 rows): 100% of pattern-caught phantoms have neither signal,
      // so this gate keeps real artists safe without protecting any phantom.
      const hasMbTags =
        (a.genres?.length ?? 0) > 0 || (a.subgenres?.length ?? 0) > 0;
      const hasEnrichmentSignal = !!a.spotify_url || hasMbTags;
      if (hasEnrichmentSignal) {
        spotifyProtected.push({
          id: a.id,
          name: a.name,
          reason: classify.reason,
          event_count: eventCount,
          spotify_url: a.spotify_url,
          has_mb_tags: hasMbTags,
        });
      } else {
        nonArtistNames.push({ id: a.id, name: a.name, reason: classify.reason, event_count: eventCount });
      }
    }

    if (!classify.valid && (classify.reason === 'too_short' || classify.reason === 'too_long')) {
      nameLength.push({ id: a.id, name: a.name, reason: classify.reason as 'too_short' | 'too_long', event_count: eventCount });
    }

    const hasGenres = (a.genres?.length ?? 0) > 0;
    const hasSubgenres = (a.subgenres?.length ?? 0) > 0;
    const hasAnyEnrichment = hasGenres || hasSubgenres;

    if (eventCount === 0) {
      if (hasAnyEnrichment) {
        orphansEnriched.push({ id: a.id, name: a.name, genres: a.genres ?? [], subgenres: a.subgenres ?? [] });
      } else {
        orphansEmpty.push({ id: a.id, name: a.name });
      }
    }

    if (eventCount > 0 && !hasAnyEnrichment && !a.last_enriched_at) {
      emptyEnrichment.push({ id: a.id, name: a.name, event_count: eventCount });
    }

    if (eventCount > 0 && !hasAnyEnrichment && a.last_enriched_at) {
      emptyEnrichmentAttempted.push({ id: a.id, name: a.name, last_enriched_at: a.last_enriched_at });
    }

    if (PUNCT_ARTIFACT_RX.test(a.name)) {
      const proposed = proposePunctClean(a.name);
      if (proposed && proposed !== a.name) {
        const proposedSlug = slugify(proposed);
        const collision = artists.find((x) => x.id !== a.id && x.slug === proposedSlug);
        punctSamples.push({
          id: a.id,
          current: a.name,
          proposed,
          collides_with: collision ? { id: collision.id, name: collision.name } : null,
        });
      }
    }
  }

  // Category: name_collisions
  const byKey = new Map<string, ArtistRow[]>();
  for (const a of artists) {
    const k = artistCollisionKey(a.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(a);
  }
  const collisionClusters: CollisionCluster[] = [];
  for (const [k, group] of byKey) {
    if (group.length < 2) continue;
    const withCounts = group.map((a) => ({ a, ec: eventCounts.get(a.id) ?? 0 }));
    withCounts.sort((x, y) => {
      if (y.ec !== x.ec) return y.ec - x.ec;
      const xe = x.a.last_enriched_at ?? '';
      const ye = y.a.last_enriched_at ?? '';
      if (xe !== ye) return ye.localeCompare(xe);
      return x.a.id.localeCompare(y.a.id);
    });
    const [win, ...lose] = withCounts;
    if (!win) continue;
    collisionClusters.push({
      key: k,
      winner: { id: win.a.id, name: win.a.name, slug: win.a.slug, event_count: win.ec },
      losers: lose.map((l) => ({ id: l.a.id, name: l.a.name, slug: l.a.slug, event_count: l.ec })),
    });
  }

  // Category: duplicate_events (venue + day + fingerprint)
  const byDayKey = new Map<string, EventRow[]>();
  for (const e of events) {
    if (!e.starts_at) continue;
    const day = e.starts_at.slice(0, 10);
    const fp = titleFingerprint(e.title ?? '');
    if (!fp) continue;
    const k = `${e.venue_id ?? 'nullvenue'}|${day}|${fp}`;
    if (!byDayKey.has(k)) byDayKey.set(k, []);
    byDayKey.get(k)!.push(e);
  }
  const dupEventClusters: DuplicateEventCluster[] = [];
  for (const [k, group] of byDayKey) {
    if (group.length < 2) continue;
    // Winner: earliest starts_at, ties broken on id. Source preference not
    // enforced here — human reviews the cluster before apply.
    group.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
    const [win, ...lose] = group;
    if (!win) continue;
    const [venueId, day, fingerprint] = k.split('|') as [string, string, string];
    dupEventClusters.push({
      venue_id: venueId === 'nullvenue' ? null : venueId,
      day,
      fingerprint,
      winner: { id: win.id, title: win.title, source: win.source, source_id: win.source_id, starts_at: win.starts_at },
      losers: lose.map((l) => ({ id: l.id, title: l.title, source: l.source, source_id: l.source_id, starts_at: l.starts_at })),
    });
  }

  // ── Build report ───────────────────────────────────
  const generatedAt = new Date().toISOString();
  const totalLinks = [...eventCounts.values()].reduce((a, b) => a + b, 0);
  const report = {
    generated_at: generatedAt,
    totals: {
      artists: artists.length,
      events: events.length,
      event_artists_rows_counted: totalLinks,
    },
    summary: {
      non_artist_names: { count: nonArtistNames.length, action: 'delete' },
      spotify_protected: { count: spotifyProtected.length, action: 'manual_review' },
      name_length: { count: nameLength.length, action: 'delete' },
      orphans_empty: { count: orphansEmpty.length, action: 'flag' },
      orphans_enriched: { count: orphansEnriched.length, action: 'keep' },
      name_collisions: { clusters: collisionClusters.length, rows_affected: collisionClusters.reduce((s, c) => s + c.losers.length, 0), action: 'merge' },
      empty_enrichment: { count: emptyEnrichment.length, action: 'requeue_via_backfill' },
      empty_enrichment_attempted: { count: emptyEnrichmentAttempted.length, action: 'reset_enrichment' },
      punctuation_artifacts: { count: punctSamples.length, action: 'rename' },
      duplicate_events: { clusters: dupEventClusters.length, rows_affected: dupEventClusters.reduce((s, c) => s + c.losers.length, 0), action: 'merge' },
    },
    categories: {
      non_artist_names: { count: nonArtistNames.length, action: 'delete', rows: nonArtistNames },
      spotify_protected: { count: spotifyProtected.length, action: 'manual_review', rows: spotifyProtected },
      name_length: { count: nameLength.length, action: 'delete', rows: nameLength },
      orphans_empty: { count: orphansEmpty.length, action: 'flag', rows: orphansEmpty },
      orphans_enriched: { count: orphansEnriched.length, action: 'keep', rows: orphansEnriched },
      name_collisions: { count: collisionClusters.length, action: 'merge', clusters: collisionClusters },
      empty_enrichment: { count: emptyEnrichment.length, action: 'requeue_via_backfill', rows: emptyEnrichment },
      empty_enrichment_attempted: { count: emptyEnrichmentAttempted.length, action: 'reset_enrichment', rows: emptyEnrichmentAttempted },
      punctuation_artifacts: { count: punctSamples.length, action: 'rename', rows: punctSamples },
      duplicate_events: { count: dupEventClusters.length, action: 'merge', clusters: dupEventClusters },
    },
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2));

  console.log('\n════════════════════════════════════════════════════');
  console.log('Audit report summary');
  console.log('════════════════════════════════════════════════════');
  for (const [cat, meta] of Object.entries(report.summary)) {
    const m = meta as { count?: number; clusters?: number; rows_affected?: number; action: string };
    const countStr = typeof m.count === 'number'
      ? String(m.count)
      : `${m.clusters} clusters / ${m.rows_affected} rows`;
    console.log(`  ${cat.padEnd(32)} ${countStr.padStart(20)}  → ${m.action}`);
  }
  console.log('\nFull report:');
  console.log(`  ${args.output}`);
  console.log('\nNext: review the report, then per-category apply:');
  console.log('  pnpm --filter @curi/ingestion audit:cleanup --category=<cat> [--apply]');

  if (args.verbose) {
    console.log('\nSample: non_artist_names (first 10)');
    for (const r of nonArtistNames.slice(0, 10)) {
      console.log(`  ${r.id}  "${r.name}"  reason=${r.reason}  events=${r.event_count}`);
    }
    console.log('\nSample: spotify_protected (first 10)');
    for (const r of spotifyProtected.slice(0, 10)) {
      const sig = [r.spotify_url ? 'spotify' : null, r.has_mb_tags ? 'mb' : null]
        .filter(Boolean)
        .join('+');
      console.log(`  ${r.id}  "${r.name}"  reason=${r.reason}  signal=${sig}  events=${r.event_count}`);
    }
    console.log('\nSample: name_collisions (first 5 clusters)');
    for (const c of collisionClusters.slice(0, 5)) {
      console.log(`  [${c.key}] winner=${c.winner.name} (${c.winner.event_count}) · losers=${c.losers.map((l) => `${l.name}(${l.event_count})`).join(', ')}`);
    }
    console.log('\nSample: duplicate_events (first 5 clusters)');
    for (const c of dupEventClusters.slice(0, 5)) {
      console.log(`  [${c.day}|${c.fingerprint}] winner=${c.winner.source}/${c.winner.source_id} "${c.winner.title}" · losers=${c.losers.map((l) => `${l.source}/${l.source_id}`).join(', ')}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
