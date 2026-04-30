import type { CapacitorConfig } from '@capacitor/cli';

// Phase iOS — Capacitor configuration for the Curi iOS app shell.
//
// The webDir points to a tiny shim bundle in apps/web/public/capacitor-shell
// that the native binary ships with; at runtime the WebView immediately
// navigates to `server.url` (the live Vercel deploy at curi.nyc), so the
// shim only needs to be present to satisfy Capacitor's build step.
//
// allowNavigation enumerates every origin the in-app WebView is permitted
// to navigate to. Production = curi.nyc + Google OAuth + Supabase.
//
// Phase 5.7.1 — registers SpotifyConnectPlugin alongside the existing
// app-target plugins (Browser, Haptics, etc.) so the Capacitor SPM
// runtime discovers it. The plugin's CAP_PLUGIN macro in
// SpotifyConnect.m provides the Objective-C-runtime registration; the
// packageClassList entry here is the explicit SPM-mode discovery.

const config: CapacitorConfig = {
  appId: 'com.curinyc.app',
  appName: 'Curi',
  webDir: 'public/capacitor-shell',
  server: {
    url: 'https://curi.nyc',
    cleartext: false,
    allowNavigation: [
      'curi.nyc',
      '*.curi.nyc',
      'accounts.google.com',
      '*.supabase.co',
    ],
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#05070D',
  },
  // Phase 5.7.1 added SpotifyConnectPlugin to this list. Other entries
  // are the existing Phase iOS plugins.
  packageClassList: [
    'AppPlugin',
    'CAPBrowserPlugin',
    'HapticsPlugin',
    'SplashScreenPlugin',
    'StatusBarPlugin',
    'SocialLoginPlugin',
    'SpotifyConnectPlugin',
  ],
};

export default config;
