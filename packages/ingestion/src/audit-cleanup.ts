// Phase 4f.8 audit cleanup — per-category apply for the audit report.
//
// Dry-run by default. Pass --apply to actually mutate. Every destructive op
// is logged to artists_audit_backup / events_audit_backup, providing a
// reversible paper trail.
//
// Execution order (enforced by refusing unknown categories):
//   1. punctuation_artifacts     (renames; may create new collisions)
//   2. non_artist_names          (deletes — order-independent)
//   3. name_length               (deletes)
//   4. name_collisions           (merges; must run AFTER renames)
//   5. empty_enrichment_attempted (reset last_enriched_at — re-queues for backfill)
//   6. duplicate_events          (event merges)
//
// Flag-only categories (no handler here): orphans_empty, orphans_enriched,
// empty_enrichment.
//
// Usage:
//   pnpm --filter @curi/ingestion audit:cleanup --category=<cat> [--apply]
//     [--report <path>]          default: latest audit-reports/audit-*.json
//     [--force-stale]            bypass 24h report freshness check
//     [--limit <N>]              process only first N rows of the category

import * as fs from 'node:fs';
import * as path from 'node:path';
import { supabase } from './supabase.js';
import { slugify } from './slug.js';

const REPORT_STALE_MS = 24 * 60 * 60 * 1000;

const ORDERED_CATEGORIES = [
  'punctuation_artifacts',
  'non_artist_names',
  'name_length',
  'name_collisions',
  'empty_enrichment_attempted',
  'duplicate_events',
] as const;

type CategoryName = (typeof ORDERED_CATEGORIES)[number];

function isHandled(c: string): c is CategoryName {
  return (ORDERED_CATEGORIES as readonly string[]).includes(c);
}

interface Args {
  category: CategoryName;
  apply: boolean;
  report: string;
  forceStale: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  let category: string | null = null;
  let apply = false;
  let report = '';
  let forceStale = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--category=')) category = a.split('=')[1] ?? null;
    else if (a === '--category') category = argv[++i] ?? null;
    else if (a === '--apply') apply = true;
    else if (a === '--report') report = argv[++i] ?? '';
    else if (a === '--force-stale') forceStale = true;
    else if (a === '--limit') limit = Number(argv[++i]);
  }
  if (!category || !isHandled(category)) {
    console.error(`--category=<name> required. One of: ${ORDERED_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
  if (!report) {
    const dir = path.resolve(process.cwd(), 'audit-reports');
    if (!fs.existsSync(dir)) {
      console.error(`No audit-reports/ directory; run pnpm audit first.`);
      process.exit(1);
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) {
      console.error(`No audit report found in ${dir}. Run pnpm audit first.`);
      process.exit(1);
    }
    report = path.join(dir, files[0]!);
  }
  return {
    category: category as CategoryName,
    apply,
    report,
    forceStale,
    limit: Number.isFinite(limit as number) ? limit : null,
  };
}

function loadReport(file: string, forceStale: boolean): any {
  if (!fs.existsSync(file)) {
    console.error(`Report not found: ${file}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const age = Date.now() - new Date(raw.generated_at).getTime();
  if (age > REPORT_STALE_MS && !forceStale) {
    console.error(
      `Report is ${(age / 1000 / 3600).toFixed(1)}h old (> 24h). Re-run pnpm audit or pass --force-stale.`,
    );
    process.exit(1);
  }
  return raw;
}

async function backupArtist(
  id: string,
  category: string,
  action: string,
  notes: string | null,
): Promise<void> {
  const client = supabase();
  const { data: row, error } = await client
    .from('artists')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!row) return;
  // Cast to any — artists_audit_backup is added by migration 0012 but
  // won't appear in db-types.ts until regenerated post-migration.
  const ins = await (client as any)
    .from('artists_audit_backup')
    .insert({ original_id: id, original_row: row, category, action, notes });
  if (ins.error) throw ins.error;
}

async function backupEvent(
  id: string,
  category: string,
  action: string,
  notes: string | null,
): Promise<void> {
  const client = supabase();
  const { data: row, error } = await client
    .from('events')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!row) return;
  const ins = await (client as any)
    .from('events_audit_backup')
    .insert({ original_id: id, original_row: row, category, action, notes });
  if (ins.error) throw ins.error;
}

