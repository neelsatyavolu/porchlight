import Foundation
import Testing
@testable import PorchKit

/// Saved carrier replies in Fixtures/ (provenance in Fixtures/README.md).
enum DeviceFixture {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures")

    static func text(_ name: String) -> String {
        do {
            return try String(contentsOf: dir.appending(path: name), encoding: .utf8)
        } catch {
            fatalError("missing fixture \(name): \(error)")
        }
    }

    static func usps(_ name: String, _ number: String) -> DeviceRead {
        DeviceTrackingParser.read(.page(url: URL(string: "https://tools.usps.com/tracking/")!, html: text(name)), carrier: .usps,
                                  trackingNumber: number, now: NOW, timeZone: LA)
    }

    static func ups(_ body: String, status: Int = 200, number: String = "1Z999AA10123456784", now: Date = NOW) -> DeviceRead {
        DeviceTrackingParser.read(.response(url: "https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US", status: status, body: body),
                                  carrier: .ups, trackingNumber: number, now: now, timeZone: LA)
    }

    static func fedex(_ body: String, status: Int = 200, number: String) -> DeviceRead {
        DeviceTrackingParser.read(.response(url: "https://api.fedex.com/track/v2/shipments", status: status, body: body),
                                  carrier: .fedex, trackingNumber: number, now: NOW, timeZone: LA)
    }

    /// The fixture with `edit` applied to its first trackDetails / packages entry.
    static func editedJSON(_ name: String, list: String, _ edit: (inout [String: Any]) -> Void) -> String {
        var root = try! JSONSerialization.jsonObject(with: Data(text(name).utf8)) as! [String: Any]
        if list == "trackDetails" {
            var items = root["trackDetails"] as! [[String: Any]]
            edit(&items[0])
            root["trackDetails"] = items
        } else {
            var output = root["output"] as! [String: Any]
            var items = output["packages"] as! [[String: Any]]
            edit(&items[0])
            output["packages"] = items
            root["output"] = output
        }
        return String(decoding: try! JSONSerialization.data(withJSONObject: root), as: UTF8.self)
    }
}

private func reading(_ read: DeviceRead, sourceLocation: SourceLocation = #_sourceLocation) throws -> DeviceReading {
    guard case let .ok(r) = read else {
        Issue.record("expected ok, got \(read)", sourceLocation: sourceLocation)
        throw CancellationError()
    }
    return r
}

/// No signatory or other `PRIVATE …` placeholder from the fixtures reaches what is sent.
private func expectNoPrivateData(_ r: DeviceReading, sourceLocation: SourceLocation = #_sourceLocation) throws {
    let body = String(decoding: try WireJSON.encoder().encode(DeviceRead.ok(r).observation(at: NOW)), as: UTF8.self)
    #expect(!body.contains("PRIVATE"), sourceLocation: sourceLocation)
}

@Suite struct USPSTrackingPageTests {
    @Test func readsTheDeliveredTimeline() throws {
        let r = try reading(DeviceFixture.usps("usps-timeline.html", "9400111899223397910421"))
        #expect(r.status == .delivered)
        #expect(r.statusDetail == "Delivered, Left with Individual")
        // EXAMPLE CITY, NY: Eastern daylight time.
        #expect(r.deliveredAt == iso("2025-03-14T16:17:00.000Z"))
        // The undated placeholder and "See All" are not scans.
        #expect(r.events.map(\.status) == [.delivered, .outForDelivery, .exception, .inTransit, .inTransit])
        #expect(r.events[0].description == "Delivered, Left with Individual")
        #expect(r.events[0].location == "EXAMPLE CITY, NY 00000")
        // No place: the device's zone (LA in tests).
        #expect(r.events[3].location == nil)
        #expect(r.events[3].occurredAt == iso("2025-03-12T23:31:00.000Z"))
        #expect(r.eta == .none)
        try expectNoPrivateData(r)
    }

