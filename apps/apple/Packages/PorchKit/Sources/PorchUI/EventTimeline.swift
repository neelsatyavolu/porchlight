import PorchKit
import SwiftUI

/// The detail timeline (DESIGN.md §6 "Timeline"): newest first, grouped by
/// local day, an 8pt dot on a 1pt Line2 rail. The newest dot takes the
/// package's status tone; older dots are Stone.
public struct EventTimeline: View {
    public let days: [PackageText.TimelineDay]
    public let newestStatus: Status

    public init(days: [PackageText.TimelineDay], newestStatus: Status) {
        self.days = days
        self.newestStatus = newestStatus
    }

    private var newestId: String? { days.first?.entries.first?.id }
    /// Centers the dot on the first line of the description at any text size.
    @ScaledMetric(relativeTo: .body) private var dotTop: CGFloat = 7

    public var body: some View {
        VStack(alignment: .leading, spacing: PorchSpacing.m) {
            ForEach(days) { day in
                VStack(alignment: .leading, spacing: 0) {
                    Text(day.label)
                        .font(PorchFont.label)
                        .foregroundStyle(PorchColor.mute)
                        .frame(minHeight: 32, alignment: .leading)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(day.entries) { entry in
                        row(entry, isNewest: entry.id == newestId, isLast: entry.id == day.entries.last?.id)
                    }
                }
            }
        }
    }

    private func row(_ entry: PackageText.TimelineEntry, isNewest: Bool, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: PorchSpacing.s) {
            ZStack(alignment: .top) {
                if !isLast {
                    Rectangle().fill(PorchColor.line2).frame(width: 1).padding(.top, dotTop + 7)
                }
                Circle()
                    .fill(isNewest ? PorchColor.tone(newestStatus.tone) : PorchColor.stone)
                    .frame(width: 8, height: 8)
                    .padding(.top, dotTop)
            }
            .frame(width: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(PorchFont.body)
                    .foregroundStyle(isNewest ? PorchColor.ink : PorchColor.body)
                    .fixedSize(horizontal: false, vertical: true)
                Text(entry.meta)
                    .font(PorchFont.bodySmall)
                    .monospacedDigit()
                    .foregroundStyle(PorchColor.mute)
            }
            .padding(.bottom, PorchSpacing.s)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
