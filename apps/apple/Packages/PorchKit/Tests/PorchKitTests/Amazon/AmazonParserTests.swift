import Foundation
import Testing
@testable import PorchKit

@Suite struct AmazonOrderListTests {
    let list = AmazonOrderList.parse(AmazonFixture.document("order-history"))

    @Test func findsEveryOrderAndTrackableShipment() {
        // 10 cards; the page's hidden "Test: .js-order-card" probe is not one.
        #expect(list.orderCount == 10)
        #expect(list.shipments.count == 9)
        #expect(!list.isEmpty)
        #expect(list.shipments.allSatisfy { $0.orderId.wholeMatch(of: #/\d{3}-\d{7}-\d{7}/#) != nil })
        #expect(list.shipments.allSatisfy { $0.trackURL.host == "www.amazon.com" && $0.trackURL.path == "/progress-tracker/package" })
    }

    @Test func readsTheOpenShipment() throws {
        let s = try #require(list.shipments.first { $0.orderId == AmazonFixture.shippedOrder })
        #expect(s.shipmentId == AmazonFixture.shippedShipment)
        #expect(s.headline == "Arriving tomorrow")
        #expect(s.trackURL == AmazonFixture.trackURL(AmazonFixture.shippedOrder, AmazonFixture.shippedShipment))
        #expect(!s.items.isEmpty)
        #expect(s.items.allSatisfy { !$0.name.isEmpty && ($0.imageUrl?.hasPrefix("https://m.media-amazon.com/") ?? false) })
    }

    @Test func readsItemsInBothLayouts() throws {
        // The first order uses the newer "yo-enhanced" cards: three items.
        let first = try #require(list.shipments.first { $0.orderId == AmazonFixture.deliveredOrder })
        #expect(first.headline == "Delivered today")
        #expect(first.items.count == 3)
        #expect(first.items.map(\.quantity) == [1, 1, 1])
        // Older "item-box" rows carry a quantity badge.
        #expect(list.shipments.flatMap(\.items).contains { $0.quantity == 2 })
    }

    @Test func treatsAPageWithoutCardsAsUnreadable() {
        let other = AmazonOrderList.parse(HTMLDocument.parse("<html><body><div class=\"js-order-card\">Test: .js-order-card</div></body></html>"))
        #expect(other.orderCount == 0)
        #expect(!other.isEmpty)
    }
}

@Suite struct AmazonTrackPageTests {
    let text = AmazonFixture.text

    @Test func readsAShippedAmazonLogisticsPackage() throws {
        let page = AmazonTrackPage.parse(AmazonFixture.document("track-tba-shipped"), text: text)
        #expect(page.carrier == .amazon)
        #expect(page.trackingNumber == "TBA532261610252")
        #expect(page.promise == "Arriving tomorrow")
        #expect(page.headline == "Shipped")
        #expect(page.detail == "Package left the shipper facility")
        // That event has no time on the page, so it sits at the start of its day.
        #expect(page.events == [ObservedEvent(occurredAt: iso("2026-11-08T08:00:00.000Z"), status: .inTransit, description: "Package left the shipper facility")])
        #expect(page.recognized)
    }

    @Test func readsADeliveredPackageTimeline() throws {
        let page = AmazonTrackPage.parse(AmazonFixture.document("track-tba-delivered"), text: text)
        #expect(page.carrier == .amazon)
        #expect(page.trackingNumber == "TBA096464206829")
        #expect(page.promise == "Delivered today")
        #expect(page.events.count == 5)
        let newest = try #require(page.events.first)
        #expect(newest.status == .delivered)
        #expect(newest.occurredAt == iso("2026-11-08T22:55:00.000Z"))
        #expect(newest.description == "Package delivered near the front door or porch.")
        #expect(newest.location?.hasSuffix(", US") == true)
        #expect(page.events.map(\.status) == [.delivered, .outForDelivery, .inTransit, .inTransit, .inTransit])
        #expect(zip(page.events, page.events.dropFirst()).allSatisfy { $0.occurredAt >= $1.occurredAt })
    }

