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
    return optional('MUSICBRAINZ_USER_AGENT', 'Curi/0.1 (cmitsuo7@yahoo.com)');
  },
  get politeDelayMs(): number {
    return Number.parseInt(optional('INGEST_POLITE_DELAY_MS', '1500'), 10);
  },
  get defaultSources(): string {
    return optional('INGEST_DEFAULT_SOURCES', 'all');
  },
  // Spotify Web API (Client Credentials). Optional — artist enrichment
  // gracefully skips Spotify when these are empty. Both must be set together.
  get spotifyClientId(): string {
    return optional('SPOTIFY_CLIENT_ID', '');
  },
  get spotifyClientSecret(): string {
    return optional('SPOTIFY_CLIENT_SECRET', '');
  },
};
