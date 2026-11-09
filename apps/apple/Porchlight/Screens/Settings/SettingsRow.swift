import PorchUI
import SwiftUI

/// One Settings row: a title, an optional line under it, and at most a button
/// or two on the trailing edge. Every Settings action is a bordered button in
/// this slot, so the rows line up and the buttons look alike.
struct SettingsRow<Actions: View>: View {
    let title: String
    var detail: String?
    var detailColor: Color = PorchColor.mute
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(spacing: PorchSpacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(PorchColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(detailColor)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            actions
                .buttonStyle(.bordered)
                .buttonBorderShape(.roundedRectangle(radius: PorchRadius.control))
        }
    }
}

extension SettingsRow where Actions == EmptyView {
    init(_ title: String, detail: String? = nil, detailColor: Color = PorchColor.mute) {
        self.init(title: title, detail: detail, detailColor: detailColor) { EmptyView() }
    }
}

extension SettingsRow {
    init(_ title: String, detail: String? = nil, detailColor: Color = PorchColor.mute, @ViewBuilder actions: () -> Actions) {
        self.init(title: title, detail: detail, detailColor: detailColor, actions: actions)
    }
}

/// A destructive Settings button in the Danger style (DESIGN.md §5): red text
/// on a hairline, the same as the Delete account sheet's button.
struct DangerButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(title, role: .destructive, action: action)
            .buttonStyle(.porchDanger)
    }
}
