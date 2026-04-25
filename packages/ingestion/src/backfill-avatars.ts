// Phase 4f.1 — image-only avatar backfill.
//
// Companion to backfill-run.ts but stripped to a single concern:
// scrape the og:image off SoundCloud + Bandcamp profile pages and
// write it to artists.{soundcloud,bandcamp}_image_url. No LLM call,
// no genre re-derivation, no popularity re-check — just the cheapest
// possible Firecrawl scrape for the missing avatar.
//
// Why a separate script: the 592 gap artists already have SC/BC URLs
// from earlier discovery passes. Re-running full backfill on them
// would burn an LLM call per artist (~$0.005 × 592 ≈ $3) and re-touch
// last_enriched_at, perturbing the rolling-refresh schedule. The
// avatar gap is purely a column we didn't capture before this phase
// — scraping is the only operation needed.
//
// Selection criteria (the gap):
//   spotify_image_url IS NULL                          — Spotify didn't fill it
//   AND (
//        (soundcloud_url IS NOT NULL AND soundcloud_image_url IS NULL)
//     OR (bandcamp_url IS NOT NULL AND bandcamp_image_url IS NULL)
//   )
//
// Per-artist algorithm:
//   1. Prefer SoundCloud — the lineup projection cascades
//      Spotify → SC → BC, so populating SC also fills BC's slot for
//      that artist.
//   2. Firecrawl-scrape the profile page; pull og:image out of the
//      same SelfTagsResult shape used by the main pipeline (we already
//      pay 1 credit per scrape regardless of fields extracted, so
//      this reuses the existing capture path).
//   3. Write only the image_url column for that platform — leave
//      followers, last_enriched_at, etc. untouched.
//   4. On scrape failure (404, timeout): no-op. The monthly refresh
//      cron will retry as part of normal popularity discovery.
//
// Hot-link policy:
//   We persist the CDN URL directly (i1.sndcdn.com / f4.bcbits.com)
//   rather than mirroring to Supabase Storage. SoundCloud and Bandcamp
//   serve these avatars on stable CDNs with permissive CORS; mirroring
//   would add storage cost + a stale-cache problem for ~2KB of value.
//   The web layer uses an onError fallback (lineup-list.tsx) to cover
//   the rare case where a profile is deleted and the CDN URL 404s.
//
// Usage:
//   pnpm --filter @curi/ingestion backfill-avatars \
//     --green-light \           # actually write (default is dry-run)
//     --hotlink \               # explicit ack of hot-link policy (required)
//     [--concurrency 4] \
//     [--limit N]
//
// Without both flags the script refuses to run — these are
// belt-and-suspenders to prevent a misclick from burning Firecrawl
// credits on a stale SC URL set.

import type { Database } from './db-types.js';
import { supabase } from './supabase.js';
import { fetchArtistSelfTags } from './firecrawl.js';

type ArtistUpdate = Database['public']['Tables']['artists']['Update'];

const DEFAULT_CONCURRENCY = 4;
const PAGE_SIZE = 1000;

interface Args {
  concurrency: number;
  limit: number | null;
  greenLight: boolean;
  hotlink: boolean;
}

function parseArgs(argv: string[]): Args {
  let concurrency = DEFAULT_CONCURRENCY;
  let limit: number | null = null;
  let greenLight = false;
  let hotlink = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--concurrency') concurrency = Number(argv[++i]);
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--green-light') greenLight = true;
    else if (a === '--hotlink') hotlink = true;
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    concurrency = DEFAULT_CONCURRENCY;
  }
  return { concurrency, limit, greenLight, hotlink };
}

interface Candidate {
  id: string;
  name: string;
  soundcloud_url: string | null;
  bandcamp_url: string | null;
  needs_sc: boolean;
  needs_bc: boolean;
}

async function loadCandidates(limit: number | null): Promise<Candidate[]> {
  const client = supabase();
  const all: Candidate[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // Selection done in two queries (SC-needing, BC-needing) and
    // merged client-side, because PostgREST's `.or()` doesn't compose
    // cleanly with paired column-NOT-NULL + NULL conditions in one
    // expression. Two paginated reads is simpler than building a
    // raw RPC for a one-shot script.
    const { data: scNeeders, error: scErr } = await client
      .from('artists')
      .select('id, name, soundcloud_url, bandcamp_url')
      .is('spotify_image_url', null)
      .not('soundcloud_url', 'is', null)
      .is('soundcloud_image_url', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (scErr) throw scErr;
    const scRows = (scNeeders ?? []) as Array<{
      id: string;
      name: string;
      soundcloud_url: string | null;
      bandcamp_url: string | null;
    }>;
    for (const r of scRows) {
      all.push({
        ...r,
        needs_sc: !!r.soundcloud_url,
        needs_bc: false,
      });
    }
    if (scRows.length < PAGE_SIZE) break;
    if (limit !== null && all.length >= limit) break;
  }

  // BC-needing pass — exclude any IDs already captured in the SC pass
  // so each candidate is processed once and SC-first ordering holds
  // (we never make a BC call when SC is also available).
  const seenIds = new Set(all.map((c) => c.id));
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: bcNeeders, error: bcErr } = await client
      .from('artists')
      .select('id, name, soundcloud_url, bandcamp_url')
      .is('spotify_image_url', null)
      .not('bandcamp_url', 'is', null)
      .is('bandcamp_image_url', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (bcErr) throw bcErr;
    const bcRows = (bcNeeders ?? []) as Array<{
      id: string;
      name: string;
      soundcloud_url: string | null;
      bandcamp_url: string | null;
    }>;
    for (const r of bcRows) {
      if (seenIds.has(r.id)) continue;
      // Only a BC-only candidate at this point — no SC URL or already
      // had an SC image.
      all.push({
        ...r,
        needs_sc: false,
        needs_bc: !!r.bandcamp_url,
      });
    }
    if (bcRows.length < PAGE_SIZE) break;
    if (limit !== null && all.length >= limit) break;
  }

  return limit !== null ? all.slice(0, limit) : all;
}

