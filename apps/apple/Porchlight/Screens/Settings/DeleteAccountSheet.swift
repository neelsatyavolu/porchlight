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
    @FocusState private var fieldFocused: Bool

    private var confirmed: Bool { SettingsText.confirmsDelete(typed) }

    var body: some View {
        NavigationStack {
            ScrollView {
                // The consequence first, then what to do about it. The Mac shows no
                // title bar in a sheet, so the sheet names itself there.
                VStack(alignment: .leading, spacing: PorchSpacing.m) {
                    #if os(macOS)
                    Text("Delete account")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(PorchColor.ink)
                        .accessibilityAddTraits(.isHeader)
                    #endif
                    Text("This deletes your packages, devices and paired apps right away. It can't be undone.")
                        .font(PorchFont.body)
                        .foregroundStyle(PorchColor.body)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                        Text("Type \u{201C}\(SettingsText.deleteWord)\u{201D} to confirm.")
                            .font(PorchFont.body)
                            .foregroundStyle(PorchColor.ink)
                        TextField("Type \(SettingsText.deleteWord) to confirm", text: $typed, prompt: Text(verbatim: SettingsText.deleteWord).foregroundStyle(PorchColor.mute))
                            .labelsHidden()
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .font(PorchFont.body)
                            .porchInput(focused: fieldFocused)
                            .focused($fieldFocused)
                            .onSubmit { Task { await confirm() } }
                    }
                    if let error { ErrorLine(error) }
                }
                .padding(PorchSpacing.l)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(PorchColor.canvas)
            .porchChrome()
            .navigationTitle("Delete account")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .sheetActions(
                cancel: SheetButton("Cancel") { dismiss() },
                primary: SheetButton("Delete account", role: .destructive, disabled: !confirmed || busy) { Task { await confirm() } }
            )
            .disabled(busy)
            .onAppear { fieldFocused = true }
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
