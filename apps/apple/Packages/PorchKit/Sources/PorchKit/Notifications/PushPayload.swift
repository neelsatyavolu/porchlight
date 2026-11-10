import Foundation

/// A Porchlight push, read from the APNs `userInfo` (docs/API.md "Push
/// payloads", buildPush in services/api/src/lib/apns.ts).
///
/// - Visible: `{ aps: { alert, sound }, packageId }` for out for delivery,
///   delivered and exception.
/// - Silent: `{ aps: { "content-available": 1 }, packageId }` for any other change.
public struct PushPayload: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case alert
        case background
    }

    public var kind: Kind
    /// Lowercased. Nil when missing or not a UUID.
    public var packageId: String?
    /// The server's silent "check now" (`wake: "check"`, docs/API.md "Background
    /// checks"): read Amazon and due carrier pages, not just sync.
    public var wantsCheck: Bool

    public init(kind: Kind, packageId: String?, wantsCheck: Bool = false) {
        self.kind = kind
        self.packageId = packageId
        self.wantsCheck = wantsCheck
    }

    /// Nil when `userInfo` has no `aps` dictionary with an alert or
    /// `content-available: 1`.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let aps = userInfo["aps"] as? [AnyHashable: Any] else { return nil }
        if aps["alert"] != nil {
            kind = .alert
        } else if (aps["content-available"] as? Int) == 1 {
            kind = .background
        } else {
            return nil
        }
        packageId = (userInfo["packageId"] as? String).flatMap(PackageID.normalize)
        wantsCheck = kind == .background && (userInfo["wake"] as? String) == "check"
    }

    /// Where tapping this push should go.
    public var deepLink: DeepLink? { packageId.map { .package(id: $0) } }
}

/// Package ids are UUIDs sent lowercase (Swift's `UUID` prints uppercase).
public enum PackageID {
    /// The lowercase form of a UUID string, or nil when `raw` isn't one.
    public static func normalize(_ raw: String) -> String? {
        UUID(uuidString: raw)?.uuidString.lowercased()
    }

    /// A new client-chosen id (SPEC §3).
    public static func make() -> String { UUID().uuidString.lowercased() }
}

/// In-app links. `porchlight://p/<id>` opens a package; push taps use it too.
public enum DeepLink: Hashable, Sendable {
    case package(id: String)

    public static let scheme = "porchlight"

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme,
              let host = url.host(percentEncoded: false)?.lowercased() else { return nil }
        let parts = url.path(percentEncoded: false).split(separator: "/", omittingEmptySubsequences: true)
        guard host == "p", parts.count == 1, let id = PackageID.normalize(String(parts[0])) else { return nil }
        self = .package(id: id)
    }

    public var url: URL {
        switch self {
        case let .package(id):
            // `id` is a normalized UUID, so the string is always a valid URL.
            URL(string: "\(Self.scheme)://p/\(id)")!
        }
    }
}
