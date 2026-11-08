import PorchKit
import PorchUI
import SwiftUI

/// Every signed-in session from `GET /v1/sessions`, with Sign out for the
/// others (DESIGN.md §7 Settings, "Devices"). This device has no button: the
/// Account section's Sign out covers it.
struct DevicesSection: View {
    @Environment(ScreenServices.self) private var services

    private enum Load {
        case loading
        case ready([SessionInfo])
        case failed(String)
    }

    @State private var state = Load.loading
    @State private var removing: String?
    @State private var error: String?

    var body: some View {
        Section {
            switch state {
            case .loading:
                Text("Loading your devices").font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
            case let .failed(message):
                VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                    Text("Couldn't load your devices. \(message)").font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
                    Button("Try again") { Task { await load() } }.buttonStyle(.borderless)
                }
            case let .ready(sessions):
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    ForEach(sessions) { row($0, now: context.date) }
                }
            }
            if let error { ErrorLine(error) }
        } header: {
            Text("Devices")
        } footer: {
            Text("Where your account is signed in. Signing a device out also stops its notifications.")
        }
        .task { await load() }
    }

    private func row(_ s: SessionInfo, now: Date) -> some View {
        let label = SettingsText.platformLabel(s.platform)
        return HStack(alignment: .center, spacing: PorchSpacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(PorchFont.rowTitle).foregroundStyle(PorchColor.ink)
                Text(SettingsText.sessionMeta(s, now: now, timeZone: .current))
                    .font(PorchFont.bodySmall)
                    .monospacedDigit()
                    .foregroundStyle(PorchColor.mute)
                    .help(TimeWords.fullDateTime(s.lastSeenAt, timeZone: .current))
            }
            Spacer()
            if !s.current {
                Button("Sign out") { Task { await signOut(s) } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(removing == s.id)
                    .accessibilityLabel("Sign out \(label)")
            }
        }
    }

    private func load() async {
        do {
            state = .ready(try await services.api.listSessions())
        } catch {
            if ErrorText.isUnauthorized(error) { return await services.account.signOut() }
            state = .failed(ErrorText.sentence(error))
        }
    }

    private func signOut(_ s: SessionInfo) async {
        error = nil
        removing = s.id
        defer { removing = nil }
        do {
            let result = try await services.api.deleteSession(id: s.id)
            if result.signedOut { return await services.account.signOut() }
            if case let .ready(list) = state { state = .ready(list.filter { $0.id != s.id }) }
        } catch {
            if (error as? APIError)?.code == .notFound {
                await load()
            } else if ErrorText.isUnauthorized(error) {
                await services.account.signOut()
            } else {
                self.error = "Couldn't sign out \(SettingsText.platformLabel(s.platform)). \(ErrorText.sentence(error))"
            }
        }
    }
}
