import type { Metadata, Viewport } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import { RegisterSW } from '@/components/register-sw';
import './globals.css';

// next/font self-hosts the Google Fonts at build time, so there's no
// layout-shift-inducing network hop at runtime. The `variable` prop
// publishes each font as a CSS custom property that our Tailwind
// config (tailwind.config.ts) pulls in via `var(--font-display)` /
// `var(--font-sans)`.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Curi — NYC electronic music',
    template: '%s · Curi',
  },
  description: 'Genre- and vibe-filtered events discovery for NYC electronic music.',
  applicationName: 'Curi',
  manifest: '/manifest.webmanifest',
  // Apple-specific PWA flags — makes the app launch full-screen
  // from the iOS home screen with a transparent status bar over
  // our midnight canvas.
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Curi',
  },
  formatDetection: {
    // Stops iOS Safari from auto-linking every numeric string as
    // a phone number (event prices, dates, etc. were getting the
    // blue tel: underline treatment).
    telephone: false,
  },
  icons: {
    // Triple-source so each client picks the right variant:
    //   - icon.svg: favicon on modern browsers (scales crisply)
    //   - icon-{192,512}.png: Android home screen + install prompt
    //   - apple-touch-icon: iOS home screen (180×180, no alpha)
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: '/favicon-32.png',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  // Matches --bg-deep so the iOS status bar and Android theme-color
  // overlay fuse seamlessly with the canvas.
  themeColor: '#05070D',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-dvh bg-bg-deep text-fg-primary antialiased">
        {children}
        {/* Registers /sw.js in production after first paint. Noop in
            development — Next dev + service workers fight each other
            over caching, so we gate on NODE_ENV. */}
        <RegisterSW />
      </body>
    </html>
  );
}
