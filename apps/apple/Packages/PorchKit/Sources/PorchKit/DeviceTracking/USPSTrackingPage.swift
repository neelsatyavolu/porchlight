// Ported in part from universal-parcel-scraper (github.com/plhery/universal-parcel-scraper),
// Copyright its authors, Apache License 2.0: the selectors, the challenge and
// not-found checks, the estimate banner and the out-for-delivery window
// (carriers/usps/adapter.ts). The status map is docs/research/scraping.md's.
// See THIRD_PARTY_NOTICES.md.
import Foundation

/// The USPS tracking page (`tools.usps.com/tracking/?tLabels=…`), read from
/// the HTML the hidden web view rendered. USPS has no JSON feed to capture.
enum USPSTrackingPage {
    static func read(html: String, trackingNumber: String, timeZone: TimeZone) -> DeviceRead {
        let doc = HTMLDocument.parse(html)
        // Akamai's interstitial or challenge: the tracking layout never rendered.
        guard let bar = doc.first(class: "track-bar-container") else { return .challenged }
        let wanted = trackingNumber.filter { !$0.isWhitespace }.uppercased()
        let shown = (bar.first(id: "trackingNum") ?? doc.first(id: "trackingNum"))?.textContent.filter { !$0.isWhitespace }.uppercased()
        guard shown == wanted else { return .failed("USPS showed a different tracking number") }

        let banner = bannerHeader(in: doc)
        if banner?.range(of: "tracking not available", options: .caseInsensitive) != nil { return .notFound }

        var events = timelineEvents(in: doc, timeZone: timeZone)
        if events.isEmpty { events = historyTableEvents(in: doc, timeZone: timeZone) }

        let currentDetail = doc.first(class: "current-step").flatMap { $0.first(class: "tb-status-detail")?.textContent }
            .flatMap(CarrierText.eventDescription)
        let detail = currentDetail ?? events.first?.description ?? banner.flatMap(CarrierText.eventDescription)
        let current = detail.flatMap(status(for:)) ?? (events.isEmpty ? .unknown : .inTransit)
        let deliveredAt = current == .delivered ? events.first(where: { $0.status == .delivered })?.occurredAt : nil
        return .ok(DeviceReading(
            status: current, statusDetail: detail, eta: eta(in: doc, events: events, timeZone: timeZone),
            deliveredAt: deliveredAt, events: events
        ))
    }

    // MARK: Status (docs/research/scraping.md, USPS; first match wins)

    private static let rules: [(Status, [String])] = [
        (.outForDelivery, ["out for delivery"]),
        (.returned, ["return to sender", "refused", "returned to shipper"]),
        (.exception, ["alert", "notice left", "delivery attempted", "insufficient address", "no access"]),
        (.labelCreated, ["pre-shipment", "label created", "label printed", "usps awaiting item"]),
        (.inTransit, [
            "accepted", "arrived", "departed", "in transit", "processed", "awaiting delivery", "picked up by shipping partner",
        ]),
        (.unknown, ["tracking not available"]),
    ]

    /// The status a line of USPS text names; nil when no rule matches.
    static func status(for text: String) -> Status? {
        let lower = text.lowercased()
        if lower.hasPrefix("delivered") { return .delivered }
        if lower.contains("available for pickup") || lower.contains("available for agent pickup")
            || lower.firstMatch(of: #/held at .*(office|depot)/#) != nil {
            return .availableForPickup
        }
        return rules.first { _, terms in terms.contains(where: lower.contains) }?.0
    }

    // MARK: Events

    /// The `.tb-step` cards. Collapsed ones hold the full history; undated
    /// placeholders and "See All" have no date and are skipped.
    private static func timelineEvents(in doc: HTMLNode, timeZone: TimeZone) -> [ObservedEvent] {
        doc.all(class: "tb-step").compactMap { step in
            guard let description = step.first(class: "tb-status-detail").flatMap({ CarrierText.eventDescription($0.textContent) }),
                  let dateText = step.first(class: "tb-date")?.textContent else { return nil }
            let location = step.first(class: "tb-location").flatMap { CarrierText.clean($0.textContent) }
            return event(description: description, dateText: dateText, location: location, timeZone: timeZone)
        }
    }

