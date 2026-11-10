import PorchUI
import SwiftUI

/// Settings → Background (Mac): open Porchlight at login, so it keeps checking
/// Amazon and carrier pages, and the notifications keep coming, without being opened.
struct OpenAtLoginSection: View {
    #if os(macOS)
    @State private var isOn = LoginItem.isOn
    @State private var error: String?
    #endif

    var body: some View {
        #if os(macOS)
        Section {
            Toggle("Open at login", isOn: Binding(get: { isOn }, set: change))
            if let error { ErrorLine(error) }
        } header: {
            Text("Background")
        } footer: {
            Text("Porchlight checks Amazon and carrier pages while it runs, every 10 minutes when a delivery is close. Closing the window keeps it in the menu bar.")
        }
        #endif
    }

    #if os(macOS)
    private func change(_ on: Bool) {
        error = nil
        do {
            try LoginItem.set(on)
        } catch {
            self.error = "Couldn't change this. Turn it on in System Settings, General, Login Items."
        }
        isOn = LoginItem.isOn
    }
    #endif
}
