import PorchKit
import PorchUI
import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Flint (SPEC §7, DESIGN.md §7). On the Mac, one "Connect Flint" button makes a
/// code, opens Flint with a flint: link, and watches the token list until Flint
/// claims it; Flint asks the person to confirm the account first. The code is
/// still there under "Use a code instead". Flint is a Mac app, so the iPhone
/// only explains where to connect it. Both list what is connected, with Revoke.
struct FlintSection: View {
    @Environment(ScreenServices.self) private var services

    private enum Load {
        case loading
        case ready([APITokenInfo])
        case failed(String)
    }

    @State private var tokens = Load.loading
    @State private var connect = FlintConnectState.idle
    @State private var showCode = false
    @State private var flintMissing = false
    @State private var revoking: String?
    @State private var error: String?

    var body: some View {
        Section {
            #if os(macOS)
            connectRows
            #else
            Text(FlintText.phoneNote).font(.subheadline).foregroundStyle(PorchColor.body)
            #endif
            if let error { ErrorLine(error) }
            tokenRows
        } header: {
            Text("Flint")
        } footer: {
            Text("Flint can add packages from your shipping mail. It sends only the carrier, tracking number, sender and subject, never the message itself.")
        }
        .task { await loadTokens() }
        .task(id: connect.isPolling) { await watchForFlint() }
    }

    // MARK: Mac: one button

    #if os(macOS)
    @ViewBuilder
    private var connectRows: some View {
        switch connect {
        case .idle, .failed:
            SettingsRow("Flint for Mac", detail: flintMissing ? FlintText.notInstalled : nil) {
                if flintMissing { Link(FlintText.getFlint, destination: FlintLink.downloadURL) }
                Button(FlintText.connectButton) { Task { await startConnect() } }
            }
            if case let .failed(message) = connect { ErrorLine(message) }
        case .starting:
            Text(FlintText.opening).foregroundStyle(PorchColor.mute)
        case let .waiting(attempt, stalled):
            VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                Text(stalled ? FlintText.stalled : FlintText.opening)
                    .foregroundStyle(stalled ? PorchColor.body : PorchColor.mute)
                HStack(spacing: PorchSpacing.xs) {
                    Text(FlintText.notOpening).font(.subheadline).foregroundStyle(PorchColor.mute)
                    Link(FlintText.getFlint, destination: FlintLink.downloadURL).font(.subheadline)
                }
                DisclosureGroup(FlintText.useCode, isExpanded: $showCode) { codeView(attempt.pairing) }
                    .font(.subheadline)
                if stalled {
                    Button(FlintText.retryButton) { Task { await startConnect() } }.buttonStyle(.bordered)
                }
            }
            .padding(.vertical, PorchSpacing.xxs)
        case let .connected(token):
            SettingsRow(FlintText.connected(token))
        }
    }

    private func codeView(_ pairing: PairingStartResponse) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = pairing.expiresAt.timeIntervalSince(context.date)
            VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                if left > 0 {
                    Text(pairing.code)
                        .porchMono(size: 22)
                        .foregroundStyle(PorchColor.ink)
                        .textSelection(.enabled)
                        .accessibilityLabel("Pairing code \(pairing.code.map(String.init).joined(separator: " "))")
                    Text("Expires in \(SettingsText.countdown(left))")
                        .font(PorchFont.caption)
                        .monospacedDigit()
                        .foregroundStyle(PorchColor.mute)
                    Text(FlintText.codeHelp).font(.subheadline).foregroundStyle(PorchColor.body)
                } else {
                    Text(FlintText.codeExpired).font(.subheadline).foregroundStyle(PorchColor.body)
                }
            }
            .padding(.top, PorchSpacing.xxs)
        }
    }

    private func startConnect() async {
        error = nil
        flintMissing = false
        showCode = false
        // Check Flint is installed before making a code nobody can claim.
        guard NSWorkspace.shared.urlForApplication(toOpen: FlintLink.pair(code: "XXXX-XXXX")) != nil else {
            flintMissing = true
            return
        }
        connect = .starting
        do {
            let existing = await loadTokens() ?? []
            let pairing = try await services.api.startPairing()
            let attempt = FlintConnectAttempt(pairing: pairing, existing: existing, startedAt: Date())
            connect = .waiting(attempt, stalled: false)
            NSWorkspace.shared.open(attempt.link())
        } catch {
            if ErrorText.isUnauthorized(error) { await services.account.signOut() }
            connect = .failed("Couldn't start connecting. \(ErrorText.sentence(error))")
        }
    }
    #endif

    /// While waiting for Flint, poll the token list; a new token means Flint claimed the code.
    private func watchForFlint() async {
        while !Task.isCancelled, connect.isPolling {
            try? await Task.sleep(for: FlintConnectAttempt.pollInterval)
            guard !Task.isCancelled, let list = await loadTokens() else { continue }
            connect = connect.polled(list, at: Date())
        }
    }

    // MARK: Connected apps

    @ViewBuilder
    private var tokenRows: some View {
        switch tokens {
        case .loading:
            Text("Loading connected apps").foregroundStyle(PorchColor.mute)
        case let .failed(message):
            SettingsRow("Couldn't load connected apps.", detail: message) {
                Button("Try again") { Task { await loadTokens() } }
            }
        case let .ready(list) where list.isEmpty:
            // On the Mac the Connect row above already says nothing is connected.
            #if os(iOS)
            Text("Nothing is connected yet.").foregroundStyle(PorchColor.mute)
            #else
            EmptyView()
            #endif
        case let .ready(list):
            // One timer per row, so the form draws a hairline between rows.
            ForEach(list) { token in
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    SettingsRow(token.label, detail: SettingsText.tokenMeta(token, now: context.date, timeZone: .current)) {
                        Button("Revoke") { Task { await revoke(token) } }
                            .disabled(revoking == token.id)
                            .accessibilityLabel("Revoke \(token.label)")
                    }
                }
            }
        }
    }

    @discardableResult
    private func loadTokens() async -> [APITokenInfo]? {
        do {
            let list = try await services.api.listTokens()
            tokens = .ready(list)
            return list
        } catch {
            if ErrorText.isUnauthorized(error) { await services.account.signOut() }
            tokens = .failed(ErrorText.sentence(error))
            return nil
        }
    }

    private func revoke(_ token: APITokenInfo) async {
        error = nil
        revoking = token.id
        defer { revoking = nil }
        do {
            try await services.api.deleteToken(id: token.id)
            if case let .ready(list) = tokens { tokens = .ready(list.filter { $0.id != token.id }) }
            if case let .connected(connected) = connect, connected.id == token.id { connect = .idle }
        } catch {
            if (error as? APIError)?.code == .notFound {
                await loadTokens()
            } else {
                self.error = "Couldn't revoke \(token.label). \(ErrorText.sentence(error))"
            }
        }
    }
}
