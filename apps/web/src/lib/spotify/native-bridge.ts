// Phase 5.7.1 — Capacitor plugin client wrapper for SpotifyConnect.
//
// Calls the native iOS plugin defined in
// apps/web/ios/App/App/Plugins/SpotifyConnect/. Used only on native
// platforms; web callers branch on `Capacitor.isNativePlatform()`
// before importing this surface.
//
// Resolves with the captured Spotify artist IDs (22-char base62
// strings). Rejects with one of the contracted error codes:
//   - 'USER_CANCELLED'    user dismissed at consent or webview
//   - 'TIMEOUT'           90s elapsed without /following firing
//   - 'INVALID_PAYLOAD'   bridge returned a malformed payload
//   - 'NETWORK_OFFLINE'   webview couldn't reach Spotify
//   - 'SCRAPE_FAILED'     other capture failure
//   - 'NO_VIEW_CONTROLLER' fallback when the Capacitor host is unavailable
//
// Callers translate these into user-facing toast copy.

import { registerPlugin } from '@capacitor/core';

export interface SpotifyConnectPlugin {
  /**
   * Show the consent sheet, then open the Spotify webview. Resolves
   * with the captured artist IDs once the user completes the flow.
   */
  start(): Promise<{ ids: string[] }>;

  /**
   * Same flow as `start()` but with refresh-flavored copy on the
   * consent screen. Use for the "Refresh" button on the connect card.
   */
  refresh(): Promise<{ ids: string[] }>;
}

export const SpotifyConnect = registerPlugin<SpotifyConnectPlugin>(
  'SpotifyConnect',
);

export type SpotifyConnectErrorCode =
  | 'USER_CANCELLED'
  | 'TIMEOUT'
  | 'INVALID_PAYLOAD'
  | 'NETWORK_OFFLINE'
  | 'SCRAPE_FAILED'
  | 'NO_VIEW_CONTROLLER';

/**
 * Type guard for plugin-rejected errors. Capacitor surfaces native
 * rejections as `{ code, message }` shaped objects.
 */
export function isSpotifyConnectError(
  err: unknown,
): err is { code: SpotifyConnectErrorCode; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}
