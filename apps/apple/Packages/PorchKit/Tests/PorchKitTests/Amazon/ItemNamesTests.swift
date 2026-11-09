import Foundation
import Testing
@testable import PorchKit

@Suite struct ItemNamesTests {
    @Test func cutsAmazonListingsDownToTheProduct() {
        #expect(RuleItemNames.short("Anker USB C Cable, 240W Type C Fast Charging Cord (1-Pack, 6 ft, Black) | USB 2.0 for iPhone 18 / 17 / 16 / 15 Series, MacBook Pro 2020, and More") == "Anker USB C Cable")
        #expect(RuleItemNames.short("ZAGG Privacy XTR Screen Protector for iPhone 17 Pro | 4-Way Privacy Full-Screen Filter, 5X Stronger, Fingerprint-Resistant Tempered Glass") == "ZAGG Privacy XTR Screen Protector")
        #expect(RuleItemNames.short("Apple AirPods Pro 3 Wireless Earbuds with Active Noise Cancellation, Hearing Health Features") == "Apple AirPods Pro 3 Wireless Earbuds")
    }

    @Test func leavesShortNamesAlone() {
        #expect(RuleItemNames.short("USB-C cable") == "USB-C cable")
        #expect(RuleItemNames.short("  Coffee filters  ") == "Coffee filters")
    }

    @Test func capsAListingWithNoBreaksAtSixWords() {
        #expect(RuleItemNames.short("Stainless Steel Insulated Water Bottle Leak Proof Lid Keeps Drinks Cold") == "Stainless Steel Insulated Water Bottle Leak")
    }

    @Test func importsWithTheShortTitleButKeepTheFullItemNames() async {
        let long = "Anker USB C Cable, 240W Type C Fast Charging Cord (1-Pack, 6 ft, Black)"
        let items = [PackageItem(name: long, imageUrl: nil, quantity: 1), PackageItem(name: "Screen protector", imageUrl: nil, quantity: 1)]
        let title = await AmazonImportBuilder.shortTitle(for: items, names: RuleItemNames())
        #expect(title == "Anker USB C Cable and 1 more")
        #expect(await AmazonImportBuilder.shortTitle(for: [], names: RuleItemNames()) == nil)
    }
}
