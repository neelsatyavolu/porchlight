import Foundation
import Testing
@testable import PorchKit

/// `NOW` is Sunday Nov 8 2026, 10 AM in Los Angeles.
@Suite struct AmazonTextTests {
    let text = AmazonFixture.text

    @Test(arguments: [
        ("Arriving tomorrow", "2026-11-09", "2026-11-09"),
        ("Arriving today", "2026-11-08", "2026-11-08"),
        ("Arriving Wednesday", "2026-11-11", "2026-11-11"),
        // Said on a Sunday, "Sunday" is next week; today would read "today".
        ("Arriving Sunday", "2026-11-15", "2026-11-15"),
        ("Arriving Monday, November 10", "2026-11-10", "2026-11-10"),
        ("Now expected Nov 12 - Nov 14", "2026-11-12", "2026-11-14"),
        ("Arriving November 12 \u{2013} 14", "2026-11-12", "2026-11-14"),
        ("Arriving Jan 3", "2027-01-03", "2027-01-03"),
        ("Arriving December 2, 2026", "2026-12-02", "2026-12-02"),
    ])
    func readsDateOnlyETAs(line: String, start: String, end: String) {
        #expect(text.eta(line) == .day(start: day(start), end: day(end)), "\(line)")
    }

    @Test func readsTimeWindowsInTheShoppersZone() {
        #expect(text.eta("Arriving today 2 PM - 6 PM") == .window(start: iso("2026-11-08T22:00:00.000Z"), end: iso("2026-11-09T02:00:00.000Z")))
        #expect(text.eta("Arriving tomorrow by 10 PM") == .window(start: iso("2026-11-10T06:00:00.000Z"), end: iso("2026-11-10T06:00:00.000Z")))
        #expect(text.eta("Arriving 8:30 a.m. \u{2013} 12 p.m.") == .window(start: iso("2026-11-08T16:30:00.000Z"), end: iso("2026-11-08T20:00:00.000Z")))
    }

    @Test func afternoonIsNotNoon() {
        #expect(text.eta("Arriving this afternoon") == nil)
        #expect(text.eta("Arriving tomorrow afternoon") == .day(start: day("2026-11-09"), end: day("2026-11-09")))
        #expect(text.eta("Arriving today by noon") == .window(start: iso("2026-11-08T20:00:00.000Z"), end: iso("2026-11-08T20:00:00.000Z")))
    }

    @Test(arguments: ["Delivered today", "Delivered November 7", "Return started", "Refund issued", "", "Package is on the way"])
    func givesNoETAWhenTheLineNamesNone(line: String) {
        #expect(text.eta(line) == nil, "\(line)")
    }

    @Test func readsEventDatesAndTimes() {
        #expect(text.eventDate("Sunday, November 8") == day("2026-11-08"))
        #expect(text.eventDate("Friday, November 6") == day("2026-11-06"))
        #expect(text.eventDate("Today") == day("2026-11-08"))
        #expect(text.eventDate("Package left") == nil)
        #expect(text.eventInstant(day("2026-11-08"), clock: "2:55 PM") == iso("2026-11-08T22:55:00.000Z"))
        #expect(text.eventInstant(day("2026-11-08"), clock: "12:05 AM") == iso("2026-11-08T08:05:00.000Z"))
        // No time on the page: the start of that day.
        #expect(text.eventInstant(day("2026-11-08"), clock: "") == iso("2026-11-08T08:00:00.000Z"))
    }

    @Test func readsDeliveredDays() {
        #expect(text.deliveredDay("Delivered today") == day("2026-11-08"))
        #expect(text.deliveredDay("Delivered yesterday") == day("2026-11-07"))
        #expect(text.deliveredDay("Delivered November 2") == day("2026-11-02"))
        #expect(text.deliveredDay("Delivered Friday") == day("2026-11-06"))
        // The date, not the most recent Wednesday (Nov 4).
        #expect(text.deliveredDay("Delivered Wednesday, October 28") == day("2026-10-28"))
        #expect(text.deliveredDay("Arriving tomorrow") == nil)
    }

    @Test(arguments: [
        ("Shipped", Status.inTransit), ("Out for delivery", .outForDelivery), ("Delivered", .delivered),
        ("Delivered today", .delivered), ("Package delivered near the front door or porch.", .delivered),
        ("Driver is nearby and arriving soon", .outForDelivery), ("Package is out for delivery.", .outForDelivery),
        ("Package arrived at a carrier facility.", .inTransit), ("Delivery attempted", .exception),
        ("Running late", .exception), ("Return started", .returned), ("Available for pickup", .availableForPickup),
        ("Shipper created a label, UPS has not received the package yet.", .labelCreated), ("Ordered", .labelCreated),
        ("Arriving tomorrow", .inTransit),
    ])
    func mapsHeadlinesToStatuses(line: String, status: Status) {
        #expect(AmazonText.status(line) == status, "\(line)")
    }

    @Test func mapsCarrierHeaders() {
        #expect(AmazonText.carrier(fromHeader: "Shipped with Amazon") == .amazon)
        #expect(AmazonText.carrier(fromHeader: "Delivery facilitated by Amazon") == .amazon)
        #expect(AmazonText.carrier(fromHeader: "Shipped with UPS") == .ups)
        #expect(AmazonText.carrier(fromHeader: "Shipped with USPS") == .usps)
        #expect(AmazonText.carrier(fromHeader: "Shipped with FedEx") == .fedex)
        #expect(AmazonText.carrier(fromHeader: "Shipped with DHL eCommerce") == .dhlEcommerce)
        #expect(AmazonText.carrier(fromHeader: "Shipped with OnTrac") == .ontrac)
        #expect(AmazonText.carrier(fromHeader: "Shipped with Speedy Couriers") == nil)
    }
}