interface Outcome {
  id: string;
  name: string;
  status: 'wrote_sc' | 'wrote_bc' | 'no_image' | 'error';
  imageUrl?: string | null;
  error?: string;
}

async function processArtist(
  candidate: Candidate,
  dryRun: boolean,
): Promise<Outcome> {
  // SC first — matches lineup projection priority. Only fall back to BC
  // if there's no SC URL or the SC scrape returned no og:image.
  const trySc = candidate.needs_sc && !!candidate.soundcloud_url;
  const tryBc = candidate.needs_bc && !!candidate.bandcamp_url;

  if (trySc && candidate.soundcloud_url) {
    try {
      const result = await fetchArtistSelfTags(candidate.soundcloud_url, 3);
      if (result.imageUrl) {
        if (!dryRun) {
          const client = supabase();
          const { error } = await client
            .from('artists')
            .update({ soundcloud_image_url: result.imageUrl } as ArtistUpdate)
            .eq('id', candidate.id);
          if (error) {
            return {
              id: candidate.id,
              name: candidate.name,
              status: 'error',
              error: error.message,
            };
          }
        }
        return {
          id: candidate.id,
          name: candidate.name,
          status: 'wrote_sc',
          imageUrl: result.imageUrl,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        id: candidate.id,
        name: candidate.name,
        status: 'error',
        error: msg,
      };
    }
  }

  if (tryBc && candidate.bandcamp_url) {
    try {
      const result = await fetchArtistSelfTags(candidate.bandcamp_url, 3);
      if (result.imageUrl) {
        if (!dryRun) {
          const client = supabase();
          const { error } = await client
            .from('artists')
            .update({ bandcamp_image_url: result.imageUrl } as ArtistUpdate)
            .eq('id', candidate.id);
          if (error) {
            return {
              id: candidate.id,
              name: candidate.name,
              status: 'error',
              error: error.message,
            };
          }
        }
        return {
          id: candidate.id,
          name: candidate.name,
          status: 'wrote_bc',
          imageUrl: result.imageUrl,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        id: candidate.id,
        name: candidate.name,
        status: 'error',
        error: msg,
      };
    }
  }

  return { id: candidate.id, name: candidate.name, status: 'no_image' };
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runOne = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        await worker(item, i);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[pool] worker threw on index ${i}: ${msg}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.greenLight;

  // Belt-and-suspenders: --hotlink is required even on dry-run, because
  // the script's whole posture is "we accept hot-linking from external
  // CDNs". Forcing the flag makes that an explicit decision per-invoke
  // rather than something that drifts in unnoticed.
  if (!args.hotlink) {
    console.error(
      'refusing to run without --hotlink. This script writes hot-linked\n' +
        'CDN URLs from i1.sndcdn.com / f4.bcbits.com to the artists\n' +
        'table. Pass --hotlink to acknowledge.',
    );
    process.exit(2);
  }

  console.log(
    `backfill-avatars: concurrency=${args.concurrency} limit=${
      args.limit ?? 'none'
    } dry-run=${dryRun} hotlink=${args.hotlink}`,
  );

  const candidates = await loadCandidates(args.limit);
  console.log(
    `found ${candidates.length} candidate(s) — sc-first=${
      candidates.filter((c) => c.needs_sc).length
    } bc-only=${candidates.filter((c) => !c.needs_sc && c.needs_bc).length}`,
  );
  if (candidates.length === 0) {
    console.log('nothing to do — the gap is closed. exiting.');
    return;
  }

  const tallies = { wrote_sc: 0, wrote_bc: 0, no_image: 0, error: 0 };
  const startedAt = Date.now();

  await runPool(candidates, args.concurrency, async (candidate, i) => {
    const outcome = await processArtist(candidate, dryRun);
    tallies[outcome.status] += 1;
    const prefix = `[${i + 1}/${candidates.length}]`;
    if (outcome.status === 'wrote_sc') {
      console.log(
        `${prefix} sc: ${candidate.name} → ${outcome.imageUrl}`,
      );
    } else if (outcome.status === 'wrote_bc') {
      console.log(
        `${prefix} bc: ${candidate.name} → ${outcome.imageUrl}`,
      );
    } else if (outcome.status === 'no_image') {
      console.log(`${prefix} no image: ${candidate.name}`);
    } else {
      console.log(
        `${prefix} ERROR: ${candidate.name} — ${outcome.error}`,
      );
    }
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\ndone in ${elapsedSec}s — wrote_sc=${tallies.wrote_sc} wrote_bc=${tallies.wrote_bc} no_image=${tallies.no_image} error=${tallies.error}`,
  );
  if (dryRun) {
    console.log('(dry-run — no DB writes were performed; pass --green-light to commit)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
