import Foundation

// ETA wording (DESIGN.md §6): the row's trailing phrase and the detail
// sentence. A port of etaPhrase / etaSentence in apps/web/src/packages/arrival.ts
// and the formatters in time.ts; keep them in step. Pure: every function takes
// `now` and the time zone.

/// The row's trailing ETA text. `muted` means show it in Mute: no date, or overdue.
public struct ETAPhrase: Hashable, Sendable {
    public var text: String
    public var muted: Bool

    public init(text: String, muted: Bool) {
        self.text = text
        self.muted = muted
    }
}

public enum ArrivalPhrases {
    /// "Today", "By 8:00 PM", "Tomorrow", "Thursday", "Nov 21", "Was due Nov 3",
    /// "No date yet", "Delivered 2:14 PM", "Delivered Tue", "Delivered Nov 3".
    public static func rowPhrase(_ pkg: Package, now: Date, timeZone: TimeZone) -> ETAPhrase {
        if pkg.status == .delivered { return ETAPhrase(text: deliveredPhrase(pkg, now: now, timeZone: timeZone), muted: false) }
        if pkg.status.isOut {
            let by = todayDeadline(pkg, now: now, timeZone: timeZone)
            return ETAPhrase(text: by.map { "By \($0)" } ?? "Today", muted: false)
        }
        guard let day = pkg.eta.deciding(in: timeZone) else { return ETAPhrase(text: "No date yet", muted: true) }
        let today = CalendarDate(now, in: timeZone)
        let offset = day.dayNumber - today.dayNumber
        if offset < 0 { return ETAPhrase(text: "Was due \(TimeWords.monthDay(day, today: today))", muted: true) }
        switch offset {
        case 0: return ETAPhrase(text: "Today", muted: false)
        case 1: return ETAPhrase(text: "Tomorrow", muted: false)
        case 2...6: return ETAPhrase(text: TimeWords.weekdayName(day), muted: false)
        default: return ETAPhrase(text: TimeWords.monthDay(day, today: today), muted: false)
        }
    }

    /// The detail view's sentence: "Arriving Thursday, Nov 12", "Arriving between
    /// Thursday, Nov 12 and Saturday, Nov 14", "Arriving today, 2:00 PM to 6:00 PM",
    /// "Delivered Tuesday at 2:14 PM", "No delivery date from UPS yet".
    public static func sentence(_ pkg: Package, now: Date, timeZone: TimeZone) -> String {
        let today = CalendarDate(now, in: timeZone)

        switch pkg.status {
        case .delivered:
            guard let at = pkg.deliveredAt else { return "Delivered" }
            let day = CalendarDate(at, in: timeZone)
            let offset = day.dayNumber - today.dayNumber
            let time = TimeWords.clockTime(at, timeZone: timeZone)
            switch offset {
            case 0: return "Delivered today at \(time)"
            case -1: return "Delivered yesterday at \(time)"
            case -6 ... -2: return "Delivered \(TimeWords.weekdayName(day)) at \(time)"
            default: return "Delivered \(TimeWords.monthDay(day, today: today)) at \(time)"
            }
        case .availableForPickup:
            return "Ready for pickup"
        case .outForDelivery:
            return todayDeadline(pkg, now: now, timeZone: timeZone).map { "Arriving today by \($0)" } ?? "Arriving today"
        default:
            break
        }

        guard let endDay = pkg.eta.deciding(in: timeZone) else {
            return "No delivery date from \(pkg.carrier.displayName) yet"
        }
        if endDay < today { return "Was due \(TimeWords.weekdayMonthDay(endDay, today: today))" }

        switch pkg.eta {
        case let .day(start, _?) where start != endDay:
            return "Arriving between \(dayWords(max(start, today), today: today)) and \(dayWords(endDay, today: today))"
        case let .window(start, end?):
            let startDay = CalendarDate(start, in: timeZone)
            if startDay != endDay {
                return "Arriving between \(dayWords(max(startDay, today), today: today)) and \(dayWords(endDay, today: today))"
            }
            let from = TimeWords.clockTime(start, timeZone: timeZone)
            let to = TimeWords.clockTime(end, timeZone: timeZone)
            if from != to { return "Arriving \(dayWords(endDay, today: today)), \(from) to \(to)" }
        default:
            break
        }
        return "Arriving \(dayWords(endDay, today: today))"
    }

