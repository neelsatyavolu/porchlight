import Foundation

/// Turns a shipment from Your Orders and its track page into the
/// `POST /v1/imports/amazon` item (docs/API.md).
public struct AmazonImportBuilder: Sendable {
    public var text: AmazonText
    public var detector: any CarrierDetector

    public init(text: AmazonText, detector: any CarrierDetector = RuleCarrierDetector()) {
        self.text = text
        self.detector = detector
    }

    /// Delivered shipments older than this are left alone; the server already has them.
    public static let deliveredLookbackDays = 2

    /// Whether a Your Orders line is worth opening the track page for: anything
    /// on its way, and anything delivered in the last couple of days (so the
    /// delivery itself is imported). Returns and refunds are skipped.
    public func isOpen(_ shipment: AmazonShipment) -> Bool {
        let s = AmazonText.normalize(shipment.headline)
        if s.contains("return") || s.contains("refund") || s.contains("cancel") { return false }
        if let delivered = text.deliveredDay(shipment.headline) {
            return delivered.dayNumber >= text.today.dayNumber - Self.deliveredLookbackDays
        }
        return true
    }

    /// nil when the page shows no tracking number (not shipped yet): the
    /// import endpoint needs one, so the shipment waits for the next run.
    public func item(for shipment: AmazonShipment, track: AmazonTrackPage) -> AmazonImportItem? {
        guard let raw = track.trackingNumber else { return nil }
        let number = detector.normalize(raw)
        guard !number.isEmpty else { return nil }
        let carrier = carrier(for: number, named: track.carrier)
        let eta = (track.promise.flatMap(text.eta) ?? text.eta(shipment.headline)) ?? .none
        return AmazonImportItem(
            orderId: shipment.orderId,
            shipmentId: shipment.shipmentId,
            carrier: carrier,
            trackingNumber: number,
            title: Self.title(for: shipment.items),
            items: shipment.items,
            eta: eta,
            observed: carrier == .amazon ? observed(track, shipment: shipment) : nil
        )
    }

    /// The carrier Amazon named, unless the number itself says Amazon
    /// Logistics. With no name, the detector's best guess, else `.other`.
    func carrier(for number: String, named: Carrier?) -> Carrier {
        if number.wholeMatch(of: #/TB[ACM]\d{12}/#) != nil { return .amazon }
        if let named, named != .amazon { return named }
        if let guess = detector.detect(number).first?.carrier { return guess }
        return named ?? .other
    }

    /// The status the page shows, for Amazon Logistics packages, which no
    /// aggregator tracks (docs/API.md, `observed`).
    func observed(_ track: AmazonTrackPage, shipment: AmazonShipment) -> AmazonObserved {
        let status = track.headline.flatMap(AmazonText.status)
            ?? track.promise.flatMap(AmazonText.status)
            ?? AmazonText.status(shipment.headline)
            ?? track.events.first?.status
            ?? .unknown
        let detail = track.detail ?? track.headline ?? track.promise ?? status.label
        let deliveredAt = status == .delivered ? track.events.first { $0.status == .delivered }?.occurredAt : nil
        return AmazonObserved(status: status, statusDetail: detail, observedAt: text.now, deliveredAt: deliveredAt, events: track.events)
    }

    /// "USB-C cable", or "USB-C cable and 2 more" for a box with three items.
    public static func title(for items: [PackageItem]) -> String? {
        guard let first = items.first else { return nil }
        return items.count == 1 ? first.name : "\(first.name) and \(items.count - 1) more"
    }
}
