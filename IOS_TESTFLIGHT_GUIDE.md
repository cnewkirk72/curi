# Curi → iOS TestFlight: Step-by-Step Guide

> Wrap the existing Next.js PWA in a Capacitor iOS shell, archive in Xcode, ship to TestFlight Internal Testing, and send a friend an invite link.

The high-level shape: the Capacitor wrapper gives you a native Xcode project pointing at your live `curi.nyc` URL. That bundle gets uploaded to App Store Connect, exposed via TestFlight, and your friend installs the TestFlight app and clicks an invite link.

This is the standard approach for PWA → App Store. The alternatives (full React Native rewrite, bare WKWebView shell) either require a rewrite or lose the plugin ecosystem. Capacitor lets you keep the Next.js codebase intact.

A heads-up before we start: Apple has historically been suspicious of apps that are "just a webview wrapping a website" (App Review Guideline 4.2). The mitigation is to add a few native touches — splash screen, status bar styling, native plugins for haptics/share — so it doesn't read as a pure wrapper. **For just-friends TestFlight Internal Testing this isn't an issue** — internal builds skip review entirely. External TestFlight (broader audience) and full App Store submission do go through review and may push back. We can cross that bridge later.

---

## 0. Prerequisites

Before starting, confirm you have:

- **Apple Developer Program membership** — confirmed. Apple ID with 2FA enabled.
- **A Mac running macOS 14 (Sonoma) or later** for current Xcode.
- **Xcode 16+** installed from the App Store (~6GB download). Open it once after install to accept the EULA + install additional components.
- **An iPhone** for testing (any iPhone running iOS 17+ is fine). Connect it via USB cable; trust the computer when prompted.
- **A real bundle identifier you'll use forever** — pick `com.curinyc.app` or `com.cnewkirk.curi` or similar. It can't be changed after first App Store submission.

Run these once on the Mac to make sure your dev environment is ready:

```sh
# Check Xcode + CLI tools
xcode-select --install                              # may already be installed
xcodebuild -version                                  # should show Xcode 16+
sudo xcode-select --switch /Applications/Xcode.app   # point CLI at Xcode

# Install CocoaPods (Capacitor uses it for native deps)
sudo gem install cocoapods
# OR via Homebrew:  brew install cocoapods
pod --version                                        # should show 1.15+
```

---

## 1. Add Capacitor to the Curi repo

In the curi monorepo root:

```sh
cd apps/web
pnpm add -D @capacitor/cli
pnpm add @capacitor/core @capacitor/ios

# Capacitor's required output dir — points at a built static directory.
# We'll generate a minimal placeholder since the real app loads remotely.
mkdir -p public/capacitor-shell
echo '<!doctype html><meta http-equiv="refresh" content="0;url=https://curi.nyc">' > public/capacitor-shell/index.html

# Initialize the Capacitor config — this creates capacitor.config.ts
npx cap init "Curi" "com.curinyc.app" --web-dir=public/capacitor-shell
```

When prompted, accept defaults. The bundle ID `com.curinyc.app` (or whatever you pick) is what Apple uses to identify the app — it has to match what you'll register in App Store Connect.

---

## 2. Configure Capacitor to load curi.nyc

Open `apps/web/capacitor.config.ts` and replace its contents:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.curinyc.app',
  appName: 'Curi',
  webDir: 'public/capacitor-shell',
  server: {
    // Load the live PWA. The shell HTML in webDir is just a fallback
    // for when the network is unreachable on app cold-start.
    url: 'https://curi.nyc',
    cleartext: false,
    // Allow navigation to any subdomain + the OAuth provider.
    allowNavigation: [
      'curi.nyc',
      '*.curi.nyc',
      'accounts.google.com',
      '*.supabase.co',
    ],
  },
  ios: {
    // Use the system status bar style; we'll wire light/dark later.
    contentInset: 'automatic',
    // The bg-deep token from your design system, so the launch screen
    // doesn't flash white.
    backgroundColor: '#05070D',
  },
};

