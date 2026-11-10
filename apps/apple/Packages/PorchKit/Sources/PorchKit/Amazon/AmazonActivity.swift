import Foundation

/// Whether an Amazon delivery is close, so the Mac reads Amazon more often
/// (every 10 minutes instead of 30; AmazonImportCoordinator.isDueOnMac).
public enum AmazonActivity {
    /// "Close": out for delivery, due today (or overdue), or a delivery window starting within 18 hours.
    static let soon: TimeInterval = 18 * 60 * 60

    public static func isBusy(_ packages: [Package], now: Date, timeZone: TimeZone) -> Bool {
        let today = CalendarDate(now, in: timeZone)
        return packages.contains { pkg in
            guard pkg.source == .amazon || pkg.carrier == .amazon, !pkg.isArchived,
                  pkg.status != .delivered, pkg.status != .returned else { return false }
            if pkg.status == .outForDelivery { return true }
            switch pkg.eta {
            case let .day(start, _): return start.dayNumber <= today.dayNumber
            case let .window(start, _): return start.timeIntervalSince(now) <= soon
            case .none: return false
            }
        }
    }
}
