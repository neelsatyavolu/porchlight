import Foundation
import Testing
@testable import PorchKit

@Suite struct PackageEditsTests {
    @Test func appliesOnlyTheFieldsARequestSets() {
        var pkg = makePackage("a")
        pkg.title = "Lamp"
        pkg.merchant = "IKEA"
        let edited = pkg.applying(PackagePutRequest(title: .some("Desk lamp"), merchant: .some(nil)), at: NOW)
        #expect(edited.title == "Desk lamp")
        #expect(edited.merchant == nil)
        #expect(edited.orderId == nil)
        #expect(edited.updatedAt == pkg.updatedAt)
    }

    @Test func archivingKeepsAnExistingArchivedAt() {
        var pkg = makePackage("a")
        let archived = pkg.applying(PackagePutRequest(archived: true), at: NOW)
        #expect(archived.archivedAt == NOW)
        pkg.archivedAt = iso("2026-11-01T00:00:00.000Z")
        #expect(pkg.applying(PackagePutRequest(archived: true), at: NOW).archivedAt == pkg.archivedAt)
        #expect(pkg.applying(PackagePutRequest(archived: false), at: NOW).archivedAt == nil)
    }

    @Test func revertsOnlyTheFieldsTheRequestTouched() {
        var original = makePackage("a")
        original.title = "Old"
        var current = original
        current.title = "New"
        current.status = .delivered
        let reverted = PackagePutRequest(title: .some("New")).reverting(current, to: original)
        #expect(reverted.title == "Old")
        #expect(reverted.status == .delivered)
    }

    @Test func buildsAnOptimisticCreate() {
        let pkg = Package.optimisticCreate(
            id: "n1", PackagePutRequest(trackingNumber: " 1Z999 ", carrier: nil, title: .some("Shoes"), source: .share), at: NOW
        )
        #expect(pkg.trackingNumber == "1Z999")
        #expect(pkg.carrier == .other)
        #expect(pkg.source == .share)
        #expect(pkg.title == "Shoes")
        #expect(pkg.updatedAt == NOW)
    }

    @Test func aQueuedPutRoundTripsIncludingClears() throws {
        let request = PackagePutRequest(
            trackingNumber: "1Z", carrier: .ups, title: .some("T"), merchant: .some(nil), source: .manual, archived: true
        )
        let data = try WireJSON.encoder().encode(request)
        #expect(try WireJSON.decoder().decode(PackagePutRequest.self, from: data) == request)
        let empty = try WireJSON.decoder().decode(PackagePutRequest.self, from: Data("{}".utf8))
        #expect(empty == PackagePutRequest())
    }

    @Test func staleCheckIsStrict() {
        let held = makePackage("a", updatedAt: "2026-11-08T17:05:00.000Z")
        #expect(held.isNewer(than: makePackage("a", updatedAt: "2026-11-08T17:00:00.000Z")))
        #expect(!held.isNewer(than: held))
    }
}
