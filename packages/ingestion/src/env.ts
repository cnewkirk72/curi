// Centralized env access. Fields are evaluated *lazily* on first access (via
// getters) rather than at import time — so a script that only needs a subset
// of env vars (e.g. spotify-eval.ts, which needs SPOTIFY_* but not
// SUPABASE_*) can run without having every unrelated cred set. The tradeoff
// is we fail when a missing var is first touched instead of at startup; in
// practice the relevant code paths touch their deps immediately.
//
// dotenv resolution: we search deliberately from this module's own location
// (not cwd), so both `pnpm --filter @curi/ingestion exec ...` from the
// repo root and `tsx src/foo.ts` from inside packages/ingestion resolve the
// same .env files. Order: package-local .env → monorepo-root .env.local →
// monorepo-root .env. dotenv respects first-write-wins so earlier files
// override later ones.
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

dotenvConfig({ path: resolve(PACKAGE_ROOT, '.env') });
dotenvConfig({ path: resolve(MONOREPO_ROOT, '.env.local') });
dotenvConfig({ path: resolve(MONOREPO_ROOT, '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export const env = {
  get supabaseUrl(): string {
    return required('SUPABASE_URL');
  },
  get supabaseServiceRoleKey(): string {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get musicbrainzUserAgent(): string {
    return required('MUSICBRAINZ_USER_AGENT');
  },
  get politeDelayMs(): number {
    return Number.parseInt(optional('INGEST_POLITE_DELAY_MS', '1500'), 10);
  },
  get defaultSources(): string {
    return optional('INGEST_DEFAULT_SOURCES', 'all');
  },
  // ── Post-scrape enrichment (cron) ────────────────────────────────
  // After the daily scrape runs, the cron chains a bounded full
  // enrichment pass (Spotify + LLM + popularity-discovery) over
  // artists in upcoming events that haven't been fully enriched yet.
  // See post-scrape-enrich.ts for the cohort definition.
  //
  // Toggle off (set to 'false') to revert cli.ts to the pre-Phase-5.6
  // behavior of "scrape only" — useful if external API budgets need
  // an emergency cut. Defaults to enabled.
  get autoEnrichEnabled(): boolean {
    const v = optional('INGEST_AUTO_ENRICH', 'true').toLowerCase();
    return v !== 'false' && v !== '0' && v !== 'off';
  },
  // Caps how many artists the nightly cron will enrich per run.
  // Sized to keep API spend predictable and stay well under the daily
  // Anthropic / Spotify / Firecrawl budgets even on a backlog day.
  get autoEnrichLimit(): number {
    const n = Number.parseInt(optional('INGEST_AUTO_ENRICH_LIMIT', '100'), 10);
    return Number.isFinite(n) && n > 0 ? n : 100;
  },
  // Worker pool size for the post-scrape pass. Lower than backfill
  // (10) to be polite to upstream APIs during the cron window.
  get autoEnrichConcurrency(): number {
    const n = Number.parseInt(
      optional('INGEST_AUTO_ENRICH_CONCURRENCY', '4'),
      10,
    );
    return Number.isFinite(n) && n > 0 ? n : 4;
  },
  // Spotify Web API (Client Credentials). Optional — artist enrichment
  // gracefully skips Spotify when these are empty. Both must be set together.
  get spotifyClientId(): string {
    return optional('SPOTIFY_CLIENT_ID', '');
  },
  get spotifyClientSecret(): string {
    return optional('SPOTIFY_CLIENT_SECRET', '');
  },
  // Phase 4 LLM-driven enrichment. All three are optional here so the
  // ingestion package imports don't explode when they're missing —
  // callsites (anthropic.ts / exa.ts / firecrawl.ts) throw with a
  // descriptive error when the key is actually needed.
  get anthropicApiKey(): string {
    return optional('ANTHROPIC_API_KEY', '');
  },
  get exaApiKey(): string {
    return optional('EXA_API_KEY', '');
  },
  get firecrawlApiKey(): string {
    return optional('FIRECRAWL_API_KEY', '');
  },
  get ticketmasterApiKey(): string {
    return optional('TICKETMASTER_API_KEY', '');
  },
};
