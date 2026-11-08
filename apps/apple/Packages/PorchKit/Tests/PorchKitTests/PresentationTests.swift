import Foundation
import Testing
@testable import PorchKit

// View-model logic the screens use: row text, search, timeline days, number
// parsing for Add, error wording, and Settings text. Mirrors apps/web's
// format.ts, parse.ts and pages/settings/time.ts where they exist.

/// A detector with fixed answers, so these tests don't depend on the detection port.
private struct FakeDetector: CarrierDetector {
    var answers: [String: [Candidate]]
    func normalize(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "").uppercased()
    }
    func detect(_ number: String) -> [Candidate] { answers[normalize(number)] ?? [] }
}

private let detector = FakeDetector(answers: [
    "1Z999AA10123456784": [Candidate(carrier: .ups, confidence: .high)],
    "CN123456785US": [Candidate(carrier: .usps, confidence: .medium), Candidate(carrier: .dhlEcommerce, confidence: .medium)],
    "9400100000000000000000": [Candidate(carrier: .usps, confidence: .medium)],
])

@Suite struct PackageTextTests {
    @Test func statusLine() {
        var p = makePackage("x", status: .outForDelivery)
        #expect(PackageText.statusLine(p) == "Out for delivery")
        p.statusDetail = "On vehicle, Oakland"
        #expect(PackageText.statusLine(p) == "Out for delivery · On vehicle, Oakland")
        p.statusDetail = "  out for delivery "
        #expect(PackageText.statusLine(p) == "Out for delivery")
    }

    @Test func search() {
        var p = makePackage("x")
        p.title = "Headphones"
        p.merchant = "Best Buy"
        p.items = [PackageItem(name: "USB-C cable")]
        #expect(PackageText.matches(p, query: ""))
        #expect(PackageText.matches(p, query: "  "))
        #expect(PackageText.matches(p, query: "head"))
        #expect(PackageText.matches(p, query: "best"))
        #expect(PackageText.matches(p, query: "ups"))
        #expect(PackageText.matches(p, query: "in transit"))
        #expect(PackageText.matches(p, query: "cable"))
        #expect(PackageText.matches(p, query: "1z999 aa10"))
        #expect(PackageText.matches(p, query: "6784"))
        #expect(!PackageText.matches(p, query: "socks"))
    }

    @Test func trackingURL() {
        #expect(PackageText.trackingURL(.ups, "1Z999AA10123456784")?.absoluteString == "https://www.ups.com/track?tracknum=1Z999AA10123456784")
        #expect(PackageText.trackingURL(.usps, "9400 1")?.absoluteString == "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201")
        #expect(PackageText.trackingURL(.uniuni, "X") == nil)
        #expect(PackageText.trackingURL(.other, "X") == nil)
        for carrier in Carrier.allCases {
            if let url = PackageText.trackingURL(carrier, "A1") { #expect(url.scheme == "https") }
        }
    }

    @Test func timelineGroupsByLocalDayNewestFirst() {
        let events = [
            TrackEvent(id: "3", packageId: "x", occurredAt: iso("2026-11-08T17:12:00.000Z"), status: .outForDelivery, description: "Out", location: "Oakland, CA"),
            TrackEvent(id: "2", packageId: "x", occurredAt: iso("2026-11-08T09:00:00.000Z"), status: .inTransit, description: "Arrived"),
            TrackEvent(id: "1", packageId: "x", occurredAt: iso("2026-11-08T07:00:00.000Z"), status: .inTransit, description: "Departed"),
        ]
        let days = PackageText.timelineDays(events, now: NOW, timeZone: LA)
        #expect(days.map(\.label) == ["Sun, Nov 8", "Sat, Nov 7"])
        #expect(days[0].entries.map(\.event.id) == ["3", "2"])
        #expect(days[0].entries[0].time == "9:12 AM")
        #expect(days[0].entries[0].meta == "Oakland, CA · 9:12 AM")
        #expect(days[0].entries[1].meta == "1:00 AM")
        #expect(days[1].entries.map(\.event.id) == ["1"])
    }

    @Test func refreshError() {
        let limited = APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "Slow down"), retryAfter: 90)
        #expect(PackageText.refreshErrorText(limited) == "Checked recently. Try again in 2 min")
        let noHeader = APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "Slow down"), retryAfter: nil)
        #expect(PackageText.refreshErrorText(noHeader) == "Checked recently. Try again in 2 min")
        let short = APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "x"), retryAfter: 5)
        #expect(PackageText.refreshErrorText(short) == "Checked recently. Try again in 1 min")
        #expect(PackageText.refreshErrorText(APIError.network("offline")) == "Couldn't reach Porchlight. Check your connection and try again.")
    }

    @Test func errorText() {
        #expect(ErrorText.sentence(APIError.network("x")) == "Couldn't reach Porchlight. Check your connection and try again.")
        let limited = APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "x"), retryAfter: 180)
        #expect(ErrorText.sentence(limited) == "Too many tries. Try again in 3 min.")
        let bad = APIError.server(status: 400, body: APIErrorBody(code: .badRequest, message: "trackingNumber is not valid"), retryAfter: nil)
        #expect(ErrorText.sentence(bad) == "trackingNumber is not valid")
        #expect(ErrorText.sentence(APIError.invalidResponse("x")) == "Porchlight sent a reply this app can't read. Try again later.")
        #expect(ErrorText.sentence(PorchError.notImplemented("sync()")) == "This part of the app isn't connected yet.")
        #expect(ErrorText.isUnauthorized(APIError.server(status: 401, body: APIErrorBody(code: .unauthorized, message: "x"), retryAfter: nil)))
        #expect(!ErrorText.isUnauthorized(APIError.network("x")))
    }
}