export default config;
```

---

## 3. Generate the iOS project

```sh
# From apps/web
npx cap add ios
```

This creates `apps/web/ios/` containing a full Xcode project. You won't edit most of these files — they're generated, and Capacitor regenerates them on `cap sync`.

---

## 4. Add native plugins for App Store credibility

These are tiny but make the app feel native (and help with App Review):

```sh
pnpm add @capacitor/splash-screen @capacitor/status-bar @capacitor/haptics @capacitor/app
npx cap sync ios
```

What each does:

- **splash-screen** — branded launch screen instead of a flash of white
- **status-bar** — lets you set status bar text color (light on your dark background)
- **haptics** — subtle taptic feedback (useful for filter pill toggles)
- **app** — handles deep links, the back button, URL handling

You don't have to wire them into the Curi React code today — having them installed is enough for TestFlight. We can add a small initialization snippet in `apps/web/src/app/layout.tsx` later.

---

## 5. Open the project in Xcode

```sh
npx cap open ios
```

This launches Xcode with `App.xcworkspace`. **Always open the workspace, not the .xcodeproj** — Capacitor's CocoaPods deps are wired through the workspace.

---

## 6. Configure signing in Xcode

In Xcode's left sidebar, click the blue "App" project icon at the top. The settings panel opens.

1. Pick the **App** target in the second column (not the project; the target).
2. Select the **Signing & Capabilities** tab.
3. **Team** dropdown → pick your Apple Developer team (the one your $99 subscription is on). Xcode will prompt you to log in to your Apple ID if you haven't.
4. **Automatically manage signing** stays checked.
5. **Bundle Identifier** field → confirm it shows `com.curinyc.app` (or whatever you used). If Xcode shows "no profile matches" — wait 30 seconds, it's registering the bundle ID with Apple.

---

## 7. Set the version + build numbers

In the same target settings panel, under **General**:

- **Version:** `0.1.0` (matches your phase numbering, semantic-versioning style)
- **Build:** `1` (incremented each TestFlight upload — Apple requires this to be unique per upload)
- **Display Name:** `Curi` (this is what shows under the home-screen icon)

---

## 8. Add the app icon + launch screen

Apple needs a 1024×1024 PNG icon (no transparency, no rounded corners — Apple rounds them automatically) plus a launch storyboard.

**Icon path:**

1. In Xcode's file tree, navigate to `App > App > Assets.xcassets > AppIcon`.
2. Drag a 1024×1024 PNG of the Curi logo into the "App Store" slot at the top.
3. Xcode will auto-generate the rest of the sizes.
4. If you don't have one yet: any 1024×1024 PNG with the Curi logo on a `#05070D` background works for TestFlight. Polish it before App Store submission.

**Launch screen** is already wired to a default `LaunchScreen.storyboard`. To customize:

1. Open `App > App > LaunchScreen.storyboard`.
2. Set the View's Background color to a dark hex (`#05070D`).
3. Add a centered `UIImageView` with your logo (matched to the splash bundle in `App > App > Assets.xcassets > Splash`).

**Optional but worth it:** drop a `Splash@3x.png` (2732×2732) into `Assets.xcassets > Splash` so the splash matches the icon.

---

## 9. Run on the simulator

In Xcode's top toolbar:

1. Click the device dropdown next to the App icon.
2. Pick **iPhone 16 Pro** (or any simulator).
3. Click the **▶ Play** button.

Xcode builds the app, launches the simulator, installs the app, and opens it. You should see a brief splash → curi.nyc loaded inside the webview. Verify:

- Filters work
- Genre/vibe pills toggle correctly
- Date picker appears
- Saving an event works (if you sign in)
- Google OAuth sign-in works (this is the most likely failure point — see Gotchas below)

---

## 10. Run on a physical iPhone

1. Connect your iPhone via USB.
2. On the iPhone: **Settings → Privacy & Security → Developer Mode → On**, then restart.
3. Back in Xcode, the device dropdown should now show your iPhone. Pick it.
4. Click ▶. First run will prompt: **iPhone Settings → General → VPN & Device Management → trust your developer profile**.
5. App opens on your phone.

---

## 11. Archive + upload to App Store Connect

This is the actual "send to TestFlight" step.

1. In Xcode's device dropdown, pick **Any iOS Device (arm64)** — this tells Xcode to build for distribution, not a specific simulator.
2. Top menu: **Product → Archive**. Takes 2–5 minutes.
3. When done, the **Organizer** window opens automatically showing your archive.
4. Click **Distribute App**.
5. Select **App Store Connect → Upload**.
6. Accept defaults on the next few screens (manage signing automatically, upload symbols).
7. Click **Upload**. Takes another 2–5 minutes; you'll see "Upload Successful."

The build now exists in App Store Connect, but it's not yet processable.

---

