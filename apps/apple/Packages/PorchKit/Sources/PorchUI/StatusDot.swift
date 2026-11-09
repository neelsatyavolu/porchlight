import PorchKit
import SwiftUI

/// The 8pt status dot (DESIGN.md §4). Filled in the status tone; a hollow ring
/// for label created and unknown. Alone it carries the label as its accessible
/// name; `withLabel` shows the text beside it.
public struct StatusDot: View {
    public let status: Status
    public let withLabel: Bool
    /// `.increased` on a selected (accent-filled) row: every tone turns white,
    /// since blue vanishes on the accent and green and amber lose their contrast.
    @Environment(\.backgroundProminence) private var prominence

    public init(_ status: Status, withLabel: Bool = false) {
        self.status = status
        self.withLabel = withLabel
    }

    public var body: some View {
        if withLabel {
            HStack(spacing: PorchSpacing.xs) {
                dot.accessibilityHidden(true)
                Text(status.label).font(PorchFont.body).foregroundStyle(PorchColor.ink)
            }
        } else {
            dot.accessibilityLabel(Text(status.label))
        }
    }

    @ViewBuilder private var dot: some View {
        let color = prominence == .increased ? Color.white : PorchColor.tone(status.tone)
        if status.isPending {
            Circle().strokeBorder(color, lineWidth: 1.5).frame(width: 8, height: 8)
        } else {
            Circle().fill(color).frame(width: 8, height: 8)
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 12) {
        ForEach(Status.allCases, id: \.self) { StatusDot($0, withLabel: true) }
    }
    .padding()
    .background(PorchColor.canvas)
}