// ── Handlers ───────────────────────────────────

async function applyDeleteArtists(
  rows: Array<{ id: string; name: string }>,
  category: string,
  apply: boolean,
): Promise<number> {
  if (!apply) {
    console.log(`  DRY-RUN: would delete ${rows.length} artist rows (cascades to event_artists).`);
    for (const r of rows.slice(0, 10)) {
      console.log(`    "${r.name}" (${r.id})`);
    }
    return 0;
  }
  const client = supabase();
  let done = 0;
  for (const r of rows) {
    await backupArtist(r.id, category, 'delete', null);
    const del = await client.from('artists').delete().eq('id', r.id);
    if (del.error) {
      console.error(`  ERR deleting ${r.name} (${r.id}): ${del.error.message}`);
      continue;
    }
    done++;
  }
  console.log(`  DELETED ${done}/${rows.length} rows (backed up to artists_audit_backup).`);
  return done;
}

async function applyRenamePunct(
  rows: Array<{ id: string; current: string; proposed: string; collides_with: { id: string; name: string } | null }>,
  apply: boolean,
): Promise<number> {
  const renamable = rows.filter((r) => !r.collides_with);
  const colliding = rows.filter((r) => r.collides_with);
  console.log(`  ${renamable.length} renamable, ${colliding.length} collide with existing slugs (handle via name_collisions after renaming).`);
  if (!apply) {
    console.log(`  DRY-RUN: would rename ${renamable.length} rows.`);
    for (const r of renamable.slice(0, 10)) {
      console.log(`    "${r.current}" → "${r.proposed}"`);
    }
    return 0;
  }
  const client = supabase();
  let done = 0;
  for (const r of renamable) {
    await backupArtist(r.id, 'punctuation_artifacts', 'rename', `"${r.current}" → "${r.proposed}"`);
    const newSlug = slugify(r.proposed);
    const upd = await client.from('artists').update({ name: r.proposed, slug: newSlug }).eq('id', r.id);
    if (upd.error) {
      console.error(`  ERR renaming ${r.current} (${r.id}): ${upd.error.message}`);
      continue;
    }
    done++;
  }
  console.log(`  RENAMED ${done}/${renamable.length} rows.`);
  return done;
}