@Suite struct NumberInputTests {
    @Test func parsesOnePerLineDroppingBlanksAndRepeats() {
        let lines = NumberInput.parse("1z999aa10123456784\n\n  1Z999AA1 0123456784 \r\nCN123456785US\nabc-123", detector: detector)
        #expect(lines.map(\.number) == ["1Z999AA10123456784", "CN123456785US", "ABC123"])
    }

    @Test func preselectsOnlyASingleHighConfidenceMatch() {
        let lines = NumberInput.parse("1Z999AA10123456784\nCN123456785US\n9400100000000000000000\nABC", detector: detector)
        #expect(lines[0].preselected == .ups)
        #expect(!lines[0].ambiguous)
        #expect(lines[1].preselected == nil)
        #expect(lines[1].ambiguous)
        #expect(lines[2].preselected == nil) // one candidate, but not high confidence
        #expect(!lines[2].ambiguous)
        #expect(lines[3].candidates.isEmpty)
    }

    @Test func hints() {
        let lines = NumberInput.parse("1Z999AA10123456784\nCN123456785US\nABC", detector: detector)
        #expect(NumberInput.hint(lines[0]) == nil)
        #expect(NumberInput.hint(lines[1]) == "This number fits more than one carrier. Pick one.")
        #expect(NumberInput.hint(lines[2]) == "Porchlight doesn't recognize this format. It will still try to track it.")
    }

    @Test func validation() {
        let lines = NumberInput.parse("CN123456785US\n" + String(repeating: "9", count: 41), detector: detector)
        #expect(lines[1].tooLong)
        #expect(NumberInput.lineError(lines[0], carrier: nil) == "Pick a carrier for this number.")
        #expect(NumberInput.lineError(lines[0], carrier: .dhlEcommerce) == nil)
        #expect(NumberInput.lineError(lines[1], carrier: nil) == "This is too long to be a tracking number.")
        #expect(NumberInput.formError([]) == "Paste a tracking number.")
        #expect(NumberInput.formError(lines) == nil)
    }

    @Test func submitLabel() {
        #expect(NumberInput.submitLabel(count: 0) == "Track package")
        #expect(NumberInput.submitLabel(count: 1) == "Track package")
        #expect(NumberInput.submitLabel(count: 3) == "Track 3 packages")
    }

