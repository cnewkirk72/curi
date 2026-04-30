# Phase 5.7.1 — WKWebView Spotify Connect (Implementation Spec)

**Status:** Draft 2026-04-29. Replaces the bot-account approach in Phase 5.7.

**Goal:** Connect users' Spotify follow graphs to Curi without Spotify OAuth's 5-user quota cap, using a compliant, low-risk WKWebView pattern that withstands App Store review in the post-Meta environment.

**Non-goal:** Replacing the Phase 5.7 schema, sort, UI components, or page wiring. Those stay. This spec only changes the *populator* of `user_spotify_follows`.

---

## 1. Why this approach

Phase 5.7's bot-account scraping pattern hit Spotify's Fastly edge layer with `403 URL Blocked` errors that originate from cloud-IP-range blocking. The block is unfixable from any cloud provider (Vercel, Railway, AWS) regardless of headers, cookies, or TOTP. Spotify accepts authenticated requests fine from residential IPs — i.e., the user's own device.

The WKWebView approach moves the data capture to where the user already is: the user's iPhone. Spotify sees a normal authenticated session from a normal residential ASN, indistinguishable from the user opening Safari and visiting spotify.com directly.

## 2. What gets captured

Confirmed via HAR capture from a real Spotify session:

```
GET https://spclient.wg.spotify.com/user-profile-view/v3/profile/{userId}/following
```

- 289 followed artists for the test user, single response, ~40KB protobuf
- Auth required: Bearer (from `/api/token` with TOTP) + `client-token` + browser-shape headers
- All auth managed by Spotify's bundle inside the webview — Curi never reproduces it
- Artist URIs visible as plain UTF-8 strings inside the protobuf, extractable via regex `spotify:artist:[A-Za-z0-9]{22}`

We don't reconstruct any auth chain. We don't issue our own pathfinder requests. We observe the response of one specific endpoint via `PerformanceObserver` from an isolated `WKContentWorld`, re-fetch the same URL with the user's cookies, and regex out the artist IDs.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Curi iOS App (Capacitor 8)                                       │
│                                                                    │
│  ┌────────────────────┐                                           │
│  │ Main Curi WebView  │ ← user's primary UI; has Curi Supabase    │
│  │ (apps/web Next.js) │   session cookie                          │
│  └─────┬──────────────┘                                           │
│        │ SpotifyConnect.start() (Capacitor plugin call)           │
│        ▼                                                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Swift: SpotifyConnectPlugin                                 │  │
│  │ - Shows SpotifyConsentViewController (native SwiftUI)        │  │
│  │ - On user "Continue", spawns SpotifyWebViewController        │  │
│  └─────┬──────────────────────────────────────────────────────┘  │
│        │                                                            │
│        ▼                                                            │
│  ┌────────────────────────┐                                       │
│  │ Spotify WKWebView       │ ← loads open.spotify.com             │
│  │ - Ephemeral data store  │ ← cookies destroyed on dismiss        │
│  │ - WKContentWorld bridge │ ← injection isolated from page        │
│  │ - Navigation allowlist  │ ← only *.spotify.com permitted        │
│  └─────┬──────────────────┘                                       │
│        │ window.webkit.messageHandlers.curiSpotify.postMessage()  │
│        ▼                                                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Swift: receives URI list, dismisses webview, notifies        │  │
│  │ Main Curi WebView via Capacitor plugin event                  │  │
│  └─────┬──────────────────────────────────────────────────────┘  │
│        │                                                            │
│        ▼                                                            │
│  ┌────────────────────┐                                           │
│  │ Main Curi WebView  │ ← receives event, calls server action     │
│  │ (carries Curi auth)│                                           │
│  └─────┬──────────────┘                                           │
└────────┼──────────────────────────────────────────────────────────┘
         ▼
  Curi server: syncSpotifyFollows(ids) writes user_spotify_follows