    @Test func readsTheEstimateBannerAsDateOnly() throws {
        let r = try reading(DeviceFixture.usps("usps-estimate.html", "9400111899223397910438"))
        #expect(r.status == .inTransit)
        #expect(r.statusDetail == "In Transit, Arriving On Time")
        #expect(r.eta == .day(start: day("2025-03-17"), end: nil))
        #expect(r.events.count == 3)
        // "EXAMPLE CITY CA DISTRIBUTION CENTER" names its state before its kind.
        #expect(r.events[1].occurredAt == iso("2025-03-15T06:05:00.000Z"))
        #expect(r.deliveredAt == nil)
    }

    @Test func fallsBackToTheHistoryTable() throws {
        let r = try reading(DeviceFixture.usps("usps-history-table.html", "9400111899223397910438"))
        #expect(r.status == .inTransit)
        #expect(r.events.map(\.description) == [
            "Departed USPS Regional Facility", "Arrived at USPS Regional Facility", "Accepted at USPS Origin Facility",
        ])
        #expect(r.events[0].location == "CHICAGO, IL 60607")
        #expect(r.events[0].occurredAt == iso("2025-03-16T04:20:00.000Z"))
    }

    @Test func readsTheOutForDeliveryWindowOnItsDay() throws {
        let r = try reading(DeviceFixture.usps("usps-out-for-delivery.html", "9400111899223397910445"))
        #expect(r.status == .outForDelivery)
        #expect(r.eta == .window(start: iso("2026-11-09T21:15:00.000Z"), end: iso("2026-11-10T00:15:00.000Z")))
        #expect(r.events.map(\.status) == [.outForDelivery, .inTransit, .inTransit, .labelCreated])
    }

    @Test func tellsNotFoundChallengedAndWrongPagesApart() {
        #expect(DeviceFixture.usps("usps-not-found.html", "9400100000000000000000") == .notFound)
        #expect(DeviceFixture.usps("usps-interstitial.html", "9400100000000000000000") == .challenged)
        #expect(DeviceFixture.usps("usps-timeline.html", "9400100000000000000000") == .failed("USPS showed a different tracking number"))
    }

    @Test func mapsStatusTextLikeTheResearchTable() {
        let cases: [(String, Status?)] = [
            ("Delivered, In/At Mailbox", .delivered),
            ("Available for Pickup", .availableForPickup),
            ("Held at Post Office, At Customer Request", .availableForPickup),
            ("Out for Delivery", .outForDelivery),
            ("Return to Sender Processed", .returned),
            ("Refused", .returned),
            ("Notice Left (No Authorized Recipient Available)", .exception),
            ("Delivery Attempted - No Access to Delivery Location", .exception),
            ("Alert", .exception),
            ("Pre-Shipment Info Sent to USPS, USPS Awaiting Item", .labelCreated),
            ("Shipping Label Created, USPS Awaiting Item", .labelCreated),
            ("Arrived at USPS Regional Facility", .inTransit),
            ("Awaiting Delivery Scan", .inTransit),
            ("Picked Up by Shipping Partner, USPS Awaiting Item", .labelCreated),
            ("Tracking Not Available", .unknown),
            ("USPS in possession of item", nil),
        ]
        for (text, status) in cases { #expect(USPSTrackingPage.status(for: text) == status, "\(text)") }
    }
}

@Suite struct UPSTrackStatusTests {
    let fixture = DeviceFixture.text("ups-out-for-delivery.json")

    @Test func readsAnOutForDeliveryReply() throws {
        let r = try reading(DeviceFixture.ups(fixture, now: iso("2026-08-04T08:00:00.000Z")))
        #expect(r.status == .outForDelivery)
        #expect(r.statusDetail == "Out For Delivery Today")
        #expect(r.eta == .day(start: day("2026-08-04"), end: nil))
        #expect(r.events.map(\.status) == [.outForDelivery, .inTransit, .inTransit])
        #expect(r.events[0].occurredAt == iso("2026-08-04T07:12:04.000Z"))
        #expect(r.events[0].location == "ZUERICH, CH")
        #expect(r.deliveredAt == nil)
        try expectNoPrivateData(r)
    }

