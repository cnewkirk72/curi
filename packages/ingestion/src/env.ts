// Centralized env access. Fail loud at startup rather than later with a null ref.
import 'dotenv/config';

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
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  musicbrainzUserAgent: optional(
    'MUSICBRAINZ_USER_AGENT',
    'Curi/0.1 (cmitsuo7@yahoo.com)',
  ),
  politeDelayMs: Number.parseInt(
    optional('INGEST_POLITE_DELAY_MS', '1500'),
    10,
  ),
  defaultSources: optional('INGEST_DEFAULT_SOURCES', 'all'),
  // Spotify Web API (Client Credentials). Optional — artist enrichment
  // gracefully skips Spotify when these are empty. Both must be set together.
  spotifyClientId: optional('SPOTIFY_CLIENT_ID', ''),
  spotifyClientSecret: optional('SPOTIFY_CLIENT_SECRET', ''),
};
