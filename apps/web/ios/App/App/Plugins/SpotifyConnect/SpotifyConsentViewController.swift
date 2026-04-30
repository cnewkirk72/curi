// Phase 5.7.1 — Native consent screen shown before the Spotify webview.
//
// SwiftUI sheet with explicit copy describing what Curi will and
// won't read. Required for App Store review compliance with
// Guideline 5.1.2 (data collection consent). The user must tap
// Continue before the webview is ever opened.
//
// Mode toggles minor copy variations (Connect vs Refresh) but the
// data-collection disclosure is identical in both flows — refreshing
// is the same data scope as connecting.

import SwiftUI
import UIKit

final class SpotifyConsentViewController: UIViewController {

    enum Mode {
        case connect
        case refresh
    }

    private let mode: Mode
    var onCancel: (() -> Void)?
    var onContinue: (() -> Void)?

    init(mode: Mode) {
        self.mode = mode
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let host = UIHostingController(
            rootView: ConsentScreen(
                mode: mode,
                onCancel: { [weak self] in self?.onCancel?() },
                onContinue: { [weak self] in self?.onContinue?() }
            )
        )
        host.view.backgroundColor = .clear

        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }
}

private struct ConsentScreen: View {
    let mode: SpotifyConsentViewController.Mode
    let onCancel: () -> Void
    let onContinue: () -> Void

    private var heading: String {
        switch mode {
        case .connect: return "Connect your Spotify"
        case .refresh: return "Refresh your Spotify follows"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(heading)
                    .font(.title2)
                    .fontWeight(.semibold)
                    .padding(.top, 24)

                Text("Curi will open Spotify in a window inside the app. You sign in to your Spotify account using Spotify's own login — Curi never sees your password.")
                    .font(.body)
                    .foregroundColor(.secondary)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Once signed in, Curi reads:")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    BulletRow(text: "The list of artists you follow on Spotify", color: .green)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Curi does NOT read:")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    BulletRow(text: "Your password or login credentials", color: .red)
                    BulletRow(text: "Your playlists or listening history", color: .red)
                    BulletRow(text: "Payment information", color: .red)
                    BulletRow(text: "Any other Spotify data", color: .red)
                }

                Text("Your Spotify session is cleared when the window closes. Curi saves only the list of artist IDs to rank events in your feed.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .padding(.top, 8)

                Spacer(minLength: 24)

                HStack(spacing: 12) {
                    Button(action: onCancel) {
                        Text("Cancel")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)

                    Button(action: onContinue) {
                        Text("Continue")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .fontWeight(.semibold)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.118, green: 0.843, blue: 0.376)) // #1ED760 Spotify green
                }
                .padding(.bottom, 16)
            }
            .padding(.horizontal, 24)
        }
    }
}

private struct BulletRow: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .padding(.top, 6)
            Text(text)
                .font(.subheadline)
                .foregroundColor(.primary)
            Spacer()
        }
    }
}
