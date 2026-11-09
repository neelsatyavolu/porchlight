import Foundation
import Testing
@testable import PorchKit

@Suite struct FlintConnectTests {
    private let pairing = PairingStartResponse(code: "ABCD-EFGH", expiresAt: iso("2026-11-08T18:10:00.000Z"))

    private func token(_ id: String, _ label: String = "Flint on Studio") -> APITokenInfo {
        APITokenInfo(id: id, label: label, scopes: ["imports:write"], createdAt: iso("2026-11-01T10:00:00.000Z"), lastUsedAt: nil)
    }

    @Test func pairLink() {
        #expect(FlintLink.pair(code: "ABCD-EFGH", host: "porchlight.xanom.co").absoluteString
            == "flint://porchlight/pair?code=ABCD-EFGH&host=porchlight.xanom.co")
        #expect(FlintLink.pair(code: "A B&C", host: "localhost:8787").absoluteString
            == "flint://porchlight/pair?code=A%20B%26C&host=localhost%3A8787")
        #expect(FlintLink.pair(code: "ABCD-EFGH").absoluteString.hasSuffix("host=\(PorchConfig.webHost)"))
        #expect(FlintLink.downloadURL.absoluteString == "https://flint.xanom.co")
    }

    @Test func waitsForATokenItHasNotSeen() {
        let attempt = FlintConnectAttempt(pairing: pairing, existing: [token("t1")], startedAt: NOW)
        let waiting = FlintConnectState.waiting(attempt, stalled: false)
        #expect(waiting.isPolling)
        #expect(waiting.polled([token("t1")], at: NOW.addingTimeInterval(2)) == waiting)
        let laptop = token("t2", "Flint on Laptop")
        #expect(waiting.polled([token("t1"), laptop], at: NOW.addingTimeInterval(4)) == .connected(laptop))
    }

    @Test func stallsAfterTwoMinutes() {
        let attempt = FlintConnectAttempt(pairing: pairing, existing: [], startedAt: NOW)
        let waiting = FlintConnectState.waiting(attempt, stalled: false)
        #expect(waiting.polled([], at: NOW.addingTimeInterval(119)) == waiting)
        let stalled = waiting.polled([], at: NOW.addingTimeInterval(120))
        #expect(stalled == .waiting(attempt, stalled: true))
        #expect(!stalled.isPolling)
        // A late poll after stalling or connecting changes nothing.
        #expect(stalled.polled([token("t9")], at: NOW.addingTimeInterval(130)) == stalled)
        #expect(FlintConnectState.idle.polled([token("t9")], at: NOW) == .idle)
    }

    @Test func pollTiming() {
        #expect(FlintConnectAttempt.pollInterval == .seconds(2))
        #expect(FlintConnectAttempt.timeout == 120)
    }

    @Test func wording() {
        #expect(FlintText.opening == "Opening Flint…")
        #expect(FlintText.connected(token("t1")) == "Connected to Flint on Studio")
        #expect(FlintText.phoneNote == "Flint runs on your Mac. Open Porchlight on your Mac, or Flint, to connect it.")
    }
}
