# Curi — Design System (MASTER)

> Source of truth for Curi's visual language. Page-specific overrides live in
> `design-system/pages/<page>.md` (created on demand) and take precedence.
> Generated from the `ui-ux-pro-max` skill + Christian's Midnight+Cyan Glow brief.

## Product context
Curi is a mobile-first PWA for discovering NYC electronic-music events. Users
browse a curated feed filtered by genre and vibe, save events, and sign in with
Google to personalize. The aesthetic is **nighttime, tech-forward, intentional** —
not rave-flyer, not editorial-white-paper. Think "Berghain website meets
Arc browser."

## Style
**Modern Dark (Cinema Mobile) + Glassmorphism.** Near-black canvas, translucent
frosted-glass surfaces, cool cyan accent with subtle glow. Ambient blurred
"light blobs" drift in the background to give depth without noise.

Avoid pure `#000000` (OLED smear); default to `#05070D` / `#0A0E1A`.

## Color tokens

### Canvas
| Token | Hex / rgba | Use |
|---|---|---|
| `bg-deep` | `#05070D` | Page background (default) |
| `bg-base` | `#0A0E1A` | Elevated page sections, bottom-nav bar |
| `bg-elevated` | `rgba(255,255,255,0.04)` | Glass card base (before blur) |
| `bg-elevated-hover` | `rgba(255,255,255,0.07)` | Glass card hover/press |

### Text
| Token | Hex | Use |
|---|---|---|
| `fg-primary` | `#EDEDEF` | Headings, body text |
| `fg-muted` | `#8A8F98` | Secondary text, meta |
| `fg-dim` | `#5A5F68` | Disabled, placeholder |

### Accent (Cyan glow)
| Token | Hex / rgba | Use |
|---|---|---|
| `accent` | `#22D3EE` | Primary CTA, active states, focus rings |
| `accent-hover` | `#67E8F9` | Hover/press on primary |
| `accent-deep` | `#0891B2` | Pressed, deep hover |
| `accent-glow` | `rgba(34,211,238,0.25)` | Box-shadow glow, behind CTAs |
| `accent-chip-bg` | `rgba(34,211,238,0.12)` | Genre chip fill (cyan family) |

### Supporting accents (for chip variety — use sparingly)
- Violet family (e.g. house, disco): `#C084FC` on `rgba(168,85,247,0.12)`
- Pale-blue family (e.g. ambient, downtempo): `#7DD3FC` on `rgba(125,211,252,0.12)`
- Amber (save/star state, warnings): `#FBBF24` on `rgba(251,191,36,0.12)`

### Borders & dividers
| Token | rgba | Use |
|---|---|---|
| `border` | `rgba(255,255,255,0.08)` | Card borders, dividers |
| `border-strong` | `rgba(255,255,255,0.14)` | Hover borders, selected chips |

## Typography
- **Display:** Space Grotesk (400, 500, 600, 700) — headings, event titles, section labels
- **Body:** Inter (400, 500, 600) — everything else
- **Numeric:** Inter with `font-variant-numeric: tabular-nums` for times/dates/prices
- **Scale:** 12 / 13 / 14 / 16 / 18 / 22 / 28 / 36 (mobile-optimized)
- **Line-height:** 1.5 body, 1.15 display headings
- **Letter-spacing:** `-0.02em` on display headings (tighter, more editorial)

### Google Fonts CSS
```css
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');
```

## Effects & motion

### Radii
- Cards, sheets, event images: `16px`
- Inputs, small surfaces: `12px`
- Chips, pills, avatars: `999px`

### Shadows (all on dark, so they're glow-based not drop-based)
- Primary CTA glow: `0 0 24px rgba(34,211,238,0.35)`
- Elevated card: `0 12px 40px -16px rgba(0,0,0,0.8)`
- Bottom nav top-edge: `0 -1px 0 rgba(255,255,255,0.06) inset`

### Blur
- Glass card backdrop-filter: `blur(20px) saturate(140%)`
- Modal/sheet scrim: `bg-black/60` with `backdrop-blur-md`

