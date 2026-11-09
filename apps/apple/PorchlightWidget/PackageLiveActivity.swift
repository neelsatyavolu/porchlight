import ActivityKit
import PorchKit
import PorchUI
import SwiftUI
import WidgetKit

/// The Live Activity for an out-for-delivery package: the Lock Screen banner
/// and the Dynamic Island. The app starts, updates and ends it after each sync.
struct PackageLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PackageActivityAttributes.self) { context in
            LockScreenActivityView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(PorchColor.canvas)
                .activitySystemActionForegroundColor(PorchColor.ink)
                .widgetURL(context.attributes.url)
        } dynamicIsland: { context in
            let phrase = PackageActivityText.phrase(context.attributes, context.state, now: Date(), timeZone: .current)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "shippingbox")
                        .foregroundStyle(PorchColor.tone(context.state.status.tone))
                        .accessibilityLabel(Text(context.state.status.label))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(phrase.text)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(phrase.muted ? PorchColor.mute : PorchColor.ink)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(PorchFont.rowTitle)
                        .foregroundStyle(PorchColor.ink)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(PackageActivityText.statusLine(context.state))
                            .font(.caption)
                            .foregroundStyle(PorchColor.mute)
                            .lineLimit(1)
                        Spacer(minLength: PorchSpacing.xs)
                        CarrierBadge(context.attributes.carrier)
                    }
                }
            } compactLeading: {
                Image(systemName: "shippingbox")
                    .foregroundStyle(PorchColor.tone(context.state.status.tone))
                    .accessibilityLabel(Text(context.state.status.label))
            } compactTrailing: {
                Text(phrase.text)
                    .font(.caption)
                    .monospacedDigit()
                    .lineLimit(1)
                    .frame(maxWidth: 72)
            } minimal: {
                Image(systemName: "shippingbox")
                    .foregroundStyle(PorchColor.tone(context.state.status.tone))
                    .accessibilityLabel(Text("\(context.attributes.title), \(context.state.status.label)"))
            }
            .widgetURL(context.attributes.url)
            .keylineTint(PorchColor.accent)
        }
    }
}

/// The Lock Screen banner: the list row (DESIGN.md §6), larger.
private struct LockScreenActivityView: View {
    let attributes: PackageActivityAttributes
    let state: PackageActivityAttributes.ContentState

    var body: some View {
        let phrase = PackageActivityText.phrase(attributes, state, now: Date(), timeZone: .current)
        HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.s) {
            StatusDot(state.status)
            VStack(alignment: .leading, spacing: PorchSpacing.xxs) {
                HStack(alignment: .firstTextBaseline) {
                    Text(attributes.title)
                        .font(.custom(PorchFont.Name.medium, size: 17, relativeTo: .headline))
                        .foregroundStyle(PorchColor.ink)
                        .lineLimit(1)
                    Spacer(minLength: PorchSpacing.xs)
                    Text(phrase.text)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(phrase.muted ? PorchColor.mute : PorchColor.body)
                        .lineLimit(1)
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(PackageActivityText.statusLine(state))
                        .font(.footnote)
                        .foregroundStyle(PorchColor.mute)
                        .lineLimit(2)
                    Spacer(minLength: PorchSpacing.xs)
                    CarrierBadge(attributes.carrier)
                }
            }
        }
        .padding(PorchSpacing.m)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Lock Screen", as: .content, using: PackageActivityAttributes(packageId: "00000000-0000-4000-8000-000000000001", title: "Headphones", carrier: .ups)) {
    PackageLiveActivity()
} contentStates: {
    PackageActivityAttributes.ContentState(status: .outForDelivery, statusDetail: "On vehicle for delivery", eta: .none)
    PackageActivityAttributes.ContentState(status: .delivered, statusDetail: "Front door", eta: .none)
}
