import Foundation

/// A calendar date with no time and no time zone, written "YYYY-MM-DD" on the
/// wire. Used for date-only ETAs (`etaDateOnly: true`): the carrier's local
/// delivery date, which must never shift with the viewer's zone.
public struct CalendarDate: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    /// Returns nil unless the parts name a real Gregorian date.
    public init?(year: Int, month: Int, day: Int) {
        guard (1...9999).contains(year), (1...12).contains(month), day >= 1,
              day <= CalendarDate.daysIn(month: month, year: year) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    /// Parses exactly "YYYY-MM-DD".
    public init?(_ string: String) {
        let parts = string.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        self.init(year: y, month: m, day: d)
    }

    /// The date with this day number (days since 1970-01-01).
    public init(dayNumber: Int) {
        // Howard Hinnant's civil_from_days.
        let z = dayNumber + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        self.year = yoe + era * 400 + (m <= 2 ? 1 : 0)
        self.month = m
        self.day = d
    }

    /// The calendar day of an instant as seen in `timeZone`.
    public init(_ date: Date, in timeZone: TimeZone) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        self.year = c.year ?? 1970
        self.month = c.month ?? 1
        self.day = c.day ?? 1
    }

    /// Whole days since 1970-01-01. Subtracting two gives a calendar-day
    /// difference that DST can't skew.
    public var dayNumber: Int {
        // Howard Hinnant's days_from_civil.
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = month > 2 ? month - 3 : month + 9
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// Midnight UTC of this date. Only for ordering against instants; never
    /// for deciding which day something falls on.
    public var utcMidnight: Date {
        Date(timeIntervalSince1970: TimeInterval(dayNumber) * 86_400)
    }

    public func adding(days: Int) -> CalendarDate { CalendarDate(dayNumber: dayNumber + days) }

    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    public static func < (a: CalendarDate, b: CalendarDate) -> Bool { a.dayNumber < b.dayNumber }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        let raw = try c.decode(String.self)
        guard let date = CalendarDate(raw) else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Expected YYYY-MM-DD, got \(raw)")
        }
        self = date
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(description)
    }

    private static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 2: (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        case 4, 6, 9, 11: 30
        default: 31
        }
    }
}
