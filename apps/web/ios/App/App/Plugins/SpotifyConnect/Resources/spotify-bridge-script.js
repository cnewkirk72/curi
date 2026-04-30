// Phase 5.7.1 — Spotify follow-graph capture script.
//
// Runs inside Curi's iOS WKWebView in an isolated WKContentWorld
// named "curi-spotify-bridge". Spotify's own bundle scripts cannot
// see this code (different content world, different fetch reference,
// different global object).
//
// Single purpose: observe one specific endpoint response and post
// the extracted Spotify artist URIs to the native Swift bridge.
//
// What this script does NOT do:
//   - Does not read form input, keystrokes, or DOM events
//   - Does not modify the page or inject UI
//   - Does not capture data from any other endpoint
//   - Does not transmit data anywhere except via the Swift message handler
//   - Does not persist anything (no localStorage, no cookies)
//
// Strategy:
//   PerformanceObserver sees ALL resource loads in the document
//   regardless of content world. When the followed-artists endpoint
//   fires (triggered naturally by Spotify's bundle when the user lands
//   on /user/{theirId}), we re-fetch the same URL ourselves with
//   credentials. Cookies are origin-scoped (not world-scoped), so our
//   re-fetch returns the same protobuf response the page got. We
//   regex-extract the artist URIs and message them to native.

(function () {
  'use strict';

  // Pattern of the endpoint we observe. This is the ONLY URL we
  // capture data from. Confirmed via HAR capture (Phase 5.7 spec § 1).
  const FOLLOWING_URL_PATTERN =
    /\/user-profile-view\/v3\/profile\/[^\/]+\/following(?:\?|$)/;

  // Defensive timeout — if the user signs in but the /following call
  // doesn't fire within 90s, surface an error and let the user retry.
  const TIMEOUT_MS = 90 * 1000;

  let captured = false;
  const timeoutHandle = setTimeout(function () {
    if (captured) return;
    postError('Timed out. The artist list did not load within 90 seconds.');
  }, TIMEOUT_MS);

  let observer = null;
  try {
    observer = new PerformanceObserver(function (list) {
      if (captured) return;
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (FOLLOWING_URL_PATTERN.test(entry.name)) {
          captureFromUrl(entry.name);
          break;
        }
      }
    });
    observer.observe({ entryTypes: ['resource'] });
  } catch (e) {
    postError('Initialization failed: ' + (e && e.message ? e.message : 'unknown'));
    return;
  }

  async function captureFromUrl(url) {
    if (captured) return;
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          accept: 'application/x-protobuf',
        },
      });

      if (!response.ok) {
        // Unusual — the page just successfully fetched this URL.
        // Quietly drop and wait for the next /following load.
        return;
      }

      const buffer = await response.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

      // Extract artist URIs. Spotify's protobuf wire format embeds
      // the URIs as length-prefixed UTF-8 strings; regex matches them
      // as plain text inside the binary blob.
      const uriRegex = /spotify:artist:([A-Za-z0-9]{22})/g;
      const ids = [];
      const seen = Object.create(null);
      let match;
      while ((match = uriRegex.exec(text)) !== null) {
        const id = match[1];
        if (!seen[id]) {
          seen[id] = 1;
          ids.push(id);
        }
      }

      if (ids.length === 0) {
        postError(
          'No followed artists found. Make sure your Spotify profile is set to public and you follow at least one artist.'
        );
        return;
      }

      finishWith({ kind: 'follows', ids: ids });
    } catch (e) {
      postError('Capture failed: ' + (e && e.message ? e.message : 'unknown'));
    }
  }

  function postError(message) {
    finishWith({ kind: 'error', message: message });
  }

  function finishWith(payload) {
    if (captured) return;
    captured = true;
    try { clearTimeout(timeoutHandle); } catch (e) {}
    try { if (observer) observer.disconnect(); } catch (e) {}
    try {
      window.webkit.messageHandlers.curiSpotify.postMessage(payload);
    } catch (e) {
      // Bridge already gone or never available — nothing to do.
    }
  }
})();