### Motion
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (expo-out) for entrances, `ease-in` for exits
- Press scale: `0.97` → `1.0` on release
- Duration: `200ms` micro-interactions, `280ms` sheet/modal transitions
- Enter animations: `translateY(8px) opacity-0 → translateY(0) opacity-1`
- Exit animations run at `~70%` of enter duration (feels responsive)

### Ambient blobs (hero screens only)
Two or three absolutely-positioned circles, `h-64 w-64` up to `h-80 w-80`,
with `blur-3xl` and opacity between `0.10` and `0.18`. Slow `animate-pulse`
or custom keyframes at 12-20s cycles. Placed off-frame (e.g. `-top-24 -right-16`)
so only the glow bleeds onto the canvas. Respect `prefers-reduced-motion` —
disable oscillation but keep the static blobs.

## Layout

### Breakpoints (mobile-first)
| Label | min-width | Use |
|---|---|---|
| default | 0 | Mobile (375-430px design target) |
| `sm` | 640px | Small tablets, landscape phone |
| `md` | 768px | Tablet portrait |
| `lg` | 1024px | Desktop (shows content in a phone-width center column + side rails for future use) |

### Mobile container
- Max-width: `430px` (design target)
- Horizontal padding: `16px` (viewport < 400px), `20px` otherwise
- Safe-area insets respected on top (status bar) and bottom (home indicator)
- Fixed bottom nav height: `68px` + safe-area bottom

### Spacing scale (4/8dp rhythm)
`4, 8, 12, 16, 20, 24, 32, 40, 56, 72` px

## Component recipes

### Glass card
```
bg-white/[0.04]
border border-white/[0.08]
backdrop-blur-xl
rounded-2xl (16px)
shadow-[0_12px_40px_-16px_rgba(0,0,0,0.8)]
```
Hover: `bg-white/[0.06] border-white/[0.12]`. Press: `scale-[0.98]`.

### Primary CTA (cyan button)
```
bg-cyan-400 text-black font-semibold
rounded-full px-6 py-3.5
shadow-[0_0_24px_rgba(34,211,238,0.35)]
hover:bg-cyan-300 active:scale-[0.97]
```
Text is `#000` (not white) for max contrast against cyan.

### Genre chip (default cyan)
```
inline-flex items-center gap-1.5
px-3 py-1.5 rounded-full
bg-cyan-400/[0.12] text-cyan-300
text-[12px] font-medium tracking-tight
border border-cyan-400/[0.18]
```
Selected: `bg-cyan-400/20 border-cyan-400/40 text-cyan-200`.

### Bottom navigation
- 3 items (Home / Saved / Profile) — below the 5-item Material cap
- Icons 22px + 11px label
- Active: cyan icon + cyan label + 3px cyan dot above the icon
- Inactive: `fg-muted` icon, no label visible (optional pattern)
- Background: `bg-[#0A0E1A]/80` + `backdrop-blur-xl` + top-edge inset border

## Accessibility notes
- Cyan `#22D3EE` on `#05070D` = contrast ratio **11.8:1** (AAA ✓)
- Muted text `#8A8F98` on `#05070D` = **5.95:1** (AA ✓, fails AAA — acceptable for meta)
- All chips have text + color (color-not-only)
- Focus rings: `ring-2 ring-cyan-400 ring-offset-2 ring-offset-[#05070D]`
- Touch targets minimum `44×44px`; chips use `min-h-[32px]` with `py-1.5` + extended tap area via parent padding

## Anti-patterns to avoid
- Pure `#000000` backgrounds (OLED smear)
- Magenta/neon-green accents (wrong brand — that's Berghain-adjacent rave; Curi is more Nowadays-adjacent curated)
- Multiple accent colors competing (cyan is the only primary accent)
- Decorative-only animation (every motion must convey cause→effect)
- Emojis as icons (use Lucide)
- Drop-shadows on light-mode style (we're dark — use glows not drops)

## Light mode
Not in Phase 3. The product is dark-first. If light mode is added later, it
should invert the canvas but keep cyan as the accent (cyan reads well on both
light and dark, unlike magenta which muddies on light).