    @Test func readsAnotherCarrier() throws {
        let page = AmazonTrackPage.parse(AmazonFixture.document("track-ups-synthetic"), text: text)
        #expect(page.carrier == .ups)
        #expect(page.trackingNumber == "1Z999AA10123456784")
        #expect(page.promise == "Arriving Wednesday")
        #expect(page.events.map(\.occurredAt) == [iso("2026-11-08T14:12:00.000Z"), iso("2026-11-08T05:40:00.000Z"), iso("2026-11-07T23:05:00.000Z")])
        #expect(page.events.last?.status == .labelCreated)
        #expect(page.events.first?.location == "Louisville, KY US")
        #expect(page.events.last?.location == nil)
    }

    @Test func recognizesNothingOnAnUnrelatedPage() {
        let page = AmazonTrackPage.parse(HTMLDocument.parse("<html><body><h1>Hello</h1></body></html>"), text: text)
        #expect(!page.recognized)
        #expect(page.trackingNumber == nil)
    }

    @Test func tellsPagesApart() {
        let signIn = URL(string: "https://www.amazon.com/ap/signin?openid.return_to=x")!
        #expect(AmazonPages.kind(of: signIn, document: AmazonFixture.document("signin")) == .signIn)
        // A sign-in form served at the orders URL still counts as sign-in.
        #expect(AmazonPages.kind(of: AmazonPages.orderHistory, document: AmazonFixture.document("signin")) == .signIn)
        #expect(AmazonPages.kind(of: AmazonPages.orderHistory, document: AmazonFixture.document("order-history")) == .orders)
        let track = AmazonFixture.trackURL(AmazonFixture.shippedOrder, AmazonFixture.shippedShipment)
        #expect(AmazonPages.kind(of: track, document: AmazonFixture.document("track-tba-shipped")) == .track)
        let captcha = URL(string: "https://www.amazon.com/errors/validateCaptcha")!
        #expect(AmazonPages.kind(of: captcha, document: HTMLDocument.parse("")) == .challenge)
        #expect(AmazonPages.isSignedInPage(AmazonPages.orderHistory))
        #expect(!AmazonPages.isSignedInPage(signIn))
        #expect(!AmazonPages.isSignedInPage(URL(string: "https://evil.example/gp/your-account/order-history")!))
    }

    @Test func limitsNavigationToAmazon() {
        func policy(_ s: String) -> AmazonPages.NavigationPolicy { AmazonPages.navigationPolicy(for: URL(string: s)) }
        #expect(policy("https://www.amazon.com/ap/signin") == .allow)
        #expect(policy("https://amazon.com/") == .allow)
        #expect(policy("https://smile.amazon.com/x") == .allow)
        #expect(policy("about:blank") == .allow)
        #expect(policy("https://amazon.com.evil.example/ap/signin") == .openExternally)
        #expect(policy("https://notamazon.com/") == .openExternally)
        #expect(policy("http://www.amazon.com/") == .openExternally)
        #expect(policy("https://www.amazon.co.uk/") == .openExternally)
        #expect(policy("javascript:alert(1)") == .block)
        #expect(policy("file:///etc/passwd") == .block)
        #expect(AmazonPages.navigationPolicy(for: nil) == .block)
    }

    @Test func ignoresTrackLinksOffAmazon() {
        let html = """
        <div class="order-card"><div class="yohtmlc-order-id">Order # 111-2222222-3333333</div>
        <div class="delivery-box"><a href="https://evil.example/progress-tracker/package?orderId=111-2222222-3333333&shipmentId=Abc">Track package</a></div>
        <div class="delivery-box"><a href="/progress-tracker/package?orderId=111-2222222-3333333&shipmentId=Def">Track package</a></div>
        </div>
        """
        let list = AmazonOrderList.parse(HTMLDocument.parse(html))
        #expect(list.shipments.map(\.shipmentId) == ["Def"])
        #expect(list.shipments.allSatisfy { $0.trackURL.host == "www.amazon.com" })
    }
}