    @Test func picksTheScheduledYear() {
        func eta(_ month: String, _ dayNum: String) -> CalendarDate? {
            UPSTrackStatus.scheduledDay(["monthCMSKey": "cms.stapp.\(month)", "dayNum": dayNum], now: NOW, timeZone: LA)
        }
        #expect(eta("nov", "10") == day("2026-11-10"))
        #expect(eta("nov", "3") == day("2026-11-03")) // 5 days ago: still this year
        #expect(eta("oct", "20") == day("2027-10-20")) // more than a week ago: next year
        #expect(eta("jan", "5") == day("2027-01-05"))
        #expect(eta("xyz", "5") == nil)
    }

    @Test func readsDeliveredReturnedAndAccessPoint() throws {
        let delivered = DeviceFixture.editedJSON("ups-out-for-delivery.json", list: "trackDetails") {
            $0["progressBarType"] = "Delivered"
            $0["packageStatus"] = "Delivered"
            var scans = $0["shipmentProgressActivities"] as! [[String: Any]]
            scans[0]["actCode"] = "KB"
            $0["shipmentProgressActivities"] = scans
        }
        let d = try reading(DeviceFixture.ups(delivered))
        #expect(d.status == .delivered)
        #expect(d.deliveredAt == iso("2026-08-04T07:12:04.000Z"))

        let uap = DeviceFixture.editedJSON("ups-out-for-delivery.json", list: "trackDetails") {
            $0["progressBarType"] = "Delivered"
            $0["isDeliveredToUAP"] = true
        }
        #expect(try reading(DeviceFixture.ups(uap)).status == .availableForPickup)

        let returned = DeviceFixture.editedJSON("ups-out-for-delivery.json", list: "trackDetails") {
            $0["progressBarType"] = "InTransit"
            $0["returnNumbers"] = ["1Z999AA10123456795"]
        }
        #expect(try reading(DeviceFixture.ups(returned)).status == .returned)
    }

    @Test func mapsActivityCodes() {
        let cases: [(String?, Status)] = [
            ("MP", .labelCreated), ("OF", .outForDelivery), ("OT", .outForDelivery), ("9E", .delivered), ("KE", .delivered),
            ("2Q", .availableForPickup), ("S7", .availableForPickup), ("48", .exception), ("5R", .exception),
            ("DP", .inTransit), (nil, .inTransit),
        ]
        for (code, status) in cases { #expect(UPSTrackStatus.eventStatus(actCode: code) == status) }
        #expect(UPSTrackStatus.packageStatus(progressBar: "ManifestUpload", toAccessPoint: false) == .labelCreated)
        #expect(UPSTrackStatus.packageStatus(progressBar: "FirstUPSPossession", toAccessPoint: false) == .inTransit)
        #expect(UPSTrackStatus.packageStatus(progressBar: "Exception", toAccessPoint: false) == .exception)
    }

    @Test func tellsNotFoundAndRefusalsApart() {
        #expect(DeviceFixture.ups(DeviceFixture.text("ups-not-found.json"), number: "1Z4E9W120300000006") == .notFound)
        let noScans = DeviceFixture.editedJSON("ups-out-for-delivery.json", list: "trackDetails") { $0["shipmentProgressActivities"] = [] }
        #expect(DeviceFixture.ups(noScans) == .notFound)
        #expect(DeviceFixture.ups("", status: 401) == .challenged)
        #expect(DeviceFixture.ups("", status: 403) == .challenged)
        #expect(DeviceFixture.ups("oops", status: 500) == .failed("HTTP 500"))
        #expect(DeviceFixture.ups(#"{"statusCode":"500","statusText":"Error"}"#) == .failed("UPS answered 500"))
        #expect(DeviceFixture.ups(fixture, number: "1Z999AA10000000000") == .failed("UPS didn't return the number"))
    }
}

@Suite struct FedExShipmentsTests {
    @Test func readsADeliveredReply() throws {
        let r = try reading(DeviceFixture.fedex(DeviceFixture.text("fedex-delivered.json"), number: "999999999999"))
        #expect(r.status == .delivered)
        #expect(r.statusDetail == "Delivered")
        #expect(r.deliveredAt == iso("2026-09-02T09:58:00.000Z"))
        #expect(r.eta == .day(start: day("2026-09-02"), end: nil))
        #expect(r.events.map(\.status) == [.delivered, .inTransit, .inTransit, .labelCreated])
        #expect(r.events[0].occurredAt == iso("2026-09-02T09:58:00.000Z"))
        #expect(r.events[3].occurredAt == iso("2026-08-30T00:05:00.000Z"))
        try expectNoPrivateData(r)
    }

