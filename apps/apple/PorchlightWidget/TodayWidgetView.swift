import PorchKit
import PorchUI
import SwiftUI
import WidgetKit

/// The Today widget in every family (DESIGN.md §9: system fonts at small
/// sizes, Geist for the package title, status color only on the dot).
struct TodayWidgetView: View {
    let entry: TodayEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .containerBackground(PorchColor.canvas, for: .widget)
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryInline:
            InlineView(state: entry.state)
        case .accessoryCircular:
            CircularView(state: entry.state)
        case .accessoryRectangular:
            RectangularView(state: entry.state)
        default:
            SystemView(state: entry.state, maxRows: maxRows)
        }
    }

    private var maxRows: Int {
        switch family {
        case .systemSmall: 2
        case .systemMedium: 3
        default: 6
        }
    }
}

// MARK: Home Screen

private struct SystemView: View {
    let state: TodayWidgetState
    let maxRows: Int
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch state {
        case .signedOut:
            Message(title: TodayWidgetText.signedOutTitle, message: TodayWidgetText.signedOutBody)
        case .failed:
            Message(title: TodayWidgetText.failedTitle, message: TodayWidgetText.failedBody)
        case let .loaded(content):
            list(content, stale: nil)
        case let .stale(content, _):
            list(content, stale: TodayWidgetText.staleLine(content, timeZone: .current))
        }
    }

    private func list(_ content: TodayWidgetContent, stale: String?) -> some View {
        VStack(alignment: .leading, spacing: PorchSpacing.xs) {
            Header(count: content.openCount)
            if content.rows.isEmpty {
                Text(content.summary)
                    .font(.subheadline)
                    .foregroundStyle(PorchColor.body)
            } else {
                ForEach(content.rows.prefix(maxRows)) { row in
                    if family == .systemSmall {
                        SmallRow(row: row)
                    } else {
                        Link(destination: row.url ?? URL(string: "porchlight://")!) { WideRow(row: row) }
                    }
                }
                if content.rows.count > maxRows {
                    Text("\(content.rows.count - maxRows) more")
                        .font(.caption)
                        .foregroundStyle(PorchColor.mute)
                }
            }
            Spacer(minLength: 0)
            if let stale {
                Text(stale)
                    .font(.caption2)
                    .foregroundStyle(PorchColor.mute)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(family == .systemSmall ? content.rows.first?.url : nil)
    }
}

/// "Today 3", the list's group header.
private struct Header: View {
    let count: Int

    var body: some View {
        HStack(spacing: PorchSpacing.xxs) {
            Text("Today")
            if count > 0 { Text("\(count)").monospacedDigit() }
        }
        .font(PorchFont.label)
        .foregroundStyle(PorchColor.mute)
        .accessibilityElement(children: .combine)
    }
}

/// Small family: title and ETA phrase, two lines.
private struct SmallRow: View {
    let row: TodayWidgetRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.xs) {
            StatusDot(row.status)
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title)
                    .font(.custom(PorchFont.Name.medium, size: 14, relativeTo: .subheadline))
                    .foregroundStyle(PorchColor.ink)
                    .lineLimit(1)
                Text(row.phrase)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(row.phraseMuted ? PorchColor.mute : PorchColor.body)
                    .lineLimit(1)
            }
        }
    }
}

/// Medium and large: the list row (DESIGN.md §6), title and phrase on one
/// line, status and carrier below.
private struct WideRow: View {
    let row: TodayWidgetRow
    @Environment(\.widgetFamily) private var family

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.xs) {
            StatusDot(row.status)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.title)
                        .font(PorchFont.rowTitle)
                        .foregroundStyle(PorchColor.ink)
                        .lineLimit(1)
                    Spacer(minLength: PorchSpacing.xs)
                    Text(row.phrase)
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(row.phraseMuted ? PorchColor.mute : PorchColor.body)
                        .lineLimit(1)
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(row.statusLine)
                        .font(.caption)
                        .foregroundStyle(PorchColor.mute)
                        .lineLimit(1)
                    if family == .systemLarge {
                        Spacer(minLength: PorchSpacing.xs)
                        CarrierBadge(row.carrier)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct Message: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: PorchSpacing.xxs) {
            Text(title)
                .font(.headline)
                .foregroundStyle(PorchColor.ink)
            Text(message)
                .font(.caption)
                .foregroundStyle(PorchColor.mute)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: Lock Screen

private struct InlineView: View {
    let state: TodayWidgetState

    var body: some View {
        Label(text, systemImage: "shippingbox")
    }

    private var text: String {
        switch state {
        case .signedOut: TodayWidgetText.signedOutTitle
        case .failed: TodayWidgetText.failedTitle
        case let .loaded(content), let .stale(content, _): content.summary
        }
    }
}

private struct CircularView: View {
    let state: TodayWidgetState

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "shippingbox")
                    .font(.caption)
                Text(state.content.map { "\($0.openCount)" } ?? "–")
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
        }
        .accessibilityLabel(Text(state.content?.summary ?? "Porchlight"))
        .widgetURL(state.content?.rows.first?.url)
    }
}

private struct RectangularView: View {
    let state: TodayWidgetState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch state {
            case .signedOut:
                Text("Porchlight").font(.headline)
                Text(TodayWidgetText.signedOutTitle).font(.caption)
            case .failed:
                Text("Porchlight").font(.headline)
                Text(TodayWidgetText.failedTitle).font(.caption)
            case let .loaded(content), let .stale(content, _):
                Label(content.summary, systemImage: "shippingbox")
                    .font(.headline)
                    .lineLimit(1)
                ForEach(content.rows.prefix(2)) { row in
                    Text("\(row.title) · \(row.phrase)")
                        .font(.caption)
                        .lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(state.content?.rows.first?.url)
    }
}

#Preview(as: .systemMedium) {
    TodayWidget()
} timeline: {
    TodayEntry(date: Date(), state: .loaded(TodaySample.content))
    TodayEntry(date: Date(), state: .signedOut)
}
