import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// The Live Activity for one out-for-delivery package (SPEC §8). The app
/// starts, updates and ends it (LiveActivityPlanner); the widget extension
/// draws it. Plain Codable here so it is tested on the Mac; the ActivityKit
/// conformance is added on iOS below.
public struct PackageActivityAttributes: Hashable, Sendable, Codable {
    public struct ContentState: Hashable, Sendable, Codable {
        public var status: Status
        public var statusDetail: String?
        /// ETA in its wire form (docs/API.md), so a date-only ETA stays a calendar date.
        public var etaStart: String?
        public var etaEnd: String?
        public var etaDateOnly: Bool

        public init(status: Status, statusDetail: String?, eta: ETA) {
            self.status = status
            self.statusDetail = statusDetail
            let wire = eta.wireFields
            etaStart = wire.start
            etaEnd = wire.end
            etaDateOnly = wire.dateOnly
        }

        public init(_ pkg: Package) {
            self.init(status: pkg.status, statusDetail: pkg.statusDetail, eta: pkg.eta)
        }

        public var eta: ETA { ETA(wireStart: etaStart, wireEnd: etaEnd, dateOnly: etaDateOnly) }
    }

    public var packageId: String
    /// `Package.displayTitle` when the activity started.
    public var title: String
    public var carrier: Carrier

    public init(packageId: String, title: String, carrier: Carrier) {
        self.packageId = packageId
        self.title = title
        self.carrier = carrier
    }

    public init(_ pkg: Package) {
        self.init(packageId: pkg.id, title: pkg.displayTitle, carrier: pkg.carrier)
    }

    /// Opens the package in the app.
    public var url: URL? { PackageID.normalize(packageId).map { DeepLink.package(id: $0).url } }
}

#if canImport(ActivityKit) && os(iOS)
extension PackageActivityAttributes: ActivityAttributes {}
#endif

/// Text for the Live Activity views, worded like the list row (DESIGN.md §6).
public enum PackageActivityText {
    /// "Out for delivery · On vehicle, Oakland"
    public static func statusLine(_ state: PackageActivityAttributes.ContentState) -> String {
        PackageText.statusLine(package(PackageActivityAttributes(packageId: "", title: "", carrier: .other), state))
    }

    /// "By 8:00 PM", "Today", "Delivered", ...
    public static func phrase(
        _ attributes: PackageActivityAttributes, _ state: PackageActivityAttributes.ContentState, now: Date, timeZone: TimeZone
    ) -> ETAPhrase {
        ArrivalPhrases.rowPhrase(package(attributes, state), now: now, timeZone: timeZone)
    }

    static func package(_ attributes: PackageActivityAttributes, _ state: PackageActivityAttributes.ContentState) -> Package {
        Package(
            id: attributes.packageId, carrier: attributes.carrier, trackingNumber: "", title: attributes.title,
            status: state.status, statusDetail: state.statusDetail, eta: state.eta, updatedAt: .distantPast
        )
    }
}
