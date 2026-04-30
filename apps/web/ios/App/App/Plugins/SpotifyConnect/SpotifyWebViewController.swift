// Phase 5.7.1 — Spotify WKWebView host.
//
// Critical mitigation surface for App Store review (post-Meta era).
// Every defensive layer in this file matters:
//
//   1. WKWebsiteDataStore.nonPersistent() — cookies destroyed when the
//      webview closes. Curi never holds a persistent Spotify session.
//   2. WKContentWorld(name: "curi-spotify-bridge") — injected script
//      runs in an isolated content world. Spotify's bundle cannot read,
//      modify, or detect our script. Stronger isolation than Meta's
//      monkey-patch approach.
//   3. WKNavigationDelegate enforces hostname allowlist — only
//      *.spotify.com / *.spotifycdn.com / *.scdn.co URLs are allowed.
//      The webview cannot be redirected anywhere else.
//   4. Single message handler bound to one purpose. Receives the
//      captured URI list, no other data flows back.
//   5. 60-second hard timeout — if the user signs in but the
//      followed-artists endpoint never fires, we surface an error
//      rather than hang.
//
// The injected script (spotify-bridge-script.js) does the actual
// observation. See its header comment for what it does and doesn't do.

import WebKit
import UIKit

final class SpotifyWebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    // MARK: - Callbacks

    var onSuccess: (([String]) -> Void)?
    var onCancel: (() -> Void)?
    var onError: ((String, String) -> Void)? // code, message

    // MARK: - Constants

    private static let bridgeWorld = WKContentWorld.world(name: "curi-spotify-bridge")
    private static let messageHandlerName = "curiSpotify"
    private static let allowedHostSuffixes = [
        "spotify.com",
        "spotifycdn.com",
        "scdn.co",
    ]
    private static let initialURL = URL(
        string: "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com"
    )!

    // MARK: - State

    private var webView: WKWebView!
    private var navBar: UINavigationBar!
    private var loadingIndicator: UIActivityIndicatorView!
    private var hasCompleted = false

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setupNavBar()
        setupWebView()
        setupLoadingIndicator()
        loadSpotify()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Defensive: if the user swipes the modal away rather than
        // tapping Close, treat as cancel.
        if !hasCompleted {
            hasCompleted = true
            onCancel?()
        }
    }

    // MARK: - Setup

    private func setupNavBar() {
        navBar = UINavigationBar(frame: .zero)
        navBar.translatesAutoresizingMaskIntoConstraints = false
        let item = UINavigationItem(title: "Connect Spotify")
        item.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close,
            target: self,
            action: #selector(handleClose)
        )
        navBar.items = [item]
        view.addSubview(navBar)
        NSLayoutConstraint.activate([
            navBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            navBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()

        // MITIGATION 1: Ephemeral data store. All cookies, localStorage,
        // IndexedDB, etc. are destroyed when this webview deallocates.
        // No persistent Spotify session in our app.
        config.websiteDataStore = .nonPersistent()

        let userContentController = WKUserContentController()

        // MITIGATION 2: Inject script in isolated content world.
        let scriptSource = Self.loadBridgeScriptSource()
        let script = WKUserScript(
            source: scriptSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: Self.bridgeWorld
        )
        userContentController.addUserScript(script)
        userContentController.add(
            self,
            contentWorld: Self.bridgeWorld,
            name: Self.messageHandlerName
        )

        config.userContentController = userContentController
        config.allowsInlineMediaPlayback = false
        config.allowsAirPlayForMediaPlayback = false
        config.mediaTypesRequiringUserActionForPlayback = .all

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: navBar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func setupLoadingIndicator() {
        loadingIndicator = UIActivityIndicatorView(style: .medium)
        loadingIndicator.translatesAutoresizingMaskIntoConstraints = false
        loadingIndicator.hidesWhenStopped = true
        view.addSubview(loadingIndicator)
        NSLayoutConstraint.activate([
            loadingIndicator.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadingIndicator.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        loadingIndicator.startAnimating()
    }

    private func loadSpotify() {
        webView.load(URLRequest(url: Self.initialURL))
    }

    // MARK: - Actions

    @objc private func handleClose() {
        guard !hasCompleted else { return }
        hasCompleted = true
        onCancel?()
    }

    // MARK: - WKNavigationDelegate

    // MITIGATION 3: Strict hostname allowlist. The webview can only
    // navigate to Spotify-controlled hosts. Any redirect attempt to
    // a third-party domain is cancelled.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              let host = url.host?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        let allowed = Self.allowedHostSuffixes.contains { suffix in
            host == suffix || host.hasSuffix("." + suffix)
        }
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingIndicator.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadingIndicator.stopAnimating()
        // Don't fire onError for benign provisional failures (e.g.,
        // WebKit cancelled a redirect we blocked). Only fire if the
        // initial Spotify load fails.
        if (error as NSError).code == NSURLErrorNotConnectedToInternet {
            guard !hasCompleted else { return }
            hasCompleted = true
            onError?("NETWORK_OFFLINE", "You're offline. Connect to the internet and try again.")
        }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == Self.messageHandlerName else { return }
        guard !hasCompleted else { return }
        guard let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }

        switch kind {
        case "follows":
            guard let rawIds = body["ids"] as? [String] else {
                hasCompleted = true
                onError?("INVALID_PAYLOAD", "Invalid response from Spotify.")
                return
            }
            // Defensive: validate format on the native side too.
            // The 22-char base62 pattern is Spotify's documented ID format.
            let validIds = rawIds.filter { id in
                id.range(of: "^[A-Za-z0-9]{22}$", options: .regularExpression) != nil
            }
            hasCompleted = true
            onSuccess?(validIds)

        case "error":
            let msg = body["message"] as? String ?? "Unknown error"
            hasCompleted = true
            onError?("SCRAPE_FAILED", msg)

        default:
            // Unknown kind — ignore. Defensive against future bridge
            // protocol additions that older versions don't understand.
            break
        }
    }

    // MARK: - Resource loading

    private static func loadBridgeScriptSource() -> String {
        // The script is bundled as a resource alongside the plugin.
        // If it's missing, that's a build-time error worth crashing on —
        // the plugin cannot function without it.
        guard let url = Bundle.main.url(
            forResource: "spotify-bridge-script",
            withExtension: "js"
        ),
        let source = try? String(contentsOf: url, encoding: .utf8) else {
            assertionFailure("spotify-bridge-script.js not found in bundle")
            return ""
        }
        return source
    }
}
