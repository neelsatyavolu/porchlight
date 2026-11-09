import Foundation

/// What one carrier page said about a package, before it is sent.
public struct DeviceReading: Hashable, Sendable {
    public var status: Status
    public var statusDetail: String?
    public var eta: ETA
    public var deliveredAt: Date?
    /// Newest first.
    public var events: [ObservedEvent]

    public init(status: Status, statusDetail: String?, eta: ETA, deliveredAt: Date?, events: [ObservedEvent]) {
        self.status = status
        self.statusDetail = statusDetail
        self.eta = eta
        self.deliveredAt = deliveredAt
        self.events = events
    }
}

/// How reading one carrier page went.
public enum DeviceRead: Hashable, Sendable {
    case ok(DeviceReading)
    case notFound
    case challenged
    /// A timeout, an error page, or a reply the parser doesn't know. The reason is for logs only.
    case failed(String)

    public var outcome: DeviceOutcome {
        switch self {
        case .ok: .ok
        case .notFound: .notFound
        case .challenged: .challenged
        case .failed: .failed
        }
    }

    /// The `POST /v1/packages/:id/observed` body.
    public func observation(at observedAt: Date) -> DeviceObservation {
        guard case let .ok(r) = self else { return .withoutData(outcome, observedAt: observedAt) }
        return DeviceObservation(observedAt: observedAt, outcome: .ok, status: r.status, statusDetail: r.statusDetail, eta: r.eta,
                                 deliveredAt: r.deliveredAt, events: r.events)
    }
}

/// Turns what the web view captured into a `DeviceRead`.
public enum DeviceTrackingParser {
    /// `now` and `timeZone` resolve dates the carrier writes without a year or
    /// an offset; `timeZone` is the device's.
    public static func read(_ capture: CarrierCapture, carrier: Carrier, trackingNumber: String, now: Date, timeZone: TimeZone) -> DeviceRead {
        switch (carrier, capture) {
        case let (.usps, .page(_, html)):
            return USPSTrackingPage.read(html: html, trackingNumber: trackingNumber, timeZone: timeZone)
        case let (.ups, .response(_, status, body)):
            if let refused = refusal(status) { return refused }
            return UPSTrackStatus.read(json: body, trackingNumber: trackingNumber, now: now, timeZone: timeZone)
        case let (.fedex, .response(_, status, body)):
            if let refused = refusal(status) { return refused }
            return FedExShipments.read(json: body, trackingNumber: trackingNumber, timeZone: timeZone)
        case let (.ups, .page(_, html)), let (.fedex, .page(_, html)):
            // The page never made its tracking call.
            return CarrierChallenge.kind(of: html) == .none ? .failed("the page made no tracking call") : .challenged
        default:
            return .failed("nothing to read for \(carrier.rawValue)")
        }
    }

    private static func refusal(_ status: Int) -> DeviceRead? {
        if CarrierChallenge.isChallengeStatus(status) { return .challenged }
        if !(200..<300).contains(status) { return .failed("HTTP \(status)") }
        return nil
    }

    /// Parses a JSON object body; nil for anything else.
    static func object(_ json: String) -> [String: Any]? {
        guard let data = json.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

/// Loose reads of JSON values, which carriers type inconsistently.
extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? {
        switch self[key] {
        case let s as String: CarrierText.clean(s)
        case let n as NSNumber where CFGetTypeID(n) != CFBooleanGetTypeID(): n.stringValue
        default: nil
        }
    }

    func bool(_ key: String) -> Bool { (self[key] as? Bool) ?? false }
    func object(_ key: String) -> [String: Any]? { self[key] as? [String: Any] }
    func objects(_ key: String) -> [[String: Any]] { (self[key] as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }
    func array(_ key: String) -> [Any] { (self[key] as? [Any]) ?? [] }
}
