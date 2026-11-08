import PorchKit
import SwiftUI

/// The carrier's name in 12pt mute text inside a 20pt chip with a Line2
/// hairline and 6pt radius (DESIGN.md §5). No logos or brand colors.
public struct CarrierBadge: View {
    public let carrier: Carrier

    public init(_ carrier: Carrier) { self.carrier = carrier }

    public var body: some View {
        Text(carrier.displayName)
            .font(PorchFont.caption)
            .foregroundStyle(PorchColor.mute)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(minHeight: 20)
            .overlay(
                RoundedRectangle(cornerRadius: PorchRadius.badge, style: .continuous)
                    .strokeBorder(PorchColor.line2, lineWidth: 1)
            )
    }
}

#Preview {
    HStack { ForEach([Carrier.ups, .usps, .dhlEcommerce], id: \.self) { CarrierBadge($0) } }
        .padding()
        .background(PorchColor.canvas)
}