    @Test func readsOutForDeliveryAndHeld() throws {
        let ofd = try reading(DeviceFixture.fedex(DeviceFixture.text("fedex-in-transit.json"), number: "999999999998"))
        #expect(ofd.status == .outForDelivery)
        #expect(ofd.eta == .day(start: day("2026-09-25"), end: nil))
        #expect(ofd.events.count == 4)

        let held = try reading(DeviceFixture.fedex(DeviceFixture.text("fedex-held.json"), number: "999999999996"))
        #expect(held.status == .availableForPickup)
        #expect(held.eta == .none)
        #expect(held.events.first?.status == .availableForPickup)
        #expect(held.events.map(\.location).contains(nil))
        try expectNoPrivateData(held)
    }

    @Test func mapsKeyStatusCodes() {
        let cases: [(String?, Status)] = [
            ("OC", .labelCreated), ("IN", .labelCreated), ("PU", .inTransit), ("DO", .inTransit), ("OD", .outForDelivery),
            ("HL", .availableForPickup), ("HP", .availableForPickup), ("DL", .delivered), ("DE", .exception), ("PD", .exception),
            ("RS", .returned), ("CA", .unknown), ("ZZ", .unknown), (nil, .unknown),
        ]
        for (code, status) in cases { #expect(FedExShipments.status(code: code) == status) }
    }

    @Test func tellsNotFoundAndRefusalsApart() {
        let notFound = #"{"output":{"packages":[{"trackingNbr":"123456789012","keyStatus":"","keyStatusCD":"","errorList":[{"code":"TRACKING.TRACKINGNUMBER.NOTFOUND","message":"This tracking number cannot be found."}],"scanEventList":[]}]}}"#
        #expect(DeviceFixture.fedex(notFound, number: "123456789012") == .notFound)
        #expect(DeviceFixture.fedex(#"{"output":{"packages":[]}}"#, number: "123456789012") == .notFound)
        #expect(DeviceFixture.fedex(DeviceFixture.text("fedex-access-denied.html"), status: 403, number: "123456789012") == .challenged)
        #expect(DeviceFixture.fedex(#"{"errors":[]}"#, number: "123456789012") == .failed("FedEx sent a reply the parser doesn't know"))
        #expect(DeviceFixture.fedex(DeviceFixture.text("fedex-delivered.json"), number: "123456789012") == .failed("FedEx didn't return the number"))
    }

    @Test func aPageWithoutTheCallIsChallengedOnlyWhenItLooksLikeOne() {
        let denied = DeviceTrackingParser.read(.page(url: URL(string: "https://www.fedex.com/wtrk/track/")!, html: DeviceFixture.text("fedex-access-denied.html")),
                                               carrier: .fedex, trackingNumber: "123456789012", now: NOW, timeZone: LA)
        #expect(denied == .challenged)
        let shell = DeviceTrackingParser.read(.page(url: URL(string: "https://www.fedex.com/wtrk/track/")!, html: "<html><body><app-root></app-root></body></html>"),
                                              carrier: .fedex, trackingNumber: "123456789012", now: NOW, timeZone: LA)
        #expect(shell == .failed("the page made no tracking call"))
    }
}

@Suite struct CarrierPagesTests {
    @Test func buildsTheTrackingPages() {
        #expect(CarrierPages.pageURL(for: .usps, trackingNumber: "9400 1000 0000 0000 0000 00")?.absoluteString
            == "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000")
        #expect(CarrierPages.pageURL(for: .ups, trackingNumber: "1Z999AA10123456784")?.absoluteString
            == "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784&requester=ST/trackdetails")
        #expect(CarrierPages.pageURL(for: .fedex, trackingNumber: "123456789012")?.absoluteString
            == "https://www.fedex.com/fedextrack/?trknbr=123456789012")
        #expect(CarrierPages.pageURL(for: .dhl, trackingNumber: "1234567890") == nil)
        #expect(CarrierPages.pageURL(for: .usps, trackingNumber: "94001&x=1") == nil)
    }

    @Test func keepsTheWebViewOnTheCarriersHosts() {
        func allows(_ s: String, _ carrier: Carrier) -> Bool { CarrierPages.allowsNavigation(to: URL(string: s), carrier: carrier) }
        #expect(allows("https://tools.usps.com/tracking/?tLabels=1", .usps))
        #expect(allows("https://usps.com/", .usps))
        #expect(allows("about:blank", .fedex))
        #expect(!allows("http://tools.usps.com/tracking/", .usps))
        #expect(!allows("https://evilusps.com/", .usps))
        #expect(!allows("https://www.ups.com/track", .usps))
        #expect(!allows("https://usps.com.example.net/", .usps))
        #expect(!allows("javascript:alert(1)", .ups))
        #expect(CarrierPages.allowsNavigation(to: nil, carrier: .ups) == false)
    }

    @Test func capturesOnlyTheTrackingCalls() {
        #expect(CarrierPages.isCaptureURL("https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US", carrier: .ups))
        #expect(CarrierPages.isCaptureURL("https://api.fedex.com/track/v2/shipments", carrier: .fedex))
        #expect(!CarrierPages.isCaptureURL("https://api.fedex.com/auth/oauth/v2/token", carrier: .fedex))
        #expect(!CarrierPages.isCaptureURL("http://webapis.ups.com/track/api/Track/GetStatus", carrier: .ups))
        #expect(!CarrierPages.isCaptureURL("https://evil.example/webapis.ups.com/track/api/Track/GetStatus", carrier: .ups))
        #expect(!CarrierPages.isCaptureURL("https://api.fedex.com/track/v2/shipments", carrier: .ups))
        #expect(CarrierPages.captureURLPatterns(for: .usps).isEmpty)
    }

    @Test func takesCapturesOnlyFromCarrierFramesWithinTheSizeCap() {
        let url = "https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US"
        #expect(CarrierPages.acceptsCapture(frameHost: "www.ups.com", url: url, body: "{}", carrier: .ups))
        // A third-party iframe running the same script.
        #expect(!CarrierPages.acceptsCapture(frameHost: "ads.example.net", url: url, body: "{}", carrier: .ups))
        #expect(!CarrierPages.acceptsCapture(frameHost: nil, url: url, body: "{}", carrier: .ups))
        // Another carrier's frame or call while reading UPS.
        #expect(!CarrierPages.acceptsCapture(frameHost: "www.fedex.com", url: url, body: "{}", carrier: .ups))
        #expect(!CarrierPages.acceptsCapture(frameHost: "www.ups.com", url: "https://www.ups.com/api/session", body: "{}", carrier: .ups))
        let big = String(repeating: "x", count: CarrierPages.maxCaptureBytes + 1)
        #expect(!CarrierPages.acceptsCapture(frameHost: "www.ups.com", url: url, body: big, carrier: .ups))
        // UTF-8 length counts, not characters.
        let wide = String(repeating: "é", count: CarrierPages.maxCaptureBytes / 2 + 1)
        #expect(!CarrierPages.acceptsCapture(frameHost: "www.ups.com", url: url, body: wide, carrier: .ups))
    }

    @Test func recognizesChallenges() {
        #expect(CarrierChallenge.kind(of: DeviceFixture.text("usps-interstitial.html")) == .interstitial)
        #expect(CarrierChallenge.kind(of: DeviceFixture.text("fedex-access-denied.html")) == .blocked)
        #expect(CarrierChallenge.kind(of: DeviceFixture.text("usps-timeline.html")) == .none)
    }

    @Test func turnsReadsIntoObservations() {
        let o = DeviceRead.challenged.observation(at: NOW)
        #expect(o.outcome == .challenged)
        #expect(o.status == .unknown)
        #expect(o.events.isEmpty)
        #expect(DeviceRead.failed("x").outcome == .failed)
        #expect(DeviceRead.notFound.outcome == .notFound)
    }
}
