import Foundation

// The "Today" widget's content (SPEC §8): the Today group of the package list
// (DESIGN.md §6: out for delivery, due today, or late) followed by what was
// delivered today. Pure: built from packages, `now` and the time zone, so
// tests pin all three. The widget extension renders it as is.

/// One package line in the widget, with its text already worded.
public struct TodayWidgetRow: Identifiable, Hashable, Sendable, Codable {
    public var id: String
    /// `Package.displayTitle`.
    public var title: String
    /// "Out for delivery · On vehicle, Oakland" (PackageText.statusLine).
    public var statusLine: String
    /// The row's ETA phrase: "By 8:00 PM", "Today", "Was due Nov 3", "Delivered 2:14 PM".
    public var phrase: String
    /// Show `phrase` in Mute (no date, or overdue).
    public var phraseMuted: Bool
    public var status: Status
    public var carrier: Carrier

    public init(_ pkg: Package, now: Date, timeZone: TimeZone) {
        let phrase = ArrivalPhrases.rowPhrase(pkg, now: now, timeZone: timeZone)
        id = pkg.id
        title = pkg.displayTitle
        statusLine = PackageText.statusLine(pkg)
        self.phrase = phrase.text
        phraseMuted = phrase.muted
        status = pkg.status
        carrier = pkg.carrier
    }

    /// `porchlight://p/<id>`: tapping the row opens the package.
    public var url: URL? { PackageID.normalize(id).map { DeepLink.package(id: $0).url } }
}

public struct TodayWidgetContent: Hashable, Sendable, Codable {
    /// Open packages for today first (list order), then today's deliveries, newest first.
    public var rows: [TodayWidgetRow]
    public var outForDelivery: Int
    public var deliveredToday: Int
    /// When the packages were fetched.
    public var fetchedAt: Date

    public init(rows: [TodayWidgetRow], outForDelivery: Int, deliveredToday: Int, fetchedAt: Date) {
        self.rows = rows
        self.outForDelivery = outForDelivery
        self.deliveredToday = deliveredToday
        self.fetchedAt = fetchedAt
    }

    /// Archived packages are left out, as in the list.
    public static func make(_ packages: [Package], now: Date, timeZone: TimeZone) -> TodayWidgetContent {
        let live = packages.filter { !$0.isArchived }
        let groups = Arrival.groups(live, now: now, timeZone: timeZone)
        let open = groups.first { $0.id == .today }?.packages ?? []
        let today = CalendarDate(now, in: timeZone)
        let delivered = (groups.first { $0.id == .delivered }?.packages ?? []).filter { pkg in
            pkg.deliveredAt.map { CalendarDate($0, in: timeZone) == today } ?? false
        }
        return TodayWidgetContent(
            rows: (open + delivered).map { TodayWidgetRow($0, now: now, timeZone: timeZone) },
            outForDelivery: open.filter { $0.status == .outForDelivery }.count,
            deliveredToday: delivered.count,
            fetchedAt: now
        )
    }

    /// Rows still on their way (not yet delivered).
    public var openCount: Int { rows.count - deliveredToday }

    /// One line for the inline Lock Screen widget and the empty state.
    public var summary: String {
        if outForDelivery > 0 { return "\(outForDelivery) out for delivery" }
        if openCount > 0 { return openCount == 1 ? "1 package today" : "\(openCount) packages today" }
        if deliveredToday > 0 { return "\(deliveredToday) delivered today" }
        return "Nothing arriving today"
    }
}

/// When the widget asks for new data.
public enum TodayWidgetPolicy {
    public static let refreshInterval: TimeInterval = 30 * 60

    /// Every 30 min, and at the next local midnight so "Today" never shows
    /// yesterday's packages.
    public static func nextRefresh(after now: Date, timeZone: TimeZone) -> Date {
        let next = now.addingTimeInterval(refreshInterval)
        guard let midnight = nextMidnight(after: now, timeZone: timeZone) else { return next }
        return min(next, midnight)
    }

    /// The start of the next local day.
    public static func nextMidnight(after now: Date, timeZone: TimeZone) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.nextDate(after: now, matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime)
    }
}