    @Test func appendingAScanAddsALine() {
        #expect(NumberInput.appending("1Z999AA10123456784", to: "") == "1Z999AA10123456784")
        #expect(NumberInput.appending("TBA123", to: "1Z999\n") == "1Z999\nTBA123")
        #expect(NumberInput.appending("TBA123", to: "1Z999") == "1Z999\nTBA123")
        #expect(NumberInput.appending("TBA123", to: "TBA123") == "TBA123") // already there
    }
}

@Suite struct SettingsTextTests {
    private func session(platform: Platform?, version: String? = "1.0 (12)", current: Bool = false) -> SessionInfo {
        SessionInfo(id: "s", platform: platform, appVersion: version, createdAt: iso("2026-11-02T10:00:00.000Z"),
                    lastSeenAt: iso("2026-11-08T15:00:00.000Z"), current: current)
    }

    @Test func platformLabels() {
        #expect(SettingsText.platformLabel(.ios) == "iPhone")
        #expect(SettingsText.platformLabel(.macos) == "Mac")
        #expect(SettingsText.platformLabel(.web) == "Web browser")
        #expect(SettingsText.platformLabel(nil) == "Unknown device")
    }

    @Test func sessionMeta() {
        #expect(SettingsText.sessionMeta(session(platform: .ios), now: NOW, timeZone: LA) == "Last active 3 h ago · Version 1.0 (12) · Signed in Nov 2")
        #expect(SettingsText.sessionMeta(session(platform: .web, version: nil, current: true), now: NOW, timeZone: LA) == "This device · Signed in Nov 2")
    }

    @Test(arguments: [
        ("2026-11-08T17:59:50.000Z", "just now"),
        ("2026-11-08T17:55:00.000Z", "5 min ago"),
        ("2026-11-08T15:00:00.000Z", "3 h ago"),
        ("2026-11-07T15:00:00.000Z", "yesterday"),
        ("2026-11-05T15:00:00.000Z", "3 days ago"),
        ("2026-10-30T15:00:00.000Z", "on Oct 30"),
        ("2025-10-30T15:00:00.000Z", "on Oct 30, 2025"),
        ("2026-11-08T19:00:00.000Z", "just now"),
    ])
    func agoLong(_ then: String, _ expected: String) {
        #expect(SettingsText.ago(iso(then), now: NOW, timeZone: LA) == expected)
    }

    @Test func tokenMeta() {
        let used = APITokenInfo(id: "t", label: "Flint on Mac", scopes: ["imports:write"], createdAt: iso("2026-11-01T10:00:00.000Z"),
                                lastUsedAt: iso("2026-11-08T17:46:00.000Z"))
        #expect(SettingsText.tokenMeta(used, now: NOW, timeZone: LA) == "Last used 14 min ago · Paired Nov 1")
        var unused = used
        unused.lastUsedAt = nil
        #expect(SettingsText.tokenMeta(unused, now: NOW, timeZone: LA) == "Not used yet · Paired Nov 1")
    }

    @Test func countdown() {
        #expect(SettingsText.countdown(545) == "9:05")
        #expect(SettingsText.countdown(544.2) == "9:05")
        #expect(SettingsText.countdown(59) == "0:59")
        #expect(SettingsText.countdown(-3) == "0:00")
    }

    @Test func deleteConfirmation() {
        #expect(SettingsText.confirmsDelete("delete"))
        #expect(SettingsText.confirmsDelete("  Delete "))
        #expect(!SettingsText.confirmsDelete("delet"))
        #expect(!SettingsText.confirmsDelete(""))
    }

    @Test func emailAndCode() {
        #expect(SignInText.isPlausibleEmail("me@example.com"))
        #expect(SignInText.isPlausibleEmail("  me@example.co.uk "))
        #expect(!SignInText.isPlausibleEmail("me@example"))
        #expect(!SignInText.isPlausibleEmail("@example.com"))
        #expect(!SignInText.isPlausibleEmail("me example@x.com"))
        #expect(!SignInText.isPlausibleEmail(""))
        #expect(SignInText.cleanCode("12 34-56") == "123456")
        #expect(SignInText.cleanCode("1234567") == "123456")
        #expect(SignInText.isCompleteCode("123456"))
        #expect(!SignInText.isCompleteCode("12345"))
    }
}
