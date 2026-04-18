# @curi/web

Next.js 14 App Router + TypeScript + Tailwind + shadcn/ui. PWA target.

## Dev

```bash
pnpm install     # from repo root
pnpm dev         # apps/web on :3000
```

## Phase checkpoints

- **Phase 1** (now) — skeleton, Tailwind tokens, Supabase client stubs, PWA manifest.
- **Phase 3** — Discover / Saved / Profile screens, bottom nav, filter URL state.
  Design direction runs through the `ui-ux-pro-max` skill.

## PWA

- `public/manifest.webmanifest` — app manifest
- `public/icon.svg` + `icon-192.png` + `icon-512.png` — maskable icons
- iOS `apple-touch-icon.png` required for "Add to Home Screen"
- Service worker is added in Phase 3 alongside offline caching
