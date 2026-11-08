import PorchKit
import PorchUI
import SwiftUI

/// Flint pairing (SPEC §7, DESIGN.md §7): a one-time ABCD-EFGH code with a
/// countdown, and the tokens Flint holds, with Revoke. While a code is live the
/// token list is checked every few seconds so it updates when Flint claims it.
struct FlintSection: View {
    @Environment(ScreenServices.self) private var services

    private static let pollInterval: Duration = .seconds(5)

    private enum Load {
        case loading
        case ready([APITokenInfo])
        case failed(String)
    }

    @State private var tokens = Load.loading
    @State private var pairing: PairingStartResponse?
    @State private var knownIds: Set<String>?
    @State private var starting = false
    @State private var revoking: String?
    @State private var error: String?

    var body: some View {
        Section {
            if let pairing { pairingView(pairing) }
            Button(pairing == nil ? "Pair Flint" : "Get a new code") { Task { await startPairing() } }
                .disabled(starting)
            if let error { ErrorLine(error) }
            tokenRows
        } header: {
            Text("Flint")
        } footer: {
            Text("Flint can add packages from your shipping mail. It sends only the carrier, tracking number, sender and subject, never the message itself.")
        }
        .task { await loadTokens() }
        .task(id: pairing?.code) { await watchForClaim() }
    }

    private func pairingView(_ pairing: PairingStartResponse) -> some View {
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
                    Text("In Flint, open Settings, then Connections, then Porchlight, and enter this code.")
                        .font(PorchFont.bodySmall)
                        .foregroundStyle(PorchColor.body)
                } else {
                    Text("This code has expired. Get a new one to pair Flint.")
                        .font(PorchFont.bodySmall)
                        .foregroundStyle(PorchColor.body)
                }
            }
            .padding(.vertical, PorchSpacing.xxs)
        }
    }

    @ViewBuilder
    private var tokenRows: some View {
        switch tokens {
        case .loading:
            Text("Loading paired apps").font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
        case let .failed(message):
            VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                Text("Couldn't load paired apps. \(message)").font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
                Button("Try again") { Task { await loadTokens() } }.buttonStyle(.borderless)
            }
        case let .ready(list) where list.isEmpty:
            Text("Nothing is paired yet.").font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
        case let .ready(list):
            TimelineView(.periodic(from: .now, by: 60)) { context in
                ForEach(list) { token in
                    HStack(spacing: PorchSpacing.s) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(token.label).font(PorchFont.rowTitle).foregroundStyle(PorchColor.ink)
                            Text(SettingsText.tokenMeta(token, now: context.date, timeZone: .current))
                                .font(PorchFont.bodySmall)
                                .monospacedDigit()
                                .foregroundStyle(PorchColor.mute)
                        }
                        Spacer()
                        Button("Revoke") { Task { await revoke(token) } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(revoking == token.id)
                            .accessibilityLabel("Revoke \(token.label)")
                    }
                }
            }
        }
    }

    // MARK: Actions

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

    private func startPairing() async {
        error = nil
        starting = true
        defer { starting = false }
        do {
            let response = try await services.api.startPairing()
            if case let .ready(list) = tokens { knownIds = Set(list.map(\.id)) } else { knownIds = nil }
            pairing = response
        } catch {
            self.error = "Couldn't start pairing. \(ErrorText.sentence(error))"
        }
    }

    /// While the code is live, a token id we haven't seen means Flint claimed it.
    private func watchForClaim() async {
        guard let pairing else { return }
        while !Task.isCancelled, pairing.expiresAt > Date() {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled, let list = await loadTokens() else { continue }
            if let seen = knownIds {
                if list.contains(where: { !seen.contains($0.id) }) {
                    self.pairing = nil
                    return
                }
            } else {
                knownIds = Set(list.map(\.id))
            }
        }
    }

    private func revoke(_ token: APITokenInfo) async {
        error = nil
        revoking = token.id
        defer { revoking = nil }
        do {
            try await services.api.deleteToken(id: token.id)
            if case let .ready(list) = tokens { tokens = .ready(list.filter { $0.id != token.id }) }
        } catch {
            if (error as? APIError)?.code == .notFound {
                await loadTokens()
            } else {
                self.error = "Couldn't revoke \(token.label). \(ErrorText.sentence(error))"
            }
        }
    }
}
