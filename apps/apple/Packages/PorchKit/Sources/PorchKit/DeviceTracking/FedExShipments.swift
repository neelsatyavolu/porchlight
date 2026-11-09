// Ported in part from universal-parcel-scraper (github.com/plhery/universal-parcel-scraper),
// Copyright its authors, Apache License 2.0: reading the track/v2/shipments
// reply, the number and not-found checks, and the scan clock (carriers/fedex/adapter.ts).
// The status map is docs/research/scraping.md's. See THIRD_PARTY_NOTICES.md.
import Foundation

/// The reply of `POST api.fedex.com/track/v2/shipments`, which the FedEx
/// tracking page makes and the web view captures.
enum FedExShipments {
    static func read(json: String, trackingNumber: String, timeZone: TimeZone) -> DeviceRead {
        guard let output = DeviceTrackingParser.object(json)?.object("output"), output["packages"] is [Any] else {
            return .failed("FedEx sent a reply the parser doesn't know")
        }
        let packages = output.objects("packages")
        guard !packages.isEmpty else { return .notFound }
        let wanted = normalized(trackingNumber)
        let matches = packages.filter { $0.string("trackingNbr").map(normalized) == wanted }
        guard matches.count == 1, let shipment = matches.first else { return .failed("FedEx didn't return the number") }
        let codes = shipment.objects("errorList").compactMap { $0.string("code") }.joined(separator: " ").uppercased()
        if codes.firstMatch(of: #/TRACKINGNUMBER|NOTFOUND/#) != nil { return .notFound }

        let events = shipment.objects("scanEventList").compactMap { event($0, timeZone: timeZone) }
        let keyStatus = shipment.string("keyStatus")
        let code = shipment.string("keyStatusCD")
        guard !events.isEmpty || keyStatus != nil || code != nil else { return .failed("FedEx gave no status") }
        let current = status(code: code)
        var deliveredAt: Date?
        if current == .delivered {
            deliveredAt = shipment.string("actDeliveryDt").flatMap(offsetInstant) ?? events.first { $0.status == .delivered }?.occurredAt
        }
        return .ok(DeviceReading(status: current, statusDetail: keyStatus, eta: eta(shipment.string("estDeliveryDt")),
                                 deliveredAt: deliveredAt, events: events))
    }

    private static func normalized(_ n: String) -> String {
        n.filter { !$0.isWhitespace && $0 != "-" && $0 != "." }.uppercased()
    }

    // MARK: Status (docs/research/scraping.md, FedEx)

    static func status(code: String?) -> Status {
        switch code?.uppercased() {
        case "OC", "IN": .labelCreated
        case "PU", "IT", "AR", "DP", "AF", "FD", "PX", "IX", "CC", "CP", "DO": .inTransit
        case "OD": .outForDelivery
        case "HL", "HP": .availableForPickup
        case "DL": .delivered
        case "DE", "SE", "DD", "DY", "CD", "PD": .exception
        case "RS": .returned
        default: .unknown
        }
    }

    // MARK: Events

    /// `date` "YYYY-MM-DD", `time` "HH:MM:SS" and `gmtOffset` "+02:00". A scan
    /// FedEx dates without an offset is read in its US state's zone, else the device's.
    private static func event(_ raw: [String: Any], timeZone: TimeZone) -> ObservedEvent? {
        guard let description = CarrierText.eventDescription(raw.string("status")),
              let d = raw.string("date")?.wholeMatch(of: #/(\d{4})-(\d{2})-(\d{2})/#),
              let year = Int(d.1), let month = Int(d.2), let day = Int(d.3) else { return nil }
        let t = raw.string("time")?.wholeMatch(of: #/(\d{2}):(\d{2})(?::(\d{2}))?/#)
        let location = raw.string("scanLocation")
        let zone = CarrierTime.offsetZone(raw.string("gmtOffset")) ?? CarrierTime.usZone(for: location) ?? timeZone
        guard let at = CarrierTime.date(year: year, month: month, day: day, hour: t.flatMap { Int($0.1) } ?? 0,
                                        minute: t.flatMap { Int($0.2) } ?? 0, second: t?.3.flatMap { Int($0) } ?? 0, in: zone)
        else { return nil }
        return ObservedEvent(occurredAt: at, status: status(code: raw.string("statusCD")), description: description, location: location)
    }

    /// An ISO 8601 time with an offset; nil without one.
    static func offsetInstant(_ raw: String) -> Date? {
        guard let m = raw.wholeMatch(of: #/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/#),
              let zone = CarrierTime.offsetZone(String(m.7)), let y = Int(m.1), let mo = Int(m.2), let d = Int(m.3),
              let h = Int(m.4), let mi = Int(m.5) else { return nil }
        return CarrierTime.date(year: y, month: mo, day: d, hour: h, minute: mi, second: m.6.flatMap { Int($0) } ?? 0, in: zone)
    }

    // MARK: ETA

    /// `estDeliveryDt` is FedEx's estimated delivery day. The page's reply
    /// carries no window, so the ETA is date-only (the carrier's local date).
    static func eta(_ raw: String?) -> ETA {
        guard let raw, let m = raw.prefixMatch(of: #/(\d{4})-(\d{2})-(\d{2})/#), let y = Int(m.1), let mo = Int(m.2), let d = Int(m.3),
              let day = CalendarDate(year: y, month: mo, day: d) else { return .none }
        return .day(start: day, end: nil)
    }
}
