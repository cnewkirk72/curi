// Next.js middleware — runs on every matching request to refresh the
// Supabase auth cookie. The actual work is in lib/supabase/middleware.ts;
// this file is just the Next.js entry point + matcher config.
import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *   - _next/static  (static assets)
     *   - _next/image   (image optimizer)
     *   - favicon.ico
     *   - icon.svg, apple-touch-icon.png, manifest.webmanifest  (PWA assets)
     *   - any file extension in the list below (fonts, images)
     *
     * We need middleware on /auth/callback so Supabase can set the session
     * cookie, and on every app route so the session stays fresh.
     */
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-touch-icon.png|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf)$).*)',
  ],
};
