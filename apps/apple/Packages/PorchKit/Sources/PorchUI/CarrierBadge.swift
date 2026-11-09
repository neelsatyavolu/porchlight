import PorchKit
import SwiftUI

/// The carrier's name in 12pt mute text inside a 20pt chip with a Line2
/// hairline and 6pt radius (DESIGN.md §5). No logos or brand colors.
public struct CarrierBadge: View {
    public let carrier: Carrier
    /// On a selected (accent-filled) row the chip turns white, like the row's text.
    @Environment(\.backgroundProminence) private var prominence

    public init(_ carrier: Carrier) { self.carrier = carrier }

    private var selected: Bool { prominence == .increased }

    public var body: some View {
        Text(carrier.displayName)
            .font(PorchFont.caption)
            .foregroundStyle(selected ? Color.white : PorchColor.mute)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(minHeight: 20)
            .overlay(
                RoundedRectangle(cornerRadius: PorchRadius.badge, style: .continuous)
                    .strokeBorder(selected ? Color.white.opacity(0.6) : PorchColor.line2, lineWidth: 1)
            )
    }
}

#Preview {
    HStack { ForEach([Carrier.ups, .usps, .dhlEcommerce], id: \.self) { CarrierBadge($0) } }
        .padding()
        .background(PorchColor.canvas)
}
