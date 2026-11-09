// Portions ported from universal-parcel-scraper (github.com/plhery/universal-parcel-scraper),
// Copyright its authors, Apache License 2.0: the US state time zone table
// (core/time/index.ts) and the USPS place patterns (carriers/usps/clock.ts).
// See THIRD_PARTY_NOTICES.md.
import Foundation

/// Time and text helpers shared by the device parsers (docs/research/scraping.md).
enum CarrierTime {
    /// The majority zone of each US state or territory, by postal code.
    static let usStateZones: [String: String] = [
        "AL": "America/Chicago", "AK": "America/Anchorage", "AZ": "America/Phoenix", "AR": "America/Chicago",
        "CA": "America/Los_Angeles", "CO": "America/Denver", "CT": "America/New_York", "DE": "America/New_York",
        "DC": "America/New_York", "FL": "America/New_York", "GA": "America/New_York", "HI": "Pacific/Honolulu",
        "ID": "America/Boise", "IL": "America/Chicago", "IN": "America/New_York", "IA": "America/Chicago",
        "KS": "America/Chicago", "KY": "America/New_York", "LA": "America/Chicago", "ME": "America/New_York",
        "MD": "America/New_York", "MA": "America/New_York", "MI": "America/Detroit", "MN": "America/Chicago",
        "MS": "America/Chicago", "MO": "America/Chicago", "MT": "America/Denver", "NE": "America/Chicago",
        "NV": "America/Los_Angeles", "NH": "America/New_York", "NJ": "America/New_York", "NM": "America/Denver",
        "NY": "America/New_York", "NC": "America/New_York", "ND": "America/Chicago", "OH": "America/New_York",
        "OK": "America/Chicago", "OR": "America/Los_Angeles", "PA": "America/New_York", "RI": "America/New_York",
        "SC": "America/New_York", "SD": "America/Chicago", "TN": "America/Chicago", "TX": "America/Chicago",
        "UT": "America/Denver", "VT": "America/New_York", "VA": "America/New_York", "WA": "America/Los_Angeles",
        "WV": "America/New_York", "WI": "America/Chicago", "WY": "America/Denver", "PR": "America/Puerto_Rico",
        "GU": "Pacific/Guam", "VI": "America/St_Thomas", "AS": "Pacific/Pago_Pago", "MP": "Pacific/Saipan",
    ]

    /// The zone of a US place as carriers write it: "EXAMPLE CITY, NY 10001",
    /// "MEMPHIS, TN" or "EXAMPLE CITY NV DISTRIBUTION CENTER". Nil when it names no state.
    static func usZone(for location: String?) -> TimeZone? {
        guard let location, !location.isEmpty else { return nil }
        let state: Substring?
        if let m = location.firstMatch(of: #/,\s*([A-Z]{2})\b/#) {
            state = m.1
        } else if let m = location.firstMatch(of: #/\s([A-Z]{2})\s*(?:\(USPS\)|(?:(?:NETWORK|REGIONAL|INTERNATIONAL)\s+)?DISTRIBUTION\s+CENTER|PACKAGE\s+SORTING\s+CENTER|PROCESSING\s+CENTER)$/#) {
            state = m.1
        } else {
            state = nil
        }
        return state.flatMap { usStateZones[String($0)] }.flatMap(TimeZone.init(identifier:))
    }

    static let gregorian = Calendar(identifier: .gregorian)

    /// A wall-clock time in `zone`. Nil for parts that don't name a real time.
    static func date(year: Int, month: Int, day: Int, hour: Int = 0, minute: Int = 0, second: Int = 0, in zone: TimeZone) -> Date? {
        guard CalendarDate(year: year, month: month, day: day) != nil, (0...23).contains(hour), (0...59).contains(minute),
              (0...59).contains(second) else { return nil }
        var calendar = gregorian
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second))
    }

    /// "+02:00", "-0500" or "Z" as a fixed zone.
    static func offsetZone(_ raw: String?) -> TimeZone? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        if raw == "Z" { return TimeZone(secondsFromGMT: 0) }
        guard let m = raw.wholeMatch(of: #/([+-])(\d{2}):?(\d{2})/#), let h = Int(m.2), let mm = Int(m.3), h <= 14, mm < 60 else { return nil }
        return TimeZone(secondsFromGMT: (m.1 == "-" ? -1 : 1) * (h * 3600 + mm * 60))
    }

    static let monthNames = [
        "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    ]

    /// 1...12 for a full or three-letter English month name, any case.
    static func month(named name: Substring) -> Int? {
        let lower = name.lowercased()
        guard lower.count >= 3 else { return nil }
        return monthNames.firstIndex { $0 == lower || $0.hasPrefix(lower) && lower.count == 3 }.map { $0 + 1 }
    }

    /// A 12-hour clock as a 24-hour hour, or nil.
    static func hour24(_ hour: Int, pm: Bool) -> Int? {
        guard (1...12).contains(hour) else { return nil }
        return hour % 12 + (pm ? 12 : 0)
    }
}

enum CarrierText {
    /// Collapses whitespace; nil when nothing is left.
    static func clean(_ s: String?) -> String? {
        guard let s else { return nil }
        let out = HTMLText.collapse(HTMLText.decodeEntities(s))
        return out.isEmpty ? nil : out
    }

    /// Drops the signatory a delivery scan names ("Delivered, Left with
    /// Individual. Signed for by J SMITH"): it is a person's name and Porchlight
    /// never stores it.
    static func withoutSignatory(_ s: String) -> String {
        guard let range = s.range(of: #"[.,;]?\s*signed for by\b.*$"#, options: [.regularExpression, .caseInsensitive]) else { return s }
        return String(s[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
    }

    /// The description an event is sent with: cleaned, without a signatory, at most 500 characters.
    static func eventDescription(_ s: String?) -> String? {
        guard let cleaned = clean(s) else { return nil }
        let out = withoutSignatory(cleaned)
        return out.isEmpty ? nil : String(out.prefix(500))
    }
}