    /// The older `.tracking_history_container` table: a date cell, a description and a place.
    private static func historyTableEvents(in doc: HTMLNode, timeZone: TimeZone) -> [ObservedEvent] {
        guard let table = doc.first(class: "tracking_history_container") else { return [] }
        let events = table.all(tag: "tr").compactMap { row -> ObservedEvent? in
            let cells = row.all(tag: "td").compactMap { CarrierText.clean($0.textContent) }
            guard let dateText = cells.first(where: { localTime(in: $0) != nil }) else { return nil }
            let rest = cells.filter { $0 != dateText }
            let location = rest.filter { $0.firstMatch(of: #/,\s*[A-Z]{2}\b/#) != nil }.min { $0.count < $1.count }
            guard let description = rest.filter({ $0 != location }).max(by: { $0.count < $1.count }).flatMap(CarrierText.eventDescription)
            else { return nil }
            return event(description: description, dateText: dateText, location: location, timeZone: timeZone)
        }
        return events.enumerated().sorted { a, b in
            a.element.occurredAt != b.element.occurredAt ? a.element.occurredAt > b.element.occurredAt : a.offset < b.offset
        }.map(\.element)
    }

    private static func event(description: String, dateText: String, location: String?, timeZone: TimeZone) -> ObservedEvent? {
        guard let local = localTime(in: dateText) else { return nil }
        let zone = CarrierTime.usZone(for: location) ?? timeZone
        guard let at = CarrierTime.date(year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute, in: zone)
        else { return nil }
        return ObservedEvent(occurredAt: at, status: status(for: description) ?? .inTransit, description: description, location: location)
    }

    /// "March 14, 2025 12:17 PM", "November 9, 2026, 7:02 am", or a date alone (midnight).
    static func localTime(in text: String) -> (year: Int, month: Int, day: Int, hour: Int, minute: Int)? {
        guard let m = text.firstMatch(of: #/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/#), let month = CarrierTime.month(named: m.1),
              let day = Int(m.2), let year = Int(m.3) else { return nil }
        let after = text[m.range.upperBound...]
        if let t = after.firstMatch(of: #/(\d{1,2}):(\d{2})\s*([aApP])\.?[mM]\.?/#), let h = Int(t.1), let minute = Int(t.2),
           let hour = CarrierTime.hour24(h, pm: t.3.lowercased() == "p") {
            return (year, month, day, hour, minute)
        }
        return (year, month, day, 0, 0)
    }

    // MARK: ETA

    /// The estimate banner's day (date-only: USPS gives no offset), or the
    /// window an out-for-delivery scan announces on its own day.
    private static func eta(in doc: HTMLNode, events: [ObservedEvent], timeZone: TimeZone) -> ETA {
        let bannerDay = doc.first(class: "expected_delivery").flatMap { calendarDay(in: text(of: $0, skipping: "hint")) }
        if let newest = events.first, newest.status == .outForDelivery, let window = window(in: newest, timeZone: timeZone) {
            let zone = CarrierTime.usZone(for: newest.location) ?? timeZone
            if bannerDay == nil || bannerDay == CalendarDate(window.start, in: zone) { return .window(start: window.start, end: window.end) }
        }
        return bannerDay.map { .day(start: $0, end: nil) } ?? .none
    }

    /// "Monday 17 March 2025" or "March 17, 2025".
    static func calendarDay(in text: String) -> CalendarDate? {
        if let m = text.firstMatch(of: #/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/#), let month = CarrierTime.month(named: m.2),
           let day = Int(m.1), let year = Int(m.3), let date = CalendarDate(year: year, month: month, day: day) {
            return date
        }
        guard let m = text.firstMatch(of: #/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/#), let month = CarrierTime.month(named: m.1),
              let day = Int(m.2), let year = Int(m.3) else { return nil }
        return CalendarDate(year: year, month: month, day: day)
    }

    /// "Expected Delivery Between 1:15pm and 4:15pm", on the scan's own day.
    private static func window(in event: ObservedEvent, timeZone: TimeZone) -> (start: Date, end: Date)? {
        let pattern = #/(?i)expected delivery between\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s+(?:and|to|-|–)\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/#
        guard let m = event.description.firstMatch(of: pattern),
              let h1 = Int(m.1).flatMap({ CarrierTime.hour24($0, pm: m.3.lowercased() == "p") }), let m1 = Int(m.2),
              let h2 = Int(m.4).flatMap({ CarrierTime.hour24($0, pm: m.6.lowercased() == "p") }), let m2 = Int(m.5) else { return nil }
        let zone = CarrierTime.usZone(for: event.location) ?? timeZone
        let day = CalendarDate(event.occurredAt, in: zone)
        guard let start = CarrierTime.date(year: day.year, month: day.month, day: day.day, hour: h1, minute: m1, in: zone),
              let end = CarrierTime.date(year: day.year, month: day.month, day: day.day, hour: h2, minute: m2, in: zone),
              start < end else { return nil }
        return (start, end)
    }

    // MARK: DOM helpers

    /// The status banner's header. Tooltips reuse `.banner-header` inside
    /// `.speech_bubble`, and only the banner wrapper's own header counts.
    private static func bannerHeader(in doc: HTMLNode) -> String? {
        for wrapper in doc.all(class: "latest-update-banner-wrapper") {
            if let header = first(in: wrapper, class: "banner-header", skipping: "speech_bubble") {
                return CarrierText.clean(header.textContent)
            }
        }
        return nil
    }

    private static func first(in node: HTMLNode, class name: String, skipping skip: String) -> HTMLNode? {
        for child in node.children where !child.isText && !child.hasClass(skip) {
            if child.hasClass(name) { return child }
            if let found = first(in: child, class: name, skipping: skip) { return found }
        }
        return nil
    }

    /// Text below `node`, leaving out subtrees with class `skip`.
    private static func text(of node: HTMLNode, skipping skip: String) -> String {
        var parts: [String] = []
        func walk(_ n: HTMLNode) {
            if let t = n.text { parts.append(t); return }
            guard !n.hasClass(skip) else { return }
            n.children.forEach(walk)
        }
        walk(node)
        return HTMLText.collapse(parts.joined(separator: " "))
    }
}
