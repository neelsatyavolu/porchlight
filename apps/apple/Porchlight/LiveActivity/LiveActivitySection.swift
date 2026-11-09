import SwiftUI
#if os(iOS)
import ActivityKit
#endif

/// Settings → Live Activities (iOS). Nothing on the Mac.
struct LiveActivitySection: View {
    #if os(iOS)
    @AppStorage(LiveActivityController.enabledKey) private var enabled = true
    #endif

    var body: some View {
        #if os(iOS)
        Section {
            Toggle("Out for delivery", isOn: $enabled)
                .onChange(of: enabled) { _, on in
                    if !on { Task { await LiveActivityController.endAll() } }
                }
        } header: {
            Text("Live Activities")
        } footer: {
            Text(footer)
        }
        #endif
    }

    #if os(iOS)
    private var footer: String {
        if !ActivityAuthorizationInfo().areActivitiesEnabled {
            return "Live Activities are off for Porchlight in the Settings app."
        }
        return "Shows a package on the Lock Screen and in the Dynamic Island while it's out for delivery. It updates when Porchlight syncs."
    }
    #endif
}
