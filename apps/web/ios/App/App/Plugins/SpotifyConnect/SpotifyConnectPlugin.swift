// Phase 5.7.1 — Capacitor plugin: SpotifyConnect.
//
// Bridges JS calls (`SpotifyConnect.start()` / `.refresh()`) to the
// native WKWebView flow. Shows a SwiftUI consent screen first, then
// presents the Spotify webview, captures the URI list via the
// message handler, and resolves the Capacitor call with the IDs.
//
// Threading: all UI work is dispatched to .main. WKWebView and
// UIViewController operations are not thread-safe; bouncing through
// DispatchQueue.main is mandatory.
//
// Error contract:
//   - User cancels at consent or webview → call.reject("USER_CANCELLED")
//   - Capture timeout (60s) → call.reject("TIMEOUT")
//   - Other failures (network, parse) → call.reject("SCRAPE_FAILED")
// JS side maps these to user-friendly toast copy.

import Capacitor
import UIKit

@objc(SpotifyConnectPlugin)
public class SpotifyConnectPlugin: CAPPlugin {

    // MARK: - Public bridge methods

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.runFlow(mode: .connect, call: call)
        }
    }

    @objc func refresh(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.runFlow(mode: .refresh, call: call)
        }
    }

    // MARK: - Internal

    private enum Mode { case connect, refresh }

    private func runFlow(mode: Mode, call: CAPPluginCall) {
        guard let presenter = self.bridge?.viewController else {
            call.reject("NO_VIEW_CONTROLLER")
            return
        }

        // 1. Show native consent sheet first. Webview is only opened
        //    after explicit user consent — this is the App Store review
        //    handhold we documented in the spec § 1.5.
        let consent = SpotifyConsentViewController(mode: mode)
        consent.modalPresentationStyle = .formSheet

        consent.onCancel = { [weak consent] in
            consent?.dismiss(animated: true) {
                call.reject("USER_CANCELLED")
            }
        }

        consent.onContinue = { [weak self, weak consent, weak presenter] in
            consent?.dismiss(animated: true) {
                guard let self = self, let presenter = presenter else {
                    call.reject("NO_VIEW_CONTROLLER")
                    return
                }
                self.openWebView(from: presenter, call: call)
            }
        }

        presenter.present(consent, animated: true)
    }

    private func openWebView(from presenter: UIViewController, call: CAPPluginCall) {
        let webVC = SpotifyWebViewController()

        webVC.onSuccess = { [weak webVC] ids in
            webVC?.dismiss(animated: true) {
                call.resolve(["ids": ids])
            }
        }

        webVC.onCancel = { [weak webVC] in
            webVC?.dismiss(animated: true) {
                call.reject("USER_CANCELLED")
            }
        }

        webVC.onError = { [weak webVC] code, message in
            webVC?.dismiss(animated: true) {
                call.reject(code, code, nil, ["message": message])
            }
        }

        webVC.modalPresentationStyle = .fullScreen
        presenter.present(webVC, animated: true)
    }
}