async function applyMergeArtists(
  clusters: Array<{
    key: string;
    winner: { id: string; name: string; slug: string; event_count: number };
    losers: Array<{ id: string; name: string; slug: string; event_count: number }>;
  }>,
  apply: boolean,
): Promise<{ merged: number; reassigned: number; droppedDupLinks: number }> {
  if (!apply) {
    const totalLosers = clusters.reduce((s, c) => s + c.losers.length, 0);
    console.log(`  DRY-RUN: would merge ${clusters.length} clusters (${totalLosers} loser rows → winners).`);
    for (const c of clusters.slice(0, 10)) {
      console.log(`    [${c.key}] winner=${c.winner.name} · losers=${c.losers.map((l) => l.name).join(', ')}`);
    }
    return { merged: 0, reassigned: 0, droppedDupLinks: 0 };
  }
  const client = supabase();
  let merged = 0;
  let reassigned = 0;
  let droppedDupLinks = 0;

  for (const c of clusters) {
    const winnerRes = await client.from('artists').select('*').eq('id', c.winner.id).maybeSingle();
    if (winnerRes.error || !winnerRes.data) {
      console.error(`  ERR loading winner ${c.winner.name}: ${winnerRes.error?.message ?? 'not found'}`);
      continue;
    }
    const winner = winnerRes.data as any;

    const mergedGenres = new Set<string>(winner.genres ?? []);
    const mergedSubgenres = new Set<string>(winner.subgenres ?? []);
    const mergedVibes = new Set<string>(winner.vibes ?? []);
    let scUrl: string | null = winner.soundcloud_url;
    let scFollowers: number | null = winner.soundcloud_followers ?? null;
    let bcUrl: string | null = winner.bandcamp_url;
    let bcFollowers: number | null = winner.bandcamp_followers ?? null;
    let lastEnriched: string | null = winner.last_enriched_at;

    for (const lSummary of c.losers) {
      const lRes = await client.from('artists').select('*').eq('id', lSummary.id).maybeSingle();
      if (lRes.error || !lRes.data) continue;
      const l = lRes.data as any;

      for (const g of l.genres ?? []) mergedGenres.add(g);
      for (const g of l.subgenres ?? []) mergedSubgenres.add(g);
      for (const g of l.vibes ?? []) mergedVibes.add(g);
      if (!scUrl && l.soundcloud_url) scUrl = l.soundcloud_url;
      if ((scFollowers ?? 0) < (l.soundcloud_followers ?? 0)) scFollowers = l.soundcloud_followers;
      if (!bcUrl && l.bandcamp_url) bcUrl = l.bandcamp_url;
      if ((bcFollowers ?? 0) < (l.bandcamp_followers ?? 0)) bcFollowers = l.bandcamp_followers;
      if (!lastEnriched && l.last_enriched_at) lastEnriched = l.last_enriched_at;

      // Reassign event_artists: either UPDATE artist_id=winner, or if winner
      // is already on that event, DELETE the loser link (would violate the
      // (event_id, artist_id) PK otherwise).
      const existingLinks = await client
        .from('event_artists')
        .select('event_id')
        .eq('artist_id', lSummary.id);
      if (existingLinks.error) {
        console.error(`  ERR loading links for ${lSummary.name}: ${existingLinks.error.message}`);
        continue;
      }
      for (const link of existingLinks.data ?? []) {
        const exists = await client
          .from('event_artists')
          .select('event_id')
          .eq('event_id', link.event_id)
          .eq('artist_id', c.winner.id)
          .maybeSingle();
        if (exists.data) {
          const del = await client
            .from('event_artists')
            .delete()
            .eq('event_id', link.event_id)
            .eq('artist_id', lSummary.id);
          if (!del.error) droppedDupLinks++;
        } else {
          const upd = await client
            .from('event_artists')
            .update({ artist_id: c.winner.id })
            .eq('event_id', link.event_id)
            .eq('artist_id', lSummary.id);
          if (!upd.error) reassigned++;
        }
      }

      await backupArtist(lSummary.id, 'name_collisions', 'merge_loser', `merged into ${c.winner.id} (${c.winner.name})`);
      const del = await client.from('artists').delete().eq('id', lSummary.id);
      if (del.error) {
        console.error(`  ERR deleting loser ${lSummary.name}: ${del.error.message}`);
      }
    }

    const upd = await client
      .from('artists')
      .update({
        genres: [...mergedGenres],
        subgenres: [...mergedSubgenres],
        vibes: [...mergedVibes],
        soundcloud_url: scUrl,
        soundcloud_followers: scFollowers,
        bandcamp_url: bcUrl,
        bandcamp_followers: bcFollowers,
        last_enriched_at: lastEnriched,
      })
      .eq('id', c.winner.id);
    if (upd.error) {
      console.error(`  ERR updating winner ${c.winner.name}: ${upd.error.message}`);
      continue;
    }
    merged++;
  }

  console.log(`  MERGED ${merged}/${clusters.length} clusters · reassigned ${reassigned} event links · dropped ${droppedDupLinks} duplicate links.`);
  return { merged, reassigned, droppedDupLinks };
}

async function applyResetEnrichment(
  rows: Array<{ id: string; name: string }>,
  apply: boolean,
): Promise<number> {
  if (!apply) {
    console.log(`  DRY-RUN: would null last_enriched_at on ${rows.length} rows (re-queues for backfill).`);
    return 0;
  }
  const client = supabase();
  let done = 0;
  for (const r of rows) {
    await backupArtist(r.id, 'empty_enrichment_attempted', 'reset_enrichment', null);
    const upd = await client.from('artists').update({ last_enriched_at: null }).eq('id', r.id);
    if (upd.error) {
      console.error(`  ERR resetting ${r.name}: ${upd.error.message}`);
      continue;
    }
    done++;
  }
  console.log(`  RESET ${done}/${rows.length} rows.`);
  return done;
}

