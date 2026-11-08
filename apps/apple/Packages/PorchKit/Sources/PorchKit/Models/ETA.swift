import Foundation

/// A package's estimated delivery, exactly as the carrier gave it. Never computed
/// (SPEC goal 4).
///
/// Wire form (docs/API.md, the `etaDateOnly` contract): `etaStart`, `etaEnd` and
/// `etaDateOnly`. With `etaDateOnly: true` both are "YYYY-MM-DD" calendar dates
/// (the carrier's local delivery date, never shifted by time zone); with `false`
/// they are ISO 8601 instants.
public enum ETA: Hashable, Sendable {
    case none
    /// Date only. `end` is set for a multi-day range ("Nov 12 to Nov 14").
    case day(start: CalendarDate, end: CalendarDate?)
    /// A real time, or a time window.
    case window(start: Date, end: Date?)

    /// The calendar day that decides a package's arrival group: the end of the
    /// range, else its start (DESIGN.md §6). Date-only values keep their date in
    /// every zone; instants are read in `timeZone`.
    public func deciding(in timeZone: TimeZone) -> CalendarDate? {
        switch self {
        case .none: nil
        case let .day(start, end): end ?? start
        case let .window(start, end): CalendarDate(end ?? start, in: timeZone)
        }
    }

    /// The instant used only to order packages inside a group. Date-only values
    /// sort as midnight UTC, as the web does.
    public var sortDate: Date? {
        switch self {
        case .none: nil
        case let .day(start, end): (end ?? start).utcMidnight
        case let .window(start, end): end ?? start
        }
    }

    public var isDateOnly: Bool {
        if case .day = self { return true }
        return false
    }
}

extension ETA {
    /// Builds an ETA from the three wire fields. A value with only `etaEnd` is
    /// stored as a single-day/instant ETA starting there, which keeps the
    /// deciding day the same.
    static func decode<K: CodingKey>(
        from c: KeyedDecodingContainer<K>, start: K, end: K, dateOnly: K
    ) throws -> ETA {
        let isDateOnly = try c.decodeIfPresent(Bool.self, forKey: dateOnly) ?? false
        if isDateOnly {
            let s = try c.decodeIfPresent(CalendarDate.self, forKey: start)
            let e = try c.decodeIfPresent(CalendarDate.self, forKey: end)
            switch (s, e) {
            case (nil, nil): return .none
            case let (s?, e): return .day(start: s, end: e)
            case let (nil, e?): return .day(start: e, end: nil)
            }
        }
        let s = try c.decodeIfPresent(String.self, forKey: start).map { try WireDate.parse($0, codingPath: c.codingPath + [start]) }
        let e = try c.decodeIfPresent(String.self, forKey: end).map { try WireDate.parse($0, codingPath: c.codingPath + [end]) }
        switch (s, e) {
        case (nil, nil): return .none
        case let (s?, e): return .window(start: s, end: e)
        case let (nil, e?): return .window(start: e, end: nil)
        }
    }

    func encode<K: CodingKey>(to c: inout KeyedEncodingContainer<K>, start: K, end: K, dateOnly: K) throws {
        switch self {
        case .none:
            try c.encodeNil(forKey: start)
            try c.encodeNil(forKey: end)
            try c.encode(false, forKey: dateOnly)
        case let .day(s, e):
            try c.encode(s, forKey: start)
            try c.encode(e, forKey: end)
            try c.encode(true, forKey: dateOnly)
        case let .window(s, e):
            try c.encode(WireDate.format(s), forKey: start)
            try c.encode(e.map(WireDate.format), forKey: end)
            try c.encode(false, forKey: dateOnly)
        }
    }
}

extension ETA {
    /// The three wire fields as strings, for stores that keep them verbatim.
    public var wireFields: (start: String?, end: String?, dateOnly: Bool) {
        switch self {
        case .none: (nil, nil, false)
        case let .day(s, e): (s.description, e?.description, true)
        case let .window(s, e): (WireDate.format(s), e.map(WireDate.format), false)
        }
    }

    /// Rebuilds an ETA from `wireFields`. Values that don't parse are dropped.
    public init(wireStart: String?, wireEnd: String?, dateOnly: Bool) {
        if dateOnly {
            let s = wireStart.flatMap(CalendarDate.init(_:))
            let e = wireEnd.flatMap(CalendarDate.init(_:))
            if let first = s ?? e { self = .day(start: first, end: s == nil ? nil : e) } else { self = .none }
        } else {
            let s = wireStart.flatMap(WireDate.parse)
            let e = wireEnd.flatMap(WireDate.parse)
            if let first = s ?? e { self = .window(start: first, end: s == nil ? nil : e) } else { self = .none }
        }
    }
}
