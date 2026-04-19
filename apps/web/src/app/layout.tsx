import type { Metadata, Viewport } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
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
  title: 'Curi — NYC electronic music',
  description: 'Genre- and vibe-filtered events discovery for NYC electronic music.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Curi',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.png',
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
      </body>
    </html>
  );
}
