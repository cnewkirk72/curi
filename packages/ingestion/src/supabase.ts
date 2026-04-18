// Service-role Supabase client. NEVER ship this key to the browser — it bypasses RLS.
// Only used inside the ingestion worker.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
import type { Database } from './db-types.js';

let _client: SupabaseClient<Database> | null = null;

export function supabase(): SupabaseClient<Database> {
  if (_client) return _client;
  _client = createClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { 'x-application': 'curi-ingestion' },
    },
  });
  return _client;
}
