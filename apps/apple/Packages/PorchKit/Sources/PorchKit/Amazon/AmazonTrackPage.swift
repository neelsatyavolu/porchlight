import Foundation

/// What a "Track package" page shows (amazon.com/progress-tracker/package).
public struct AmazonTrackPage: Hashable, Sendable {
    /// From "Shipped with UPS" / "Delivery facilitated by Amazon"; nil when the page names none.
    public var carrier: Carrier?
    /// As printed after "Tracking ID:", not yet normalized.
    public var trackingNumber: String?
    /// The big promise line: "Arriving tomorrow", "Delivered today".
    public var promise: String?
    /// The status card: "Shipped", "Out for delivery", "Delivered".
    public var headline: String?
    /// The line under it: "Package left the shipper facility".
    public var detail: String?
    /// Newest first, as the page lists them.
    public var events: [ObservedEvent]

    /// True when the page had any of the parts the parser looks for. False
    /// means the layout changed (or the page isn't a track page).
    public var recognized: Bool { trackingNumber != nil || headline != nil || promise != nil || !events.isEmpty }

    public static func parse(_ document: HTMLNode, text: AmazonText) -> AmazonTrackPage {
        let header = carrierHeader(in: document)
        return AmazonTrackPage(
            carrier: header.flatMap(AmazonText.carrier(fromHeader:)),
            trackingNumber: trackingNumber(in: document),
            promise: nonEmpty(document.first(class: "pt-promise-main-slot")?.textContent),
            headline: nonEmpty(document.first(class: "pt-status-main-status")?.textContent) ?? milestoneLabel(in: document),
            detail: nonEmpty(document.first(class: "pt-status-secondary-status")?.textContent),
            events: events(in: document, text: text)
        )
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// The milestone marked current, from its aria-label ("Shipped: Complete").
    static func milestoneLabel(in document: HTMLNode) -> String? {
        guard let current = document.first(where: { $0.hasClass("pt-status-milestone-label") && $0.hasClass("current-label") }) else { return nil }
        return nonEmpty(current.textContent)
    }

    static let carrierCues = ["shipped with", "delivery facilitated by", "delivered by", "carrier:", "shipping with"]

    static func carrierHeader(in document: HTMLNode) -> String? {
        let candidates = [document.first(class: "tracking-event-carrier-header"), document.first(class: "pt-delivery-card-wrapper")]
            .compactMap { $0 }
            .flatMap { $0.elements { ["h1", "h2", "h3", "h4", "span", "div"].contains($0.tag) } + [$0] }
        for node in candidates {
            let t = node.textContent
            if carrierCues.contains(where: { t.lowercased().hasPrefix($0) }) { return t }
        }
        // Text cue anywhere on the page, for a layout without those classes.
        let all = document.elements { ["h1", "h2", "h3", "h4"].contains($0.tag) }
        return all.map(\.textContent).first { t in carrierCues.contains { t.lowercased().hasPrefix($0) } }
    }

    nonisolated(unsafe) static let trackingPattern = #/(?i:tracking (?:id|number))\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{5,40})/#

    static func trackingNumber(in document: HTMLNode) -> String? {
        let nodes = [document.first(class: "pt-delivery-card-trackingId"), document.first(class: "tracking-event-trackingId-text")].compactMap { $0 }
        for node in nodes {
            if let m = node.textContent.firstMatch(of: trackingPattern) { return String(m.output.1) }
        }
        let anywhere = document.elements { ["div", "span", "h4", "h3", "p"].contains($0.tag) && $0.children.allSatisfy(\.isText) }
        for node in anywhere {
            if let m = node.textContent.firstMatch(of: trackingPattern) { return String(m.output.1) }
        }
        return nil
    }

    /// The "See all updates" timeline: date headers, then rows of time,
    /// message and location under each.
    static func events(in document: HTMLNode, text: AmazonText) -> [ObservedEvent] {
        guard let container = document.first(id: "tracking-events-container") ?? document.first(class: "tracking-events-modal-inner") else { return [] }
        let marks = container.elements { node in
            node.hasClass("tracking-event-date") || node.children.contains { $0.hasClass("tracking-event-time-left") }
        }
        var day: CalendarDate?
        var out: [ObservedEvent] = []
        for mark in marks {
            if mark.hasClass("tracking-event-date") {
                day = text.eventDate(mark.textContent)
                continue
            }
            guard let day, let message = nonEmpty(mark.first(class: "tracking-event-message")?.textContent) else { continue }
            let clock = mark.first(class: "tracking-event-time")?.textContent ?? ""
            guard let at = text.eventInstant(day, clock: clock) else { continue }
            let location = nonEmpty(mark.first(class: "tracking-event-location")?.textContent)
            out.append(ObservedEvent(occurredAt: at, status: AmazonText.status(message) ?? .inTransit, description: message, location: location))
        }
        return out
    }
}
