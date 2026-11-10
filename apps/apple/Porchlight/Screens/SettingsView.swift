import PorchKit
import PorchUI
import SwiftUI

/// Settings (DESIGN.md §7): account (sign out, delete account), signed-in
/// devices, Flint pairing, Amazon, appearance.
struct SettingsView: View {
    @Environment(ScreenServices.self) private var services
    @AppStorage(ThemePreference.storageKey) private var theme = ThemePreference.system
    @State private var deleting = false
    @State private var signingOut = false

    var body: some View {
        PorchForm {
            Section("Account") {
                SettingsRow(accountLine) {
                    Button("Sign out") {
                        signingOut = true
                        Task {
                            await services.account.signOut()
                            signingOut = false
                        }
                    }
                    .disabled(signingOut)
                }
                .textSelection(.enabled)
                // In Account, as DESIGN.md §7 lists it; on its own at the end
                // it read as part of Appearance.
                SettingsRow(
                    "Delete account",
                    detail: "Deletes your packages, devices and paired apps from Porchlight right away. This can't be undone."
                ) {
                    DangerButton("Delete…") { deleting = true }
                }
            }

            NotificationsSection()

            OpenAtLoginSection()

            DevicesSection()

            FlintSection()

            LiveActivitySection()

            AmazonSection()

            Section("Appearance") {
                Picker("Theme", selection: $theme) {
                    ForEach(ThemePreference.allCases) { Text($0.label).tag($0) }
                }
            }
        }
        .porchChrome()
        .navigationTitle("Settings")
        .sheet(isPresented: $deleting) {
            DeleteAccountSheet()
        }
        .modifier(AmazonPresentations())
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
