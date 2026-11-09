import PorchKit
import PorchUI
import SwiftUI

/// Confirms deleting the account by asking for the word "delete" (DESIGN.md §7).
struct DeleteAccountSheet: View {
    @Environment(ScreenServices.self) private var services
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?

    private var confirmed: Bool { SettingsText.confirmsDelete(typed) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This deletes your packages, signed-in devices and paired apps from Porchlight right away. It can't be undone.")
                        .font(PorchFont.body)
                        .foregroundStyle(PorchColor.body)
                }
                Section {
                    TextField("Type \(SettingsText.deleteWord) to confirm", text: $typed)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .onSubmit { Task { await confirm() } }
                } footer: {
                    Text("Type \u{201C}\(SettingsText.deleteWord)\u{201D} to confirm.")
                }
                if let error {
                    Section { ErrorLine(error) }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .background(PorchColor.canvas)
            .porchChrome()
            .navigationTitle("Delete account")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Delete account", role: .destructive) { Task { await confirm() } }
                        .disabled(!confirmed || busy)
                }
            }
            .disabled(busy)
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 300)
        #endif
    }

    private func confirm() async {
        guard confirmed, !busy else { return }
        error = nil
        busy = true
        defer { busy = false }
        do {
            try await services.account.deleteAccount()
            dismiss()
        } catch {
            self.error = "Couldn't delete your account. \(ErrorText.sentence(error))"
        }
    }
}