```

Three independent auth contexts:
1. **User → Curi**: existing Supabase Google Sign-In (unchanged)
2. **User → Spotify**: user signs into Spotify directly inside the WKWebView; cookies isolated to ephemeral data store
3. **Spotify webview → Spotify API**: managed entirely by Spotify's bundle (TOTP, Bearer, client-token, all internal)

Curi holds zero Spotify credentials. The IDs flow through Capacitor IPC (in-process) to the main Curi WebView, which POSTs them to Curi's backend with the user's existing Curi session.

## 4. UX flow

### Connect (first-time)

1. Profile → Connectors → Spotify card → tap **Connect**
2. **Native consent sheet** (SwiftUI, NOT a webview) shown:

   > **Connect your Spotify**
   >
   > Curi will open Spotify in a window inside the app. You sign in to your Spotify account using Spotify's own login — Curi never sees your password.
   >
   > Once signed in, Curi reads:
   > - The list of artists you follow on Spotify
   >
   > Curi does NOT read:
   > - Your password or login credentials
   > - Your playlists or listening history
   > - Payment information
   > - Any other Spotify data
   >
   > Your Spotify session is cleared when the window closes. Curi saves only the list of artist IDs to rank events in your feed.
   >
   > [ Cancel ] [ Continue ]

3. WKWebView opens at `accounts.spotify.com/login?continue=open.spotify.com`
4. User signs in with Spotify's own login form (Curi never sees credentials)
5. Bundle loads, fires `/user-profile-view/v3/profile/{userId}/following` naturally
6. Injected script captures response, posts URIs via message handler
7. Webview dismisses, ephemeral cookies destroyed
8. Toast: "Connected! Imported N artists you follow on Spotify."
9. Hard-refresh to home with new follow data live

### Refresh

Re-prompts user to re-sign-in (ephemeral cookies). Same flow as first connect with copy adjusted to "Refresh your Spotify follows."

### Disconnect

Profile button → server action deletes all `user_spotify_follows` rows for user, clears `user_prefs.spotify_*` columns. UI returns to disconnected state.

## 5. Risk analysis (Meta lens)

### What got Meta in trouble

Felix Krause's Aug 2022 disclosure: Instagram/Facebook in-app browsers injected JS automatically into ALL third-party sites users visited, tracking forms, taps, scrolls, including credit card fields. No disclosure, no consent.

### How Curi's flow is structurally different

| Dimension | Meta (rejected pattern) | Curi (this spec) |
|---|---|---|
| Trigger | Every link tap, automatic | Single user-initiated Connect tap |
| Consent | Implicit, buried | Explicit pre-flight consent screen |
| Scope | All websites | One URL pattern (open.spotify.com) |
| Data captured | All DOM events, forms, keystrokes | One endpoint response |
| Purpose | Ad attribution / tracking | Personalize feed sort |
| Lifecycle | Always-on, ambient | Opens for connect, closes after |
| Form/credential capture | Yes | No — only response observation |

Curi's pattern is closer to 1Password autofill or Pocket article extraction — App Store-precedented categories, not Meta-style ambient surveillance.

### Modern WKWebView mitigations applied

- **`WKContentWorld`** isolation — injected script runs in a sandboxed world, can't read or modify the page's scripts. Stronger isolation than monkey-patching the page's `fetch`.
- **`WKWebsiteDataStore.nonPersistent()`** — Spotify cookies destroyed when webview closes. No persistent session.
- **`WKNavigationDelegate`** with strict allowlist — only `*.spotify.com` URLs permitted. No way to redirect the webview elsewhere.
- **`PerformanceObserver`** for response detection (cross-world-safe), not page-script monkey-patch.

### Privacy compliance

- Privacy Manifest (`PrivacyInfo.xcprivacy`) declares music-data collection type
- Privacy policy adds explicit Spotify Integration section
- App Store Connect review notes detail the flow + include demo video

### Residual risk

After mitigations: moderate, not zero. Reviewer interpretation is the wildcard. Mitigated by explicit documentation. If rejected, fallback to OAuth (5-user cap) on iOS while Chrome extension carries desktop scale.

## 6. Implementation files

### Native (iOS)

```
apps/web/ios/App/App/Plugins/SpotifyConnect/
  SpotifyConnect.m                     ← Capacitor plugin registration
  SpotifyConnectPlugin.swift           ← @objc plugin class with start()/refresh()
  SpotifyWebViewController.swift       ← WKWebView host with all mitigations
  SpotifyConsentViewController.swift   ← Native SwiftUI consent sheet
  Resources/
    spotify-bridge-script.js           ← The injected observer script
