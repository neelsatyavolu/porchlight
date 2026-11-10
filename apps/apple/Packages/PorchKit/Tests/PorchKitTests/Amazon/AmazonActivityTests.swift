import Foundation
import Testing
@testable import PorchKit

@Suite struct AmazonActivityTests {
    func amazon(_ status: Status, eta: ETA = .none, archived: Bool = false) -> Package {
        Package(id: UUID().uuidString, carrier: .amazon, trackingNumber: "TBA123456789012", source: .amazon, status: status,
                eta: eta, archivedAt: archived ? NOW : nil, updatedAt: NOW)
    }

    @Test func busyWhenAnAmazonPackageArrivesTodayOrIsOutForDelivery() {
        let today = CalendarDate(NOW, in: LA)
        #expect(AmazonActivity.isBusy([amazon(.outForDelivery)], now: NOW, timeZone: LA))
        #expect(AmazonActivity.isBusy([amazon(.inTransit, eta: .day(start: today, end: nil))], now: NOW, timeZone: LA))
        #expect(AmazonActivity.isBusy([amazon(.inTransit, eta: .window(start: NOW.addingTimeInterval(3600), end: nil))], now: NOW, timeZone: LA))
    }

    @Test func quietOtherwise() {
        let later = CalendarDate(NOW, in: LA).adding(days: 3)
        #expect(!AmazonActivity.isBusy([], now: NOW, timeZone: LA))
        #expect(!AmazonActivity.isBusy([amazon(.inTransit, eta: .day(start: later, end: nil))], now: NOW, timeZone: LA))
        #expect(!AmazonActivity.isBusy([amazon(.delivered)], now: NOW, timeZone: LA))
        #expect(!AmazonActivity.isBusy([amazon(.outForDelivery, archived: true)], now: NOW, timeZone: LA))
        let ups = Package(id: "u", carrier: .ups, trackingNumber: "1Z", status: .outForDelivery, updatedAt: NOW)
        #expect(!AmazonActivity.isBusy([ups], now: NOW, timeZone: LA))
    }

    @Test func aBusyMacChecksEveryTenMinutes() async {
        let store = MemoryAmazonStatusStore({ var s = AmazonLocalStatus(); s.connected = true; return s }())
        let clock = TestClock()
        let coordinator = AmazonImportCoordinator(store: store, api: AmazonFakeAPI(), now: { clock.now }) {
            AmazonImporter(loader: FixtureLoader.standard(), api: AmazonFakeAPI(), timeZone: LA, now: { clock.now }, pause: .zero)
        }
        _ = await coordinator.runIfDue()
        clock.advance(minutes: 10)
        #expect(!(await coordinator.isDueOnMac()))
        #expect(await coordinator.isDueOnMac(busy: true))
    }
}
