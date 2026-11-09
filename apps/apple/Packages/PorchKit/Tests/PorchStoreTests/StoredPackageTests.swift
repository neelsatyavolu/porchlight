import Foundation
import PorchKit
import PorchStore
import SwiftData
import Testing

@Suite struct StoredPackageTests {
    @Test func roundTripsAPackageThroughAnInMemoryStore() throws {
        let container = try PorchStore.makeContainer(inMemory: true)
        let context = ModelContext(container)
        let updated = Date(timeIntervalSince1970: 1_793_000_000)
        let pkg = Package(
            id: "6f1c7a52-6b8e-4c1e-9a43-3b0f2d9a7c11", carrier: .dhlEcommerce, trackingNumber: "GM1234567890",
            title: "Lamp", merchant: nil, orderId: "112-1", source: .amazon, status: .outForDelivery,
            statusDetail: "On vehicle", eta: .day(start: CalendarDate("2026-11-12")!, end: CalendarDate("2026-11-14")!),
            updatedAt: updated, items: [PackageItem(name: "Lamp", quantity: 2)]
        )
        let stored = StoredPackage(pkg)
        context.insert(stored)
        context.insert(StoredEvent(TrackEvent(id: "e1", packageId: pkg.id, occurredAt: updated, status: .outForDelivery, description: "Out"), package: stored))
        try context.save()

        let fetched = try context.fetch(FetchDescriptor<StoredPackage>())
        #expect(fetched.count == 1)
        #expect(fetched.first?.package == pkg)
        #expect(fetched.first?.events.map(\.id) == ["e1"])

        context.delete(stored)
        try context.save()
        #expect(try context.fetchCount(FetchDescriptor<StoredEvent>()) == 0)
    }

    @Test func keepsDataSourceAndAttributionAcrossASave() throws {
        let container = try PorchStore.makeContainer(inMemory: true)
        let context = ModelContext(container)
        let pkg = Package(
            id: "0d3c6f0e-1d7b-4f0a-8b51-6a2f4e9c1b22", carrier: .dhl, trackingNumber: "1234567890", status: .delivered,
            updatedAt: Date(timeIntervalSince1970: 1_793_000_000), dataSource: .api,
            attribution: "Delivered by Deutsche Post DHL Group"
        )
        let stored = StoredPackage(pkg)
        context.insert(stored)
        try context.save()

        let fetched = try #require(try context.fetch(FetchDescriptor<StoredPackage>()).first)
        #expect(fetched.package.dataSource == .api)
        #expect(fetched.package.attribution == "Delivered by Deutsche Post DHL Group")
        #expect(fetched.package == pkg)

        var later = pkg
        later.dataSource = nil
        later.attribution = nil
        fetched.update(from: later)
        #expect(fetched.package.dataSource == nil)
        #expect(fetched.package.attribution == nil)
    }

    @Test func readsAnUnknownStoredDataSourceAsNil() throws {
        let pkg = Package(id: "p", carrier: .usps, trackingNumber: "9400111206206406260787", updatedAt: .now, dataSource: .device)
        let stored = StoredPackage(pkg)
        stored.dataSourceRaw = "carrier_pigeon"
        #expect(stored.package.dataSource == nil)
    }
}
