import Foundation
import Testing
@testable import PorchKit

// Mirrors apps/web/src/packages/provenance.test.ts. The Apple hint differs on
// purpose: the person is already in the app, so it explains instead of asking.

private let now = iso("2026-11-08T18:00:00.000Z")
private let twelveMinAgo = iso("2026-11-08T17:48:00.000Z")
private let fourHoursAgo = iso("2026-11-08T14:00:00.000Z")

private func pkg(_ carrier: Carrier, _ source: DataSource?, checked: Date? = nil, status: Status = .inTransit) -> Package {
    var p = makePackage("p", status: status)
    p.carrier = carrier
    p.dataSource = source
    p.lastCheckedAt = checked
    return p
}

@Suite struct SourceTextTests {
    @Test func sourceLineIsNilBeforeAnyRead() {
        #expect(SourceText.sourceLine(pkg(.ups, nil, checked: twelveMinAgo), now: now) == nil)
    }

    @Test func sourceLineNamesEachSource() {
        #expect(SourceText.sourceLine(pkg(.ups, .device, checked: twelveMinAgo), now: now)
            == "From UPS's tracking page, checked on your Mac or iPhone 12 min ago.")
        #expect(SourceText.sourceLine(pkg(.ontrac, .web, checked: twelveMinAgo), now: now)
            == "From OnTrac's tracking page, checked by Porchlight 12 min ago.")
        #expect(SourceText.sourceLine(pkg(.dhl, .api, checked: twelveMinAgo), now: now)
            == "From DHL's tracking API, checked 12 min ago.")
        #expect(SourceText.sourceLine(pkg(.jitsu, .aggregator, checked: twelveMinAgo), now: now)
            == "From Ship24, checked 12 min ago.")
        #expect(SourceText.sourceLine(pkg(.amazon, .amazon, checked: twelveMinAgo), now: now)
            == "From your Amazon orders, checked on your Mac or iPhone 12 min ago.")
        #expect(SourceText.sourceLine(pkg(.usps, .device), now: now)
            == "From USPS's tracking page, checked on your Mac or iPhone.")
        #expect(SourceText.sourceLine(pkg(.other, .web, checked: twelveMinAgo), now: now)
            == "From the carrier's tracking page, checked by Porchlight 12 min ago.")
    }

    @Test func deviceHintForUnreadOrStaleDeviceCarriers() {
        #expect(SourceText.deviceHint(pkg(.usps, nil), now: now)
            == "USPS packages update while Porchlight is open on your Mac or iPhone.")
        #expect(SourceText.deviceHint(pkg(.fedex, .device, checked: fourHoursAgo), now: now)
            == "FedEx packages update while Porchlight is open on your Mac or iPhone.")
    }

    @Test func deviceHintStaysQuiet() {
        #expect(SourceText.deviceHint(pkg(.usps, .device, checked: twelveMinAgo), now: now) == nil)
        #expect(SourceText.deviceHint(pkg(.usps, nil, status: .delivered), now: now) == nil)
        var archived = pkg(.usps, nil)
        archived.archivedAt = fourHoursAgo
        #expect(SourceText.deviceHint(archived, now: now) == nil)
        #expect(SourceText.deviceHint(pkg(.ontrac, nil), now: now) == nil)
    }

    @Test func readsOnDevice() {
        #expect(SourceText.readsOnDevice(pkg(.usps, nil)))
        #expect(SourceText.readsOnDevice(pkg(.fedex, .web)))
        #expect(!SourceText.readsOnDevice(pkg(.ups, nil)))
        #expect(!SourceText.readsOnDevice(pkg(.ups, .web)))
        #expect(SourceText.readsOnDevice(pkg(.ups, .device)))
        #expect(!SourceText.readsOnDevice(pkg(.dhl, .api)))
    }

    @Test func refreshAndNoScansText() {
        #expect(SourceText.refreshText(pkg(.usps, nil))
            == "Asked for a new USPS check. Porchlight reads it from your Mac or iPhone while the app is open.")
        #expect(SourceText.noScansText(pkg(.usps, nil))
            == "USPS hasn't reported this number yet. Your Mac or iPhone checks it while Porchlight is open.")
        #expect(SourceText.refreshText(pkg(.ontrac, nil))
            == "Asked OnTrac for an update. New scans appear here when it answers.")
        #expect(SourceText.noScansText(pkg(.ontrac, nil))
            == "OnTrac hasn't reported this number. Porchlight checks again within the hour.")
    }
}
