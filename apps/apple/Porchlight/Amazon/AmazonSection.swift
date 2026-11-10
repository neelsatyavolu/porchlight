import PorchKit
import PorchUI
import SwiftUI

/// Settings → Connected accounts → Amazon (SPEC §6, DESIGN.md §7).
struct AmazonSection: View {
    @Environment(AmazonModel.self) private var amazon

    var body: some View {
        Section {
            if amazon.connected {
                connectedRows
            } else if let elsewhere = amazon.elsewhere {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    let line = AmazonStatusText.elsewhere(elsewhere, now: context.date, timeZone: .current)
                    SettingsRow("Not connected on this device", detail: line.text, detailColor: line.isProblem ? PorchColor.warn : PorchColor.mute) {
                        Button("Connect") { amazon.signInShown = true }
                            .accessibilityLabel("Also connect Amazon on this device")
                    }
                }
            } else {
                SettingsRow("Not connected") {
                    Button("Connect Amazon") { amazon.signInShown = true }
                }
            }
        } header: {
            Text("Amazon")
        } footer: {
            Text(amazon.connected
                 ? "Porchlight reads Your Orders on this device every so often. Amazon can change its pages at any time, so this is best effort."
                 : amazon.elsewhere != nil
                 ? "You don't need to sign in here too. Connecting this device as well lets it check Amazon when the other one is off."
                 : "Sign in to Amazon once, on Amazon's own page. Your sign-in stays on this device and is never sent to Porchlight.")
        }
        .task { await amazon.reload() }
        // Re-enable "Import now" once the 15 minutes are up.
        .task(id: amazon.nextAllowedAt) {
            guard let next = amazon.nextAllowedAt else { return }
            try? await Task.sleep(for: .seconds(max(1, next.timeIntervalSinceNow)))
            await amazon.reload()
        }
    }

    @ViewBuilder private var connectedRows: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let line = AmazonStatusText.line(amazon.status, now: context.date, timeZone: .current)
            SettingsRow(
                amazon.running ? "Importing…" : "Connected on this device",
                detail: amazon.running ? nil : statusDetail(line),
                detailColor: line.isProblem ? PorchColor.warn : PorchColor.mute
            ) {
                if amazon.status.state == .needsSignIn {
                    Button("Sign in again") { amazon.signInShown = true }
                } else {
                    Button("Import now") { Task { await amazon.importIfDue() } }
                        .disabled(amazon.running || amazon.nextAllowedAt != nil)
                }
            }
        }
        SettingsRow("Disconnect Amazon", detail: "Signs Amazon out on this device. Packages already imported stay.") {
            DangerButton("Disconnect") { amazon.disconnectAsked = true }
        }
    }

    /// The status sentence, and when the next import can run if one just did.
    private func statusDetail(_ line: AmazonStatusText.Line) -> String {
        guard let next = amazon.nextAllowedAt else { return line.text }
        return line.text + " Porchlight checks Amazon at most every 15 minutes. Next check after \(next.formatted(date: .omitted, time: .shortened))."
    }
}

/// The Amazon Connect sheet and Disconnect question, for SettingsView to attach
/// outside its Form (see AmazonModel.signInShown).
struct AmazonPresentations: ViewModifier {
    @Environment(AmazonModel.self) private var amazon

    func body(content: Content) -> some View {
        @Bindable var amazon = amazon
        content
            .sheet(isPresented: $amazon.signInShown) {
                AmazonSignInSheet { Task { await amazon.didSignIn() } }
            }
            .confirmationDialog("Disconnect Amazon?", isPresented: $amazon.disconnectAsked) {
                Button("Disconnect", role: .destructive) { Task { await amazon.disconnect() } }
            } message: {
                Text("This signs Amazon out on this device. Packages already imported stay.")
            }
    }
}
