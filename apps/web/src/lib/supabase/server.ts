// Server-side Supabase client for RSC / route handlers. Uses anon key + cookie auth.
// NEVER instantiate with service role here — service role lives only in packages/ingestion.
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/supabase/types';

export function createClient() {
  const cookieStore = cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `set` called from a Server Component — noop, middleware handles refresh.
          }
        },
      },
    },
  );
}
