// Server-side Supabase client for RSC / route handlers / server actions.
// Uses anon key + cookie-backed auth — NEVER instantiate with service role
// here; service role lives only in packages/ingestion and is gated to the
// Railway container.
import { createServerClient, type CookieOptions } from '@supabase/ssr';
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
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `set` throws when called from a Server Component — expected.
            // The middleware (src/middleware.ts) refreshes the session
            // cookie on every request, so this noop is safe.
          }
        },
      },
    },
  );
}