## 12. Create the App Store Connect record

In a browser, go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com).

1. **My Apps → +** (top left) **→ New App**.
2. Platform: **iOS**. Name: `Curi`. Primary language: English (U.S.). Bundle ID: pick `com.curinyc.app` (which you registered when you signed in Xcode). SKU: anything unique like `curi-001`.
3. Click **Create**.

Now your archive can be associated with the app record. Go to the **TestFlight** tab. Wait ~10 minutes for Apple to "process" your build — the status moves from "Processing" to "Ready to Test." You'll get an email when this finishes.

---

## 13. Add yourself + friend as Internal Testers

While processing, set up the testing pool:

1. **App Store Connect → Users and Access → Add User (+)**.
2. Add yourself with role **Developer** (probably already there).
3. Add your friend's Apple ID email with role **Developer** or **Marketing**. They'll get an email; they need to accept the invite + create an Apple ID account (free; not paid).

Then, in your app:

1. **TestFlight tab → Internal Testing → Create New Group** (or use the default). Name it "Friends."
2. Add yourself + your friend to the group.
3. Once the build status is "Ready to Test," click the build's row and **add it to the Friends group**.

That's it. Both of you get an email with a TestFlight invite link.

---

## 14. Friend installs the build

Your friend:

1. Opens the email on their iPhone.
2. Taps the **Open in TestFlight** link.
3. If they don't have TestFlight: they're prompted to install it from the App Store.
4. TestFlight opens, shows Curi, taps **Install**.
5. App appears on their home screen. They can launch it normally; TestFlight stays in the background.

Internal builds last 90 days. After that, you re-upload (build number incremented to 2, 3, etc.) and re-add to the group.

---

## Common gotchas

**Google OAuth in the wrapper.** When the app loads curi.nyc and the user taps "Sign in with Google," the OAuth redirect needs to come back into the webview. Two things to check:

- In Supabase → Auth → URL Configuration, add `https://curi.nyc/auth/callback` (you probably already have this) and `capacitor://localhost/auth/callback` if Capacitor uses its own scheme. Easier: keep the OAuth flow on the public URL and just make sure the webview's redirect chain doesn't get killed.
- Test sign-in on the simulator first. If it loops, check the **Safari Web Inspector**: in Xcode's simulator, open Safari on your Mac → Develop → Simulator → Curi → Console.

**Bundle ID conflicts.** If `com.curinyc.app` is taken by someone else (search the App Store first), pick a different one. The first time you sign in to Xcode with your team, the bundle ID is registered to you on the Apple Developer portal automatically.

**Privacy manifest.** As of iOS 17, Apple requires a privacy manifest declaring tracked APIs. Capacitor 6+ recent versions include a default manifest. If TestFlight processing complains about missing privacy declarations, run `npx cap sync ios` — it picks up the manifest from the plugin updates.

**Build numbers must be unique.** Each TestFlight upload increments the **Build** field (1 → 2 → 3). The Version stays at `0.1.0` until you ship a real new release.

**Beta App Review (only for External TestFlight).** If you want to invite anyone outside your Apple Developer team, you need to switch from Internal to External Testing. External requires a one-time **Beta App Review** by Apple (1–3 day turnaround). For your "send to a friend" use case, Internal Testing is fine and skips this entirely.

**Push notifications.** Not wired today. If you want them later, add `@capacitor/push-notifications`, configure Apple Push certificates in App Store Connect, and wire APNs through Supabase. Out of scope for first TestFlight.

---

## Realistic timeline

If you sit down at the Mac with everything installed and a 1024×1024 logo PNG:

- Steps 1–4 (Capacitor install + native plugins): **30 minutes**
- Steps 5–8 (Xcode signing + icons): **30 minutes**
- Steps 9–10 (test on simulator + phone): **20 minutes** plus debugging OAuth
- Steps 11–12 (archive + App Store Connect record): **30 minutes** (most of it waiting on Apple's processing)
- Steps 13–14 (TestFlight setup + friend installs): **15 minutes** plus Apple's email delivery

**Total: ~2–3 hours of active work**, spread over a half-day, gated by Apple's processing windows.

---

## Optional pre-work I can do for you

The codebase setup (steps 1–4) can be scaffolded right now: add Capacitor config to the repo, install plugins, create the iOS folder, push to main. The Xcode-side work (signing, archiving, App Store Connect) has to be done on your Mac since it requires GUI access and your Apple ID.
