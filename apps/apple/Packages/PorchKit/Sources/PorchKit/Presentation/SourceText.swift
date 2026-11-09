import Foundation

/// Where a package's status came from, and what to say when a device has to
/// read it (docs/API.md "Data source" and "Device tracking"). Mirrors
/// apps/web/src/packages/provenance.ts, except `deviceHint`: in the app the
/// person is already on a device, so it explains rather than asks.
public enum SourceText {
    /// A device carrier with no read for this long gets the hint.
    public static let deviceStaleAfter: TimeInterval = 3 * 60 * 60

    private static let devices = "your Mac or iPhone"

    private static func pageOwner(_ carrier: Carrier) -> String {
        carrier == .other ? "the carrier's" : "\(carrier.displayName)'s"
    }

    /// "From UPS's tracking page, checked on your Mac or iPhone 12 min ago.", or nil before any read.
    public static func sourceLine(_ pkg: Package, now: Date) -> String? {
        let when = pkg.lastCheckedAt.map { " \(TimeWords.ago($0, now: now))" } ?? ""
        switch pkg.dataSource {
        case .device: return "From \(pageOwner(pkg.carrier)) tracking page, checked on \(devices)\(when)."
        case .web: return "From \(pageOwner(pkg.carrier)) tracking page, checked by Porchlight\(when)."
        case .api: return "From \(pageOwner(pkg.carrier)) tracking API, checked\(when)."
        case .aggregator: return "From Ship24, checked\(when)."
        case .amazon: return "From your Amazon orders, checked on \(devices)\(when)."
        case nil: return nil
        }
    }

    /// True when the next read belongs to a native app, not the server.
    public static func readsOnDevice(_ pkg: Package) -> Bool {
        pkg.carrier == .ups ? pkg.dataSource == .device : pkg.carrier.isDeviceCarrier
    }

    /// Shown for a live USPS, UPS or FedEx package that no device has read lately.
    public static func deviceHint(_ pkg: Package, now: Date) -> String? {
        guard pkg.carrier.isDeviceCarrier, pkg.status != .delivered, !pkg.isArchived else { return nil }
        if let checked = pkg.lastCheckedAt, now.timeIntervalSince(checked) < deviceStaleAfter { return nil }
        return "\(pkg.carrier.displayName) packages update while Porchlight is open on \(devices)."
    }

    /// The note after a refresh was queued.
    public static func refreshText(_ pkg: Package) -> String {
        let carrier = pkg.carrier.displayName
        return readsOnDevice(pkg)
            ? "Asked for a new \(carrier) check. Porchlight reads it from \(devices) while the app is open."
            : "Asked \(carrier) for an update. New scans appear here when it answers."
    }

    /// The empty timeline's message.
    public static func noScansText(_ pkg: Package) -> String {
        let carrier = pkg.carrier.displayName
        return readsOnDevice(pkg)
            ? "\(carrier) hasn't reported this number yet. Your Mac or iPhone checks it while Porchlight is open."
            : "\(carrier) hasn't reported this number. Porchlight checks again within the hour."
    }
}