async function applyMergeEvents(
  clusters: Array<{
    venue_id: string | null;
    day: string;
    fingerprint: string;
    winner: { id: string; title: string; source: string; source_id: string; starts_at: string };
    losers: Array<{ id: string; title: string; source: string; source_id: string; starts_at: string }>;
  }>,
  apply: boolean,
): Promise<{ merged: number; reassigned: number; droppedDupLinks: number }> {
  if (!apply) {
    const totalLosers = clusters.reduce((s, c) => s + c.losers.length, 0);
    console.log(`  DRY-RUN: would merge ${clusters.length} event clusters (${totalLosers} loser events).`);
    for (const c of clusters.slice(0, 10)) {
      console.log(`    [${c.day}|${c.fingerprint}] winner=${c.winner.source}/${c.winner.source_id} · losers=${c.losers.map((l) => `${l.source}/${l.source_id}`).join(', ')}`);
    }
    return { merged: 0, reassigned: 0, droppedDupLinks: 0 };
  }
  const client = supabase();
  let merged = 0;
  let reassigned = 0;
  let droppedDupLinks = 0;
  for (const c of clusters) {
    for (const l of c.losers) {
      const links = await client.from('event_artists').select('artist_id').eq('event_id', l.id);
      if (links.error) {
        console.error(`  ERR loading event_artists for loser ${l.id}: ${links.error.message}`);
        continue;
      }
      for (const link of links.data ?? []) {
        const exists = await client
          .from('event_artists')
          .select('event_id')
          .eq('event_id', c.winner.id)
          .eq('artist_id', link.artist_id)
          .maybeSingle();
        if (exists.data) {
          const del = await client
            .from('event_artists')
            .delete()
            .eq('event_id', l.id)
            .eq('artist_id', link.artist_id);
          if (!del.error) droppedDupLinks++;
        } else {
          const upd = await client
            .from('event_artists')
            .update({ event_id: c.winner.id })
            .eq('event_id', l.id)
            .eq('artist_id', link.artist_id);
          if (!upd.error) reassigned++;
        }
      }
      await backupEvent(l.id, 'duplicate_events', 'merge_loser', `merged into ${c.winner.id} (${c.winner.source}/${c.winner.source_id})`);
      const del = await client.from('events').delete().eq('id', l.id);
      if (del.error) {
        console.error(`  ERR deleting loser event ${l.id}: ${del.error.message}`);
      }
    }
    merged++;
  }
  console.log(`  MERGED ${merged}/${clusters.length} event clusters · reassigned ${reassigned} links · dropped ${droppedDupLinks} duplicate links.`);
  return { merged, reassigned, droppedDupLinks };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = loadReport(args.report, args.forceStale);
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`\n${mode} · category=${args.category} · report=${path.basename(args.report)}`);
  console.log(`  (report generated ${report.generated_at})\n`);

  const cat = report.categories?.[args.category];
  if (!cat) {
    console.error(`Category not found in report: ${args.category}`);
    process.exit(1);
  }

  switch (args.category) {
    case 'punctuation_artifacts': {
      const rows = args.limit ? cat.rows.slice(0, args.limit) : cat.rows;
      await applyRenamePunct(rows, args.apply);
      break;
    }
    case 'non_artist_names':
    case 'name_length': {
      const rows = args.limit ? cat.rows.slice(0, args.limit) : cat.rows;
      await applyDeleteArtists(rows, args.category, args.apply);
      break;
    }
    case 'name_collisions': {
      const clusters = args.limit ? cat.clusters.slice(0, args.limit) : cat.clusters;
      await applyMergeArtists(clusters, args.apply);
      break;
    }
    case 'empty_enrichment_attempted': {
      const rows = args.limit ? cat.rows.slice(0, args.limit) : cat.rows;
      await applyResetEnrichment(rows, args.apply);
      break;
    }
    case 'duplicate_events': {
      const clusters = args.limit ? cat.clusters.slice(0, args.limit) : cat.clusters;
      await applyMergeEvents(clusters, args.apply);
      break;
    }
  }

  console.log(`\n${mode} complete. ${args.apply ? 'Mutations committed.' : 'No mutations. Re-run with --apply to commit.'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