@Suite struct AmazonImportBuilderTests {
    let builder = AmazonImportBuilder(text: AmazonFixture.text)
    let list = AmazonOrderList.parse(AmazonFixture.document("order-history"))

    func shipment(_ orderId: String) throws -> AmazonShipment {
        try #require(list.shipments.first { $0.orderId == orderId })
    }

    @Test func buildsAShippedTBAItem() throws {
        let s = try shipment(AmazonFixture.shippedOrder)
        let track = AmazonTrackPage.parse(AmazonFixture.document("track-tba-shipped"), text: builder.text)
        let item = try #require(builder.item(for: s, track: track))
        #expect(item.orderId == AmazonFixture.shippedOrder)
        #expect(item.shipmentId == AmazonFixture.shippedShipment)
        #expect(item.carrier == .amazon)
        #expect(item.trackingNumber == "TBA532261610252")
        #expect(item.eta == .day(start: day("2026-11-09"), end: day("2026-11-09")))
        #expect(item.items == s.items)
        #expect(item.title == AmazonImportBuilder.title(for: s.items))
        let observed = try #require(item.observed)
        #expect(observed.status == .inTransit)
        #expect(observed.statusDetail == "Package left the shipper facility")
        #expect(observed.observedAt == NOW)
        #expect(observed.deliveredAt == nil)
        #expect(observed.events.count == 1)
    }

    @Test func buildsADeliveredTBAItem() throws {
        let s = try shipment(AmazonFixture.deliveredOrder)
        let track = AmazonTrackPage.parse(AmazonFixture.document("track-tba-delivered"), text: builder.text)
        let item = try #require(builder.item(for: s, track: track))
        #expect(item.eta == .none)
        #expect(item.title == "\(s.items[0].name) and 2 more")
        #expect(item.observed?.status == .delivered)
        #expect(item.observed?.deliveredAt == iso("2026-11-08T22:55:00.000Z"))
    }

    @Test func sendsNoObservedStatusForOtherCarriers() throws {
        let s = try shipment(AmazonFixture.shippedOrder)
        let track = AmazonTrackPage.parse(AmazonFixture.document("track-ups-synthetic"), text: builder.text)
        let item = try #require(builder.item(for: s, track: track))
        #expect(item.carrier == .ups)
        #expect(item.trackingNumber == "1Z999AA10123456784")
        #expect(item.eta == .day(start: day("2026-11-11"), end: day("2026-11-11")))
        #expect(item.observed == nil)
    }

    @Test func waitsForATrackingNumber() throws {
        let s = try shipment(AmazonFixture.shippedOrder)
        let track = AmazonTrackPage.parse(HTMLDocument.parse(#"<h1 class="pt-promise-main-slot">Arriving Friday</h1>"#), text: builder.text)
        #expect(builder.item(for: s, track: track) == nil)
    }

    @Test func picksOpenAndRecentShipments() {
        let open = list.shipments.filter(builder.isOpen).map(\.headline)
        // Today and Nov 7 are within two days; Nov 2 and 3 are not; the return is skipped.
        #expect(open.sorted() == ["Arriving tomorrow", "Delivered November 7", "Delivered November 7", "Delivered today"])
    }

    @Test func encodesTheWireShape() throws {
        let s = try shipment(AmazonFixture.shippedOrder)
        let track = AmazonTrackPage.parse(AmazonFixture.document("track-tba-shipped"), text: builder.text)
        let item = try #require(builder.item(for: s, track: track))
        let json = try encodeObject(item)
        #expect(json["etaStart"] as? String == "2026-11-09")
        #expect(json["etaEnd"] as? String == "2026-11-09")
        #expect(json["etaDateOnly"] as? Bool == true)
        #expect(json["carrier"] as? String == "amazon")
        let observed = try #require(json["observed"] as? [String: Any])
        #expect(observed["status"] as? String == "in_transit")
        #expect(observed["observedAt"] as? String == "2026-11-08T18:00:00.000Z")
    }
}