```

### JavaScript (apps/web)

```
apps/web/src/lib/spotify/native-bridge.ts   ← Capacitor plugin TS wrapper
apps/web/src/app/actions/sync-spotify-follows.ts   ← rewritten to accept IDs
apps/web/src/components/profile/spotify-connect-card.tsx   ← branched UX
apps/web/src/components/profile/spotify-onboarding-overlay.tsx   ← simplified
```

### Privacy

```
apps/web/ios/App/App/PrivacyInfo.xcprivacy
```

## 7. What stays untouched

- Migration 0023 schema (`user_spotify_follows`, `user_prefs.spotify_*`)
- 3-tier `feedScore` (BOTH > Spotify > SC > none)
- `<FollowDotStack />` cross-platform indicator
- `<ConnectorsSection />` profile redesign
- `<InfiniteFeed />` candidate-pool merge
- All page wiring (home / saved / profile / event-detail)
- Phase 5.6 SoundCloud flow
- `apps/web/src/lib/follows.ts`
- Spotify-green tokens

## 8. What gets marked dormant

`packages/ingestion/src/spotify-follows/*` and `apps/web/src/lib/spotify-follows/*` (bot-account pathfinder/bot-token/hash-resolver) stay in tree with header comments explaining when they re-activate (residential proxy + Playwright cron path, future Plan C).

`SPOTIFY_BOT_SP_DC` and `SPOTIFY_QUERY_ARTISTS_FOLLOWED_HASH` env vars unused for v1.

Two paused Railway cron services stay paused.

## 9. Web fallback

Non-native (desktop / mobile web) users see "Connect Spotify in the Curi iOS app" with App Store install prompt + deep link. No OAuth fallback in v1; the iOS app is the path. Future: Chrome / Firefox browser extension as desktop-web parity.

## 10. App Store strategy

### Pre-submission

- Privacy Manifest configured
- Privacy Policy link updated in App Store Connect with the new Spotify integration section
- Privacy Nutrition Labels match the manifest
- Demo video recorded (60s walkthrough of connect flow)
- Review notes drafted with explicit step-by-step

### Review notes template

> Spotify Integration: When the user taps "Connect Spotify" in their profile, Curi opens Spotify's website (open.spotify.com) in a window using WKWebView. The user signs into Spotify directly using Spotify's own login form — Curi never sees their password.
>
> Once signed in, Curi reads ONLY the list of artists the user follows on Spotify, by observing the response of one specific Spotify API endpoint (`/user-profile-view/v3/profile/{userId}/following`). Curi does NOT capture form input, password, payment info, listening history, or any other Spotify data.
>
> The webview uses an ephemeral data store (`WKWebsiteDataStore.nonPersistent()`) and closes immediately after the artist list is captured. Captured data (Spotify artist IDs) is used solely to rank events in the user's Curi feed.
>
> Test account credentials and demo video attached. Walkthrough: Launch app → Sign in (Google) → Profile tab → "Connectors" section → Spotify card → "Connect" → consent screen → Continue → Spotify login → "Connected" → home feed shows green follow indicators.

### Appeal plan if rejected

1. Cite precedent: 1Password, Pocket, password managers — App Store-approved patterns of script injection in WKWebView for legitimate user-initiated purposes
2. Engage Apple Developer Relations for senior review
3. Last resort: ship without WKWebView, fall back to OAuth (5-cap) on iOS, browser extension on desktop

## 11. Future roadmap

- **Android Capacitor app** (in roadmap): same WebView + script injection pattern, same plugin interface, same backend. Estimated +1 week to port.
- **Browser extension** (Chrome / Firefox): desktop-web parity, ~1 day dev + 1 week store review.
- **Spotify extended-quota OAuth application**: parallel track in case future-proofing wants OAuth as a sanctioned alternate.
- **Playwright + residential proxy** (dormant): Plan C if WKWebView ever fails systemically. ~$40/mo at MVP scale.

## 12. Verification checklist

- [ ] iOS Capacitor plugin compiles and registers via `CAP_PLUGIN`
- [ ] `SpotifyConnect.start()` opens consent → webview, returns ID list
- [ ] Webview enforces ephemeral cookies (verify via re-launch — no persistent session)
- [ ] Navigation allowlist rejects non-Spotify URLs
- [ ] Injected script extracts URIs from real Spotify protobuf response
- [ ] Server action writes rows scoped to authenticated Curi user
- [ ] feedScore picks up Spotify-tier events (Tier 2: 2,000,000 + popSum)
- [ ] FollowDotStack renders spotify-green dot on matching avatars
- [ ] Cross-platform (Spotify + SC) artists show stacked badges
- [ ] Disconnect button clears all Spotify data
- [ ] Privacy Manifest declared correctly
- [ ] Web fallback shows "use the iOS app" prompt
- [ ] Bot-account modules marked dormant, no runtime imports

## 13. Open questions / deferrals

- Pagination beyond 289 follows: protobuf response size scales linearly; for users with >1000 follows the response may exceed the single-call returned size. Verify empirically; if truncated, follow-up to handle pagination cursor in the protobuf. Not a v1 blocker.
- Spotify 2FA: if user has 2FA enabled, the webview shows Spotify's standard 2FA prompt (works fine). No change needed.
- Captcha: very rare; if seen, user resolves it in-webview, then flow continues.
