import Foundation

// Display text for packages (DESIGN.md §3, §6). A port of
// apps/web/src/packages/format.ts. Pure functions, used by the screens.

public enum PackageText {
    /// Our status label, then the carrier's own words when they add something.
    public static func statusLine(_ pkg: Package) -> String {
        let label = pkg.status.label
        guard let detail = pkg.statusDetail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty,
              detail.lowercased() != label.lowercased() else { return label }
        return "\(label) · \(detail)"
    }

    /// Case-insensitive match on the fields a person would type to find a package.
    public static func matches(_ pkg: Package, query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return true }
        let fields = [pkg.title, pkg.merchant, pkg.statusDetail, pkg.carrier.displayName, pkg.status.label, pkg.orderId]
        if fields.contains(where: { $0?.lowercased().contains(q) == true }) { return true }
        if pkg.items.contains(where: { $0.name.lowercased().contains(q) }) { return true }
        let compact = q.filter { !$0.isWhitespace && $0 != "-" }
        return !compact.isEmpty && pkg.trackingNumber.lowercased().contains(compact)
    }

    /// The carrier's public tracking page, or nil when we know of no stable URL.
    public static func trackingURL(_ carrier: Carrier, _ trackingNumber: String) -> URL? {
        let n = trackingNumber.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? trackingNumber
        let string: String? = switch carrier {
        case .usps: "https://tools.usps.com/go/TrackConfirmAction?tLabels=\(n)"
        case .ups: "https://www.ups.com/track?tracknum=\(n)"
        case .fedex: "https://www.fedex.com/fedextrack/?trknbr=\(n)"
        case .dhl: "https://www.dhl.com/us-en/home/tracking.html?tracking-id=\(n)&submit=1"
        case .amazon: "https://track.amazon.com/tracking/\(n)"
        case .ontrac, .lasership: "https://www.ontrac.com/tracking/?number=\(n)"
        case .dhlEcommerce, .uniuni, .jitsu, .other: nil
        }
        return string.flatMap(URL.init(string:))
    }

    /// One timeline event with its formatted time and meta line.
    public struct TimelineEntry: Hashable, Sendable, Identifiable {
        public var event: TrackEvent
        /// The description, with the town in it for a generic facility (EventWords).
        public var title: String
        /// "9:12 AM"
        public var time: String
        /// "Oakland, CA · 9:12 AM", or just the time with no location.
        public var meta: String
        public var id: String { event.id }
    }

    public struct TimelineDay: Hashable, Sendable, Identifiable {
        public var day: CalendarDate
        /// "Sun, Nov 8"
        public var label: String
        public var entries: [TimelineEntry]
        public var id: Int { day.dayNumber }
    }

    /// Events (already newest first) grouped by local day.
    public static func timelineDays(_ events: [TrackEvent], now: Date, timeZone: TimeZone) -> [TimelineDay] {
        let today = CalendarDate(now, in: timeZone)
        var days: [TimelineDay] = []
        for event in events {
            let day = CalendarDate(event.occurredAt, in: timeZone)
            let time = TimeWords.clockTime(event.occurredAt, timeZone: timeZone)
            let words = EventWords.describe(event.description, location: event.location)
            let place = words.placeInTitle ? nil : EventWords.place(event.location)
            let meta = place.map { "\($0) · \(time)" } ?? time
            let entry = TimelineEntry(event: event, title: words.title, time: time, meta: meta)
            if let last = days.last, last.day == day {
                days[days.count - 1].entries.append(entry)
            } else {
                days.append(TimelineDay(day: day, label: TimeWords.shortDayHeader(day, today: today), entries: [entry]))
            }
        }
        return days
    }

    /// "2 min" from a Retry-After in seconds; 2 min when the header is missing.
    public static func retryWait(_ seconds: TimeInterval?) -> String {
        "\(max(1, Int(((seconds ?? 120) / 60).rounded(.up)))) min"
    }

    /// The detail view's message when Refresh fails.
    public static func refreshErrorText(_ error: any Error) -> String {
        if let api = error as? APIError, case let .server(_, body, retryAfter) = api, body.code == .rateLimited {
            return "Checked recently. Try again in \(retryWait(retryAfter))"
        }
        return ErrorText.sentence(error)
    }
}

/// One sentence for a failed call, in the voice of DESIGN.md §7.
public enum ErrorText {
    public static func sentence(_ error: any Error) -> String {
        if let api = error as? APIError {
            switch api {
            case .network:
                return "Couldn't reach Porchlight. Check your connection and try again."
            case let .server(_, body, retryAfter):
                if body.code == .rateLimited { return "Too many tries. Try again in \(PackageText.retryWait(retryAfter))." }
                return body.message
            case .invalidResponse:
                return "Porchlight sent a reply this app can't read. Try again later."
            }
        }
        if error is PorchError { return "This part of the app isn't connected yet." }
        return "Something went wrong. Try again."
    }

    /// The session was refused: the app should go back to sign-in.
    public static func isUnauthorized(_ error: any Error) -> Bool {
        (error as? APIError)?.code == .unauthorized
    }
}
