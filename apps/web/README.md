# @curi/web

Next.js 14 App Router + TypeScript + Tailwind. PWA target. Midnight + Cyan
Glow design tokens (source: `design-system/MASTER.md` at the repo root).

## Dev

```bash
pnpm install     # from repo root
pnpm dev         # apps/web on :3000
```

Required env (in `.env.local` at the repo root):

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## Auth — local setup

Google OAuth is wired through Supabase. For local dev to work end-to-end
you need to allow the localhost callback in the Supabase dashboard:

**Supabase → Authentication → URL Configuration → Redirect URLs**
Add: `http://localhost:3000/auth/callback`

Then configure the Google provider in Supabase (one-time, pulls from the
GCP OAuth client you set up in `../../README.md`'s Vercel playbook).

Routes:

- `/login` — sign-in screen (redirects to `/` if already authenticated)
- `/auth/callback` — PKCE exchange, sets the session cookie, redirects home
- POST to `signOut` server action — ends session + redirects to `/login`

Middleware at `src/middleware.ts` refreshes the session cookie on every
request — required by `@supabase/ssr`. Don't put logic between
`createServerClient()` and `getUser()` inside the middleware; it'll drop
the refresh token.

## Phase checkpoints

- **Phase 1** — skeleton, Tailwind tokens, Supabase client stubs, PWA manifest.
- **Phase 3.4** — Midnight + Cyan tokens ported into `tailwind.config.ts` +
  `globals.css`. Fonts self-hosted via `next/font/google` (Inter + Space Grotesk).
- **Phase 3.5** — Google OAuth via Supabase. `/login`, `/auth/callback`,
  session middleware, sign-out.
- **Phase 3.6+** — Home feed, Event Detail, Filter sheet, Saved, Profile.

## PWA

- `public/manifest.webmanifest` — app manifest
- `public/icon.svg` + `icon-192.png` + `icon-512.png` — maskable icons
- iOS `apple-touch-icon.png` required for "Add to Home Screen"
- Service worker lands in Phase 3.10 alongside offline caching
