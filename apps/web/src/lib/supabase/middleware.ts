// Session-refresh helper for Next.js middleware.
//
// Why this exists: `@supabase/ssr` stores auth in httpOnly cookies that
// expire. Without middleware running on every request, the session silently
// dies and Server Components start seeing a null user — even when the
// browser is still actively signed in. `updateSession` re-hydrates the
// cookies on each request so both the RSC render and any client-side
// Supabase calls see a fresh token.
//
// This follows the canonical @supabase/ssr + Next.js 14 app-router pattern.
// See: https://supabase.com/docs/guides/auth/server-side/nextjs
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/supabase/types';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do NOT add anything between createServerClient() and getUser() — the
  // Supabase docs explicitly warn that inserting logic here can drop the
  // refresh token and silently sign users out.
  await supabase.auth.getUser();

  return supabaseResponse;
}
