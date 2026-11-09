import Foundation
import Testing
@testable import PorchKit

/// Settings on a device that isn't signed in to Amazon, when another device is.
@Suite struct AmazonElsewhereTextTests {
    func integration(_ state: AmazonImportState, platform: Platform?, last: Date? = NOW.addingTimeInterval(-300)) -> AmazonIntegration {
        AmazonIntegration(state: state, lastImportAt: last, lastError: nil, reportedAt: NOW.addingTimeInterval(-60), platform: platform)
    }

    @Test func namesTheDeviceAndTheLastImport() {
        let line = AmazonStatusText.elsewhere(integration(.ok, platform: .macos), now: NOW, timeZone: LA)
        #expect(line == .init(text: "Connected on your Mac. Last import 5 min ago. Its packages show up here too.", isProblem: false))
    }

    @Test func saysWhenNoImportHasWorkedYet() {
        let line = AmazonStatusText.elsewhere(integration(.ok, platform: .ios, last: nil), now: NOW, timeZone: LA)
        #expect(line.text == "Connected on your iPhone. Its packages show up here too.")
    }

    @Test func pointsToTheDeviceThatNeedsASignIn() {
        let line = AmazonStatusText.elsewhere(integration(.needsSignIn, platform: .macos), now: NOW, timeZone: LA)
        #expect(line == .init(text: "Amazon wants you to sign in again on your Mac.", isProblem: true))
    }

    @Test func handlesAParseFailureAndAnUnknownDevice() {
        let line = AmazonStatusText.elsewhere(integration(.parseFailed, platform: nil), now: NOW, timeZone: LA)
        #expect(line == .init(text: "Connected on another device, but it couldn't read your Amazon orders. An app update may fix it.", isProblem: true))
    }
}
