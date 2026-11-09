import PorchKit
import PorchUI
import SwiftUI

/// Settings (DESIGN.md §7): account, signed-in devices, Flint pairing, Amazon,
/// appearance, sign out and delete account.
struct SettingsView: View {
    @Environment(ScreenServices.self) private var services
    @AppStorage(ThemePreference.storageKey) private var theme = ThemePreference.system
    @State private var deleting = false
    @State private var signingOut = false

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Signed in as") {
                    Text(accountLine)
                        .font(PorchFont.body)
                        .foregroundStyle(PorchColor.ink)
                        .textSelection(.enabled)
                }
                Button("Sign out") {
                    signingOut = true
                    Task {
                        await services.account.signOut()
                        signingOut = false
                    }
                }
                .disabled(signingOut)
            }

            NotificationsSection()

            DevicesSection()

            FlintSection()

            LiveActivitySection()

            AmazonSection()

            Section("Appearance") {
                Picker("Theme", selection: $theme) {
                    ForEach(ThemePreference.allCases) { Text($0.label).tag($0) }
                }
            }

            Section {
                Button("Delete account", role: .destructive) { deleting = true }
            } footer: {
                Text("Deletes your packages, devices and paired apps from Porchlight right away. This can't be undone.")
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(PorchColor.canvas)
        .porchChrome()
        .navigationTitle("Settings")
        .sheet(isPresented: $deleting) {
            DeleteAccountSheet()
        }
    }

    private var accountLine: String {
        guard let user = services.account.currentUser else { return "Not signed in" }
        if let email = user.email, !email.isEmpty { return email }
        return user.hasApple ? "Sign in with Apple" : "No email on file"
    }
}

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview {
    NavigationStack { SettingsView() }
        .environment(ScreenServices.preview())
        .environment(AmazonModel(api: PreviewAPI(), signedIn: { true }))
}
#endif