    /// "Delivered 2:14 PM" today, "Delivered Tue" this week, else "Delivered Nov 3".
    static func deliveredPhrase(_ pkg: Package, now: Date, timeZone: TimeZone) -> String {
        guard let at = pkg.deliveredAt else { return "Delivered" }
        let today = CalendarDate(now, in: timeZone)
        let day = CalendarDate(at, in: timeZone)
        let offset = day.dayNumber - today.dayNumber
        if offset == 0 { return "Delivered \(TimeWords.clockTime(at, timeZone: timeZone))" }
        if (-6 ... -1).contains(offset) { return "Delivered \(TimeWords.weekdayShort(day))" }
        return "Delivered \(TimeWords.monthDay(day, today: today))"
    }

    /// The end of a timed window when it falls today, for "By 8:00 PM". A
    /// window with one bound uses that bound: the Swift ETA keeps an
    /// end-only value as its start (ETA.decode). Date-only ETAs have no time.
    static func todayDeadline(_ pkg: Package, now: Date, timeZone: TimeZone) -> String? {
        guard case let .window(start, end) = pkg.eta else { return nil }
        let deadline = end ?? start
        guard CalendarDate(deadline, in: timeZone) == CalendarDate(now, in: timeZone) else { return nil }
        return TimeWords.clockTime(deadline, timeZone: timeZone)
    }

    /// "today", "tomorrow", "Thursday, Nov 12".
    static func dayWords(_ day: CalendarDate, today: CalendarDate) -> String {
        switch day.dayNumber - today.dayNumber {
        case 0: "today"
        case 1: "tomorrow"
        default: TimeWords.weekdayMonthDay(day, today: today)
        }
    }
}

/// Date and time wording in US English, matching the web's `en-US` Intl output.
/// The apps are English only for v1.
public enum TimeWords {
    private static let utc = TimeZone(identifier: "UTC")!

    private static func format(_ date: Date, _ pattern: String, _ timeZone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = pattern
        return f.string(from: date)
    }

    private static func format(_ day: CalendarDate, _ pattern: String) -> String {
        format(day.utcMidnight, pattern, utc)
    }

    /// "Thursday"
    public static func weekdayName(_ day: CalendarDate) -> String { format(day, "EEEE") }

    /// "Tue"
    public static func weekdayShort(_ day: CalendarDate) -> String { format(day, "EEE") }

    /// "Nov 21", or "Jan 3, 2027" when the year differs from today's.
    public static func monthDay(_ day: CalendarDate, today: CalendarDate) -> String {
        format(day, day.year == today.year ? "MMM d" : "MMM d, yyyy")
    }

    /// "Thursday, Nov 12"
    public static func weekdayMonthDay(_ day: CalendarDate, today: CalendarDate) -> String {
        "\(weekdayName(day)), \(monthDay(day, today: today))"
    }

    /// "Sun, Nov 8" (timeline day headers).
    public static func shortDayHeader(_ day: CalendarDate, today: CalendarDate) -> String {
        "\(weekdayShort(day)), \(monthDay(day, today: today))"
    }

    /// "2:14 PM"
    public static func clockTime(_ date: Date, timeZone: TimeZone) -> String { format(date, "h:mm a", timeZone) }

    /// "Nov 8, 2026, 9:41 AM", for help tags.
    public static func fullDateTime(_ date: Date, timeZone: TimeZone) -> String { format(date, "MMM d, yyyy, h:mm a", timeZone) }

    /// "just now", "14 min ago", "3 h ago", "1 day ago", "2 days ago". Never
    /// rounds into a vaguer word (DESIGN.md §1). A time slightly in the future
    /// (clock skew) reads as "just now".
    public static func ago(_ date: Date, now: Date) -> String {
        let minutes = Int((now.timeIntervalSince(date) / 60).rounded(.down))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) h ago" }
        let days = hours / 24
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    /// "Checked 14 min ago", or "Not checked yet".
    public static func checked(_ lastCheckedAt: Date?, now: Date) -> String {
        lastCheckedAt.map { "Checked \(ago($0, now: now))" } ?? "Not checked yet"
    }
}
