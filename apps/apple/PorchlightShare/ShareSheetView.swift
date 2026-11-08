import PorchKit
import PorchUI
import SwiftUI

/// The confirm sheet: the numbers found, each with its carrier, and one
/// button to track the selected ones. The extension doesn't bundle Geist, so
/// PorchFont falls back to the system font here.
struct ShareSheetView: View {
    let model: ShareModel

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(PorchColor.canvas)
                .navigationTitle("Add to Porchlight")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(isDone ? "Done" : "Cancel") { model.onFinish() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(trackTitle) { Task { await model.submit() } }
                            .disabled(!model.canSubmit)
                    }
                }
        }
        .tint(PorchColor.accent)
    }

    private var isDone: Bool {
        switch model.phase {
        case .signedOut, .nothingFound, .finished: true
        default: false
        }
    }

    private var trackTitle: String {
        model.selected.count > 1 ? "Track \(model.selected.count)" : "Track"
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
        case .signedOut:
            message("You're signed out", "Open Porchlight and sign in, then share again.")
        case .nothingFound:
            message("No tracking number found", "Copy the number and add it in Porchlight instead.")
        case .sending:
            ProgressView("Adding")
                .font(PorchFont.body)
        case let .finished(text):
            message("Done", text)
        case .choosing:
            numberList(error: nil)
        case let .failed(text):
            numberList(error: text)
        }
    }

    private func message(_ title: String, _ detail: String) -> some View {
        VStack(spacing: PorchSpacing.xs) {
            Text(title)
                .font(PorchFont.headingSmall)
                .foregroundStyle(PorchColor.ink)
            Text(detail)
                .font(PorchFont.body)
                .foregroundStyle(PorchColor.mute)
                .multilineTextAlignment(.center)
        }
        .padding(PorchSpacing.l)
    }

    private func numberList(error: String?) -> some View {
        List {
            if let error {
                Text(error)
                    .font(PorchFont.bodySmall)
                    .foregroundStyle(PorchColor.danger)
                    .listRowBackground(PorchColor.card)
            }
            Section {
                ForEach(model.numbers) { number in
                    Button { model.toggle(number) } label: { row(number) }
                        .listRowBackground(PorchColor.card)
                }
            } footer: {
                Text("Porchlight checks the carrier and adds each package to your list.")
                    .font(PorchFont.caption)
                    .foregroundStyle(PorchColor.mute)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func row(_ number: SharedNumber) -> some View {
        let isOn = model.selected.contains(number.id)
        return HStack(spacing: PorchSpacing.s) {
            Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isOn ? PorchColor.accent : PorchColor.mute)
            VStack(alignment: .leading, spacing: PorchSpacing.xxs) {
                Text(number.number)
                    .porchMono()
                    .foregroundStyle(PorchColor.ink)
                Text(number.carrier.displayName)
                    .font(PorchFont.caption)
                    .foregroundStyle(PorchColor.mute)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
