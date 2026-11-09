import Foundation

/// Reads the English phrases Amazon prints on Your Orders and the track page:
/// "Arriving tomorrow", "Now expected Nov 12 - Nov 14", "Arriving today 2 PM - 6 PM",
/// "Sunday, November 8", "2:55 PM". amazon.com only (SPEC §6, Scope).
///
/// Dates on these pages carry no year and times carry no zone: Amazon shows
/// them in the shopper's own zone, so they are read in `timeZone` and the year
/// is the one that puts the date closest to `now`.
public struct AmazonText: Sendable {
    public var now: Date
    public var timeZone: TimeZone

    public init(now: Date, timeZone: TimeZone) {
        self.now = now
        self.timeZone = timeZone
    }

    var today: CalendarDate { CalendarDate(now, in: timeZone) }

    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        return c
    }

    // MARK: ETA

    /// The ETA in a promise line, or nil when the line names none (a delivered
    /// package, "Return started", an empty string). Never guesses: a line with
    /// no date or time it can read gives nil.
    public func eta(_ line: String) -> ETA? {
        let s = Self.normalize(line)
        guard !s.isEmpty, !s.hasPrefix("delivered"), !s.contains("return"), !s.contains("refund") else { return nil }
        let dates = dateMentions(in: s)
        let times = Self.clockMentions(in: s)
        if !times.isEmpty {
            guard dates.count <= 1 else { return nil }
            let day = dates.first ?? today
            guard let start = instant(day, times[0]) else { return nil }
            let end = times.count > 1 ? instant(day, times[1]) : start
            guard let end, end >= start else { return nil }
            return .window(start: start, end: end)
        }
        switch dates.count {
        case 0: return nil
        case 1: return .day(start: dates[0], end: dates[0])
        default:
            let (a, b) = (dates[0], dates[dates.count - 1])
            return a <= b ? .day(start: a, end: b) : nil
        }
    }

    // MARK: Event dates and times

    /// "Sunday, November 8" or "November 8" → that date, year chosen near `now`.
    public func eventDate(_ text: String) -> CalendarDate? {
        let s = Self.normalize(text)
        if s == "today" { return today }
        if s == "yesterday" { return today.adding(days: -1) }
        return monthDays(in: s).first
    }

    /// The instant of an event on `day` at a clock text such as "2:55 PM".
    /// An empty clock gives the start of that day.
    public func eventInstant(_ day: CalendarDate, clock: String) -> Date? {
        let times = Self.clockMentions(in: Self.normalize(clock))
        return instant(day, times.first ?? (0, 0))
    }

    /// "Delivered November 7" / "Delivered today" / "Delivered yesterday" → that day.
    public func deliveredDay(_ line: String) -> CalendarDate? {
        let s = Self.normalize(line)
        guard s.hasPrefix("delivered") else { return nil }
        if s.contains("today") { return today }
        if s.contains("yesterday") { return today.adding(days: -1) }
        // A month-day date wins over its weekday: "Delivered Wednesday, October 28" can be weeks back.
        if let date = monthDays(in: s).first { return date }
        if let weekday = Self.weekdays.firstIndex(where: { s.contains($0) }) {
            // "Delivered Monday" means the most recent Monday.
            let target = weekday + 1
            let current = calendar.component(.weekday, from: now)
            let back = (current - target + 7) % 7
            return today.adding(days: -back)
        }
        return nil
    }

    // MARK: Pieces

    func instant(_ day: CalendarDate, _ clock: (hour: Int, minute: Int)) -> Date? {
        calendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: clock.hour, minute: clock.minute))
    }

    /// Every date the text names, in order: today, tomorrow, weekdays and month-day dates.
    func dateMentions(in s: String) -> [CalendarDate] {
        var found: [(offset: Int, date: CalendarDate)] = []
        for (word, days) in [("today", 0), ("tomorrow", 1)] {
            var search = s.startIndex..<s.endIndex
            while let r = s.range(of: word, range: search) {
                found.append((s.distance(from: s.startIndex, to: r.lowerBound), today.adding(days: days)))
                search = r.upperBound..<s.endIndex
            }
        }
        let month = Self.monthPattern
        for match in s.matches(of: month) {
            if let d = monthDay(String(match.output.1), Int(match.output.2) ?? 0, year: match.output.3.flatMap { Int($0) }) {
                found.append((s.distance(from: s.startIndex, to: match.range.lowerBound), d))
            }
        }
        // "Nov 12 - 14": a bare day after a range dash borrows the month before it.
        if let m = s.firstMatch(of: Self.rangeTailPattern), let first = monthDay(String(m.output.1), Int(m.output.2) ?? 0, year: nil),
           let tail = Int(m.output.3), let end = CalendarDate(year: first.year, month: first.month, day: tail) {
            found.append((s.distance(from: s.startIndex, to: m.range.upperBound), end))
        }
        // A weekday counts only when no month-day date follows it ("Monday, November 10").
        for (index, weekday) in Self.weekdays.enumerated() {
            var search = s.startIndex..<s.endIndex
            while let r = s.range(of: weekday, range: search) {
                let offset = s.distance(from: s.startIndex, to: r.lowerBound)
                let dated = found.contains { $0.offset > offset && $0.offset - offset < weekday.count + 4 }
                if !dated, isWord(s, r) { found.append((offset, upcoming(weekday: index + 1))) }
                search = r.upperBound..<s.endIndex
            }
        }
        return found.sorted { $0.offset < $1.offset }.map(\.date)
    }

    private func isWord(_ s: String, _ r: Range<String.Index>) -> Bool {
        if r.lowerBound > s.startIndex, s[s.index(before: r.lowerBound)].isLetter { return false }
        return true
    }

    /// The next date with this weekday (1 = Sunday), counting today, as
    /// "Arriving Sunday" on a Sunday would be said "Arriving today".
    func upcoming(weekday: Int) -> CalendarDate {
        let current = calendar.component(.weekday, from: now)
        let ahead = (weekday - current + 7) % 7
        return today.adding(days: ahead == 0 ? 7 : ahead)
    }

    func monthDays(in s: String) -> [CalendarDate] {
        s.matches(of: Self.monthPattern).compactMap {
            monthDay(String($0.output.1), Int($0.output.2) ?? 0, year: $0.output.3.flatMap { Int($0) })
        }
    }

    /// The date with this month and day whose year puts it closest to today.
    func monthDay(_ monthName: String, _ day: Int, year: Int?) -> CalendarDate? {
        guard let month = Self.monthNumber(monthName) else { return nil }
        if let year { return CalendarDate(year: year, month: month, day: day) }
        let t = today
        return [t.year - 1, t.year, t.year + 1]
            .compactMap { CalendarDate(year: $0, month: month, day: day) }
            .min { abs($0.dayNumber - t.dayNumber) < abs($1.dayNumber - t.dayNumber) }
    }

    static func clockMentions(in s: String) -> [(hour: Int, minute: Int)] {
        var out: [(Int, Int)] = []
        for m in s.matches(of: clockPattern) {
            guard var hour = Int(m.output.1), (1...12).contains(hour) else { continue }
            let minute = m.output.2.flatMap { Int($0) } ?? 0
            guard (0...59).contains(minute) else { continue }
            let pm = m.output.3 == "p"
            if hour == 12 { hour = pm ? 12 : 0 } else if pm { hour += 12 }
            out.append((hour, minute))
        }
        // Whole words only: "this afternoon" names no clock time.
        if s.firstMatch(of: #/\bnoon\b/#) != nil { out.append((12, 0)) }
        if s.firstMatch(of: #/\bmidnight\b/#) != nil { out.append((23, 59)) }
        return out
    }

    static func monthNumber(_ name: String) -> Int? {
        let key = String(name.prefix(3))
        return months.firstIndex(of: key).map { $0 + 1 }
    }

    /// Lowercased, dashes unified, "a.m." → "am", whitespace collapsed.
    static func normalize(_ s: String) -> String {
        var t = s.lowercased()
        for dash in ["\u{2013}", "\u{2014}", "\u{2012}"] { t = t.replacingOccurrences(of: dash, with: "-") }
        t = t.replacingOccurrences(of: "a.m.", with: "am").replacingOccurrences(of: "p.m.", with: "pm")
        return HTMLText.collapse(t)
    }

    static let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    static let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

    nonisolated(unsafe) static let monthPattern =
        #/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? (\d{1,2})\b(?:,? (\d{4}))?/#
    nonisolated(unsafe) static let rangeTailPattern =
        #/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2}) ?- ?(\d{1,2})\b/#
    nonisolated(unsafe) static let clockPattern = #/\b(\d{1,2})(?::(\d{2}))? ?([ap])m\b/#
}

// MARK: - Status

extension AmazonText {
    /// The normalized status for a headline such as "Out for delivery",
    /// "Shipped" or "Delivered today". nil when nothing matches.
    public static func status(_ headline: String) -> Status? {
        let s = normalize(headline)
        guard !s.isEmpty else { return nil }
        if s.contains("return") || s.contains("refund") { return .returned }
        if s.hasPrefix("delivered") || s == "delivered" || s.contains("package delivered") || s.contains("was delivered") { return .delivered }
        if s.contains("attempt") || s.contains("undeliverable") || s.contains("delayed") || s.contains("running late")
            || s.contains("problem") || s.contains("damaged") || s.contains("lost") || s.contains("unable to deliver")
            || s.contains("exception") { return .exception }
        if s.contains("pickup") || s.contains("pick up") { return .availableForPickup }
        if s.contains("out for delivery") || s.contains("driver is nearby") || s.contains("arriving soon") || s.contains("on its way to you today") { return .outForDelivery }
        if s.contains("label created") || s.contains("created a label") || s.contains("not yet shipped") || s.contains("preparing for shipment")
            || s == "ordered" || s.contains("not received the package") { return .labelCreated }
        if s.contains("shipped") || s.contains("in transit") || s.contains("on the way") || s.contains("arriv") || s.contains("depart")
            || s.contains("facility") || s.contains("processed") || s.contains("left the") || s.contains("appointment") { return .inTransit }
        return nil
    }

    /// The carrier Amazon names in "Shipped with UPS" or "Delivery facilitated by Amazon".
    public static func carrier(fromHeader header: String) -> Carrier? {
        let s = normalize(header)
        let name: Substring
        if let r = s.range(of: " with ") ?? s.range(of: " by ") ?? s.range(of: "carrier:") {
            name = s[r.upperBound...]
        } else {
            name = s[...]
        }
        let n = name.trimmingCharacters(in: .whitespaces)
        let table: [(String, Carrier)] = [
            ("amazon", .amazon), ("ups", .ups), ("usps", .usps), ("postal service", .usps), ("fedex", .fedex),
            ("dhl ecommerce", .dhlEcommerce), ("dhl", .dhl), ("ontrac", .ontrac), ("lasership", .lasership),
            ("uniuni", .uniuni), ("jitsu", .jitsu),
        ]
        return table.first { n.hasPrefix($0.0) }?.1
    }
}
