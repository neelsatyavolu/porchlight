import PorchKit
import PorchUI
import SwiftUI

/// Settings → Connected accounts → Amazon (SPEC §6, DESIGN.md §7).
struct AmazonSection: View {
    @Environment(AmazonModel.self) private var amazon
    @State private var signingIn = false
    @State private var confirmingDisconnect = false

    var body: some View {
        Section {
            if amazon.connected {
                connectedRows
            } else {
                Button("Connect Amazon") { signingIn = true }
            }
        } header: {
            Text("Amazon")
        } footer: {
            Text(amazon.connected
                 ? "Porchlight reads Your Orders on this device every so often. Amazon can change its pages at any time, so this is best effort."
                 : "Sign in to Amazon once, on Amazon's own page. Your sign-in stays on this device and is never sent to Porchlight.")
        }
        .task { await amazon.reload() }
        // Re-enable "Import now" once the 15 minutes are up.
        .task(id: amazon.nextAllowedAt) {
            guard let next = amazon.nextAllowedAt else { return }
            try? await Task.sleep(for: .seconds(max(1, next.timeIntervalSinceNow)))
            await amazon.reload()
        }
        .sheet(isPresented: $signingIn) {
            AmazonSignInSheet { Task { await amazon.didSignIn() } }
        }
        .confirmationDialog("Disconnect Amazon?", isPresented: $confirmingDisconnect) {
            Button("Disconnect", role: .destructive) { Task { await amazon.disconnect() } }
        } message: {
            Text("This signs Amazon out on this device. Packages already imported stay.")
        }
    }

    @ViewBuilder private var connectedRows: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let line = AmazonStatusText.line(amazon.status, now: context.date, timeZone: .current)
            Text(amazon.running ? "Importing…" : line.text)
                .font(PorchFont.bodySmall)
                .foregroundStyle(line.isProblem && !amazon.running ? PorchColor.warn : PorchColor.body)
        }
        if amazon.status.state == .needsSignIn {
            Button("Sign in again") { signingIn = true }
        }
        Button("Import now") { Task { await amazon.importIfDue() } }
            .disabled(amazon.running || amazon.nextAllowedAt != nil)
        if let next = amazon.nextAllowedAt, !amazon.running {
            Text("Porchlight checks Amazon at most every 15 minutes. Next check after \(next.formatted(date: .omitted, time: .shortened)).")
                .font(PorchFont.caption)
                .foregroundStyle(PorchColor.mute)
        }
        Button("Disconnect", role: .destructive) { confirmingDisconnect = true }
    }
}
