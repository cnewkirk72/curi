// Ad-hoc driver: enrich one artist from the CLI to smoke-test the
// Phase 4c pipeline before the eval harness (Phase 4d).
//
// Usage:
//   pnpm --filter @curi/ingestion exec tsx src/llm-enrichment-run.ts \
//     --name "Object Blue" [--venue-slug basement-ny] [--co-billed "a,b,c"]
//
// Prints the structured enrichment result as JSON — includes toolTrace
// so you can see which escalation path fired and fuzzyMerges so you can
// see if Sonnet proposed a near-duplicate that got silently collapsed.

import {
  enrichArtistWithLLM,
  type EnrichmentContext,
} from './llm-enrichment.js';
import { supabase } from './supabase.js';

interface Args {
  name: string;
  venueSlug?: string;
  coBilled?: string[];
}

function parseArgs(argv: string[]): Args {
  let name: string | null = null;
  let venueSlug: string | undefined;
  let coBilled: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') name = argv[++i] ?? null;
    else if (a === '--venue-slug') venueSlug = argv[++i];
    else if (a === '--co-billed') {
      const raw = argv[++i] ?? '';
      coBilled = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!name) {
    console.error(
      'usage: tsx src/llm-enrichment-run.ts --name "<artist>" [--venue-slug <slug>] [--co-billed "a,b,c"]',
    );
    process.exit(1);
  }
  return { name, venueSlug, coBilled };
}

async function main(): Promise<void> {
  const { name, venueSlug, coBilled } = parseArgs(process.argv.slice(2));

  const context: EnrichmentContext = { city: 'NYC' };

  if (venueSlug) {
    const client = supabase();
    const venue = await client
      .from('venues')
      .select('default_genres, default_vibes')
      .eq('slug', venueSlug)
      .maybeSingle();
    if (venue.error) {
      console.error(`warning: failed to load venue ${venueSlug}:`, venue.error.message);
    } else if (venue.data) {
      context.venueDefaults = {
        genres: venue.data.default_genres ?? [],
        vibes: venue.data.default_vibes ?? [],
      };
    } else {
      console.error(`warning: venue ${venueSlug} not found — skipping venue defaults`);
    }
  }

  if (coBilled && coBilled.length) {
    context.coBilledArtists = coBilled;
  }

  const started = Date.now();
  const result = await enrichArtistWithLLM(name, context);
  const elapsed = Date.now() - started;

  console.log(
    JSON.stringify({ name, elapsedMs: elapsed, context, ...result }, null, 2),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
