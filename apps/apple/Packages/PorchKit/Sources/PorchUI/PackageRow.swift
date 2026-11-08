import PorchKit
import SwiftUI

/// The list row (DESIGN.md §6 "Package row"):
///
///     ●  Headphones ............................ Today
///        Out for delivery · On vehicle, Oakland    [UPS]
///        Checked 14 min ago
///
/// `now` comes from the caller (a `TimelineView`) so the phrases stay current.
public struct PackageRow: View {
    public let package: Package
    public let now: Date
    public let timeZone: TimeZone
    public let showsChecked: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ package: Package, now: Date, timeZone: TimeZone = .current, showsChecked: Bool = true) {
        self.package = package
        self.now = now
        self.timeZone = timeZone
        self.showsChecked = showsChecked
    }

    public var body: some View {
        let phrase = ArrivalPhrases.rowPhrase(package, now: now, timeZone: timeZone)
        HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.s) {
            StatusDot(package.status)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: PorchSpacing.xxs) {
                line(alignment: .firstTextBaseline) {
                    Text(package.displayTitle)
                        .font(PorchFont.rowTitle)
                        .foregroundStyle(PorchColor.ink)
                        .lineLimit(stacked ? 2 : 1)
                    if !stacked { Spacer(minLength: PorchSpacing.xs) }
                    Text(phrase.text)
                        .font(PorchFont.bodySmall)
                        .monospacedDigit()
                        .foregroundStyle(phrase.muted ? PorchColor.mute : PorchColor.body)
                        .lineLimit(1)
                }
                line(alignment: .center) {
                    Text(PackageText.statusLine(package))
                        .font(PorchFont.bodySmall)
                        .foregroundStyle(PorchColor.mute)
                        .lineLimit(stacked ? 3 : 1)
                    if !stacked { Spacer(minLength: PorchSpacing.xs) }
                    CarrierBadge(package.carrier)
                }
                if showsChecked {
                    Text(TimeWords.checked(package.lastCheckedAt, now: now))
                        .font(PorchFont.caption)
                        .monospacedDigit()
                        .foregroundStyle(PorchColor.mute)
                }
            }
        }
        .padding(.vertical, PorchSpacing.xs)
        .frame(minHeight: PorchSpacing.rowMinHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// At accessibility text sizes the two halves of a line stack, so the
    /// title and status keep their words instead of truncating to a few letters.
    private var stacked: Bool { typeSize.isAccessibilitySize }

    private func line<Content: View>(alignment: VerticalAlignment, @ViewBuilder _ content: () -> Content) -> some View {
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: PorchSpacing.xxs))
            : AnyLayout(HStackLayout(alignment: alignment, spacing: PorchSpacing.xs))
        return layout { content() }
    }
}

#Preview {
    let now = Date()
    List {
        PackageRow(Package(id: "a", carrier: .ups, trackingNumber: "1Z999AA10123456784", title: "Headphones",
                           status: .outForDelivery, statusDetail: "On vehicle, Oakland", lastCheckedAt: now.addingTimeInterval(-840),
                           updatedAt: now), now: now)
        PackageRow(Package(id: "b", carrier: .usps, trackingNumber: "9400100000000000004784", status: .labelCreated,
                           updatedAt: now), now: now)
    }
    .listStyle(.plain)
}
