import Foundation

// Arrival-day grouping (DESIGN.md §6). A port of groupOf / groupPackages in
// apps/web/src/packages/arrival.ts; keep the two in step. Pure: every function
// takes `now` and the time zone, so tests pin both.

public enum ArrivalGroupID: String, CaseIterable, Sendable, Hashable {
    case today, tomorrow, week, later, delivered

    public var label: String {
        switch self {
        case .today: "Today"
        case .tomorrow: "Tomorrow"
        case .week: "This week"
        case .later: "Later"
        case .delivered: "Delivered"
        }
    }
}

public struct ArrivalGroup: Identifiable, Hashable, Sendable {
    public var id: ArrivalGroupID
    public var packages: [Package]
    public var label: String { id.label }
}

public enum Arrival {
    /// Calendar days from today to the package's ETA day, or nil with no ETA.
    public static func etaOffset(_ pkg: Package, now: Date, timeZone: TimeZone) -> Int? {
        guard let day = pkg.eta.deciding(in: timeZone) else { return nil }
        return day.dayNumber - CalendarDate(now, in: timeZone).dayNumber
    }

    public static func group(of pkg: Package, now: Date, timeZone: TimeZone) -> ArrivalGroupID {
        if pkg.status == .delivered { return .delivered }
        if pkg.status.isOut { return .today }
        guard let offset = etaOffset(pkg, now: now, timeZone: timeZone) else { return .later }
        if offset <= 0 { return .today } // due today, or late and not delivered
        if offset == 1 { return .tomorrow }
        if offset <= 6 { return .week }
        return .later
    }

    /// Groups in display order; empty groups are left out. Does not filter
    /// archived packages: callers pass the list they want shown.
    public static func groups(_ packages: [Package], now: Date, timeZone: TimeZone) -> [ArrivalGroup] {
        let buckets = Dictionary(grouping: packages) { group(of: $0, now: now, timeZone: timeZone) }
        return ArrivalGroupID.allCases.compactMap { id in
            guard let list = buckets[id], !list.isEmpty else { return nil }
            let sorted = id == .delivered ? list.sorted(by: deliveredBefore) : list.sorted(by: openBefore)
            return ArrivalGroup(id: id, packages: sorted)
        }
    }

    /// Order inside an open group: problems pinned first, then out for
    /// delivery, then soonest ETA (no ETA last), then most recently updated.
    static func openBefore(_ a: Package, _ b: Package) -> Bool {
        let aProblem = a.status == .exception
        let bProblem = b.status == .exception
        if aProblem != bProblem { return aProblem }
        if a.status.isOut != b.status.isOut { return a.status.isOut }
        switch (a.eta.sortDate, b.eta.sortDate) {
        case (nil, _?): return false
        case (_?, nil): return true
        case let (ea?, eb?) where ea != eb: return ea < eb
        default: return a.updatedAt > b.updatedAt
        }
    }

    /// Newest delivery first; a delivered package with no time uses `updatedAt`.
    static func deliveredBefore(_ a: Package, _ b: Package) -> Bool {
        (a.deliveredAt ?? a.updatedAt) > (b.deliveredAt ?? b.updatedAt)
    }
}
