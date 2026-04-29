import type { Config } from 'tailwindcss';

// Curi — Midnight + Cyan Glow.
// Source of truth for these tokens is design-system/MASTER.md at the repo root;
// any changes to palette/typography should land there first, then be mirrored
// here. Colors use CSS variables (set in globals.css) so we can introduce
// light mode later without touching the Tailwind config.
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      // ─── Color tokens ─────────────────────────────
      colors: {
        // Canvas
        'bg-deep': 'hsl(var(--bg-deep))',
        'bg-base': 'hsl(var(--bg-base))',
        'bg-elevated': 'var(--bg-elevated)',
        'bg-elevated-hover': 'var(--bg-elevated-hover)',

        // Text
        'fg-primary': 'hsl(var(--fg-primary))',
        'fg-muted': 'hsl(var(--fg-muted))',
        'fg-dim': 'hsl(var(--fg-dim))',

        // Primary accent (cyan)
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          hover: 'hsl(var(--accent-hover))',
          deep: 'hsl(var(--accent-deep))',
          glow: 'var(--accent-glow)',
          chip: 'var(--accent-chip-bg)',
        },

        // Supporting accents (use sparingly — chip variety only)
        violet: {
          DEFAULT: 'hsl(var(--violet))',
          chip: 'var(--violet-chip-bg)',
        },
        pale: {
          DEFAULT: 'hsl(var(--pale))',
          chip: 'var(--pale-chip-bg)',
        },
        amber: {
          DEFAULT: 'hsl(var(--amber))',
          chip: 'var(--amber-chip-bg)',
        },
        // Phase 5.6.7 — brand-match for the SC follow indicator. See
        // --sc-orange in globals.css for the rationale. Using the
        // `sc-orange` (kebab) name so it reads correctly in className
        // strings: `bg-sc-orange`, `text-sc-orange`, `border-sc-orange/30`.
        'sc-orange': {
          DEFAULT: 'hsl(var(--sc-orange))',
          chip: 'var(--sc-orange-chip-bg)',
        },

        // Borders
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',

        // Aliases so shadcn-style components keep working if we introduce
        // any; map to our semantic tokens.
        background: 'hsl(var(--bg-deep))',
        foreground: 'hsl(var(--fg-primary))',
        muted: {
          DEFAULT: 'hsl(var(--bg-base))',
          foreground: 'hsl(var(--fg-muted))',
        },
        ring: 'hsl(var(--accent))',
      },

      // ─── Typography ─────────────────────────────────
      fontFamily: {
        // Display: Space Grotesk — headings, event titles, section labels
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        // Body: Inter — everything else (default sans)
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // Mobile-optimized scale from MASTER.md
        '2xs': ['12px', { lineHeight: '1.4' }],
        xs: ['13px', { lineHeight: '1.4' }],
        sm: ['14px', { lineHeight: '1.5' }],
        base: ['16px', { lineHeight: '1.5' }],
        lg: ['18px', { lineHeight: '1.5' }],
        xl: ['22px', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        '2xl': ['28px', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        '3xl': ['36px', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
      },
      letterSpacing: {
        // Mirrors MASTER.md "-0.02em on display headings"
        display: '-0.02em',
      },

      // ─── Radii ────────────────────────────────────────
      borderRadius: {
        // Cards, sheets, event images
        '2xl': '16px',
        // Inputs, small surfaces
        xl: '12px',
        // Chips, pills, avatars — tailwind's `rounded-full` already covers 999px,
        // but alias for clarity.
        pill: '999px',
      },

      // ─── Shadows (glow-based, not drop-based, since we're dark) ──────
      boxShadow: {
        glow: '0 0 24px rgba(34, 211, 238, 0.35)',
        'glow-sm': '0 0 16px rgba(34, 211, 238, 0.25)',
        'glow-lg': '0 0 40px rgba(34, 211, 238, 0.45)',
        // Phase 5.6.7 — SoundCloud-orange glow used by the SC follow
        // indicator (avatar dot on EventCard, ConnectedSummary on
        // /profile, LineupList dots on the event detail page).
        // Mirrors glow-sm's size + alpha shape but with SC brand
        // orange `#FF5500` rendered as rgba so the box-shadow rule
        // renders without runtime CSS-var resolution. Stays in sync
        // with --sc-orange in globals.css — change both together if
        // the brand color shifts.
        'glow-sc-sm': '0 0 16px rgba(255, 85, 0, 0.30)',
        'glow-sc': '0 0 24px rgba(255, 85, 0, 0.40)',
        card: '0 12px 40px -16px rgba(0, 0, 0, 0.8)',
        'nav-top': '0 -1px 0 rgba(255, 255, 255, 0.06) inset',
      },

      // ─── Blur ────────────────────────────────────────
      backdropBlur: {
        glass: '20px',
      },
      backdropSaturate: {
        glass: '1.4',
      },

      // ─── Motion ─────────────────────────────────────────
      transitionTimingFunction: {
        // MASTER.md easing — expo-out for entrances
        expo: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionDuration: {
        // 200ms micro, 280ms sheet/modal
        micro: '200ms',
        sheet: '280ms',
      },

      // ─── Keyframes + animations (ambient blobs, press, enter) ────────
      keyframes: {
        blob: {
          '0%, 100%': {
            transform: 'translate(0px, 0px) scale(1)',
            opacity: '0.14',
          },
          '33%': {
            transform: 'translate(20px, -30px) scale(1.08)',
            opacity: '0.18',
          },
          '66%': {
            transform: 'translate(-15px, 20px) scale(0.95)',
            opacity: '0.11',
          },
        },
        'enter-up': {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        // Used for the onboarding welcome hero — the logo scales
        // up from 92% with the same expo-out easing as enter-up.
        'enter-scale': {
          '0%': { transform: 'scale(0.92)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Onboarding "ready" step — a soft concentric-ring bloom.
        // Runs once, 900ms, expo-out. Respects prefers-reduced-motion.
        'ring-bloom': {
          '0%': { transform: 'scale(0.6)', opacity: '0' },
          '60%': { opacity: '0.9' },
          '100%': { transform: 'scale(1.2)', opacity: '0' },
        },
      },
      animation: {
        // 18s cycle per MASTER.md "12-20s" range
        blob: 'blob 18s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'enter-up': 'enter-up 280ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'enter-scale': 'enter-scale 420ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 280ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'ring-bloom': 'ring-bloom 900ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
