import PorchKit
import PorchUI
import SwiftUI

/// Settings → Notifications: whether Porchlight may notify, and a way to turn it on.
struct NotificationsSection: View {
    /// Optional, as in AddPackageView, so previews without push still render.
    @Environment(PushController.self) private var push: PushController?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if let push { section(push) }
    }

    private func section(_ push: PushController) -> some View {
        Section {
            switch push.authorization {
            case .authorized, .provisional, .ephemeral:
                Text("On. Porchlight tells you when a package is out for delivery, delivered, or has a problem.")
                    .font(PorchFont.bodySmall)
                    .foregroundStyle(PorchColor.body)
            case .notDetermined:
                Button("Turn on notifications") { Task { await push.turnOn() } }
            case .denied:
                Text("Off. Turn them on to hear when a package is out for delivery or delivered.")
                    .font(PorchFont.bodySmall)
                    .foregroundStyle(PorchColor.body)
                Button(openSettingsLabel) { Task { await push.turnOn() } }
            }
        } header: {
            Text("Notifications")
        }
        .task { await push.checkAuthorization() }
        // Back from System Settings: show the new answer.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await push.checkAuthorization() } }
        }
    }

    private var openSettingsLabel: String {
        #if os(macOS)
        "Open System Settings"
        #else
        "Open Settings"
        #endif
    }
}
