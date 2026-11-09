// Ported in part from universal-parcel-scraper (github.com/plhery/universal-parcel-scraper),
// Copyright its authors, Apache License 2.0: reading the GetStatus reply, the
// number check and the scheduled-date year rule (carriers/ups/adapter.ts).
// The status maps are docs/research/scraping.md's. See THIRD_PARTY_NOTICES.md.
import Foundation

/// The reply of `POST webapis.ups.com/track/api/Track/GetStatus`, which the
/// UPS tracking page makes and the web view captures.
enum UPSTrackStatus {
    static func read(json: String, trackingNumber: String, now: Date, timeZone: TimeZone) -> DeviceRead {
        guard let root = DeviceTrackingParser.object(json) else { return .failed("UPS sent something that isn't JSON") }
        guard root.string("statusCode") == "200" else { return .failed("UPS answered \(root.string("statusCode") ?? "without a status")") }
        let details = root.objects("trackDetails")
        guard !details.isEmpty else { return .notFound }
        let wanted = trackingNumber.filter { !$0.isWhitespace }.uppercased()
        let named = details.filter { ($0.string("trackingNumber") ?? $0.string("requestedTrackingNumber"))?.uppercased() == wanted }
        guard let detail = named.first ?? (details.count == 1 ? details[0] : nil) else { return .failed("UPS didn't return the number") }
        if let returned = detail.string("trackingNumber"), returned.uppercased() != wanted { return .failed("UPS didn't return the number") }
        if detail.string("errorCode") != nil { return .notFound }

        let events = detail.objects("shipmentProgressActivities").compactMap(event)
        guard !events.isEmpty else { return .notFound }

        let statusText = detail.string("packageStatus")
        var status = detail.string("progressBarType").flatMap { packageStatus(progressBar: $0, toAccessPoint: detail.bool("isDeliveredToUAP")) }
            ?? events[0].status
        if !detail.array("returnNumbers").isEmpty || statusText?.range(of: "return", options: .caseInsensitive) != nil {
            status = .returned
        }
        let deliveredAt = status == .delivered ? (events.first { $0.status == .delivered } ?? events[0]).occurredAt : nil
        let eta = detail.object("scheduledDeliveryDateDetail").flatMap { scheduledDay($0, now: now, timeZone: timeZone) }
            .map { ETA.day(start: $0, end: nil) } ?? .none
        return .ok(DeviceReading(status: status, statusDetail: statusText, eta: eta, deliveredAt: deliveredAt, events: events))
    }

    // MARK: Status (docs/research/scraping.md, UPS)

    static func packageStatus(progressBar: String, toAccessPoint: Bool) -> Status? {
        switch progressBar.lowercased() {
        case "manifestupload": .labelCreated
        case "firstupspossession", "intransit": .inTransit
        case "outfordelivery": .outForDelivery
        case "delivered": toAccessPoint ? .availableForPickup : .delivered
        case "exception": .exception
        default: nil
        }
    }

    static func eventStatus(actCode: String?) -> Status {
        switch actCode?.uppercased() {
        case "MP": .labelCreated
        case "OF", "OT": .outForDelivery
        case "9E", "FS", "KB", "KD", "KE": .delivered
        case "2Q", "ZP", "5G", "S7": .availableForPickup
        case "48", "49", "G3", "5R": .exception
        default: .inTransit
        }
    }

    // MARK: Events

    /// `gmtDate` "YYYYMMDD" and `gmtTime` "HH:MM:SS" are UTC; `gmtOffset` is the scan's own zone.
    private static func event(_ raw: [String: Any]) -> ObservedEvent? {
        guard let description = CarrierText.eventDescription(raw.string("activityScan") ?? raw.object("milestoneName")?.string("name")),
              let at = instant(gmtDate: raw.string("gmtDate"), gmtTime: raw.string("gmtTime")) else { return nil }
        return ObservedEvent(occurredAt: at, status: eventStatus(actCode: raw.string("actCode")), description: description,
                             location: raw.string("location"))
    }

    static func instant(gmtDate: String?, gmtTime: String?) -> Date? {
        guard let d = gmtDate?.wholeMatch(of: #/(\d{4})(\d{2})(\d{2})/#), let t = gmtTime?.wholeMatch(of: #/(\d{1,2}):(\d{2})(?::(\d{2}))?/#),
              let year = Int(d.1), let month = Int(d.2), let day = Int(d.3), let hour = Int(t.1), let minute = Int(t.2) else { return nil }
        return CarrierTime.date(year: year, month: month, day: day, hour: hour, minute: minute, second: t.3.flatMap { Int($0) } ?? 0,
                                in: TimeZone(secondsFromGMT: 0)!)
    }

    // MARK: ETA

    /// `{monthCMSKey: "cms.stapp.dec", dayNum: "4"}` has no year: this year,
    /// unless that is more than 7 days ago, then next year. Date-only.
    static func scheduledDay(_ detail: [String: Any], now: Date, timeZone: TimeZone) -> CalendarDate? {
        guard let key = detail.string("monthCMSKey")?.split(separator: ".").last, let month = CarrierTime.month(named: key),
              let day = detail.string("dayNum").flatMap({ Int($0) }) else { return nil }
        let today = CalendarDate(now, in: timeZone)
        guard let candidate = CalendarDate(year: today.year, month: month, day: day) else {
            return CalendarDate(year: today.year + 1, month: month, day: day)
        }
        return candidate.dayNumber < today.dayNumber - 7 ? CalendarDate(year: today.year + 1, month: month, day: day) : candidate
    }
}
