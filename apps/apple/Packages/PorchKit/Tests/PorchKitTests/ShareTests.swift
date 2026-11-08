import Foundation
import Synchronization
import Testing
@testable import PorchKit

private let UPS = "1Z999AA10123456784"
private let USPS = "9400111206206406260787"

@Suite struct SharedTextExtractorTests {
    private let extractor = SharedTextExtractor(detector: BGFakeDetector())

    private func numbers(_ text: String) -> [String] { extractor.numbers(in: text).map(\.number) }

    @Test func findsANumberInASentence() {
        let found = extractor.numbers(in: "Your order shipped! Tracking: \(UPS). Arrives Tuesday.")
        #expect(found.map(\.number) == [UPS])
        #expect(found.first?.carrier == .ups)
        #expect(found.first?.candidates == [Candidate(carrier: .ups, confidence: .high)])
    }

    @Test func joinsSpacedAndDashedGroups() {
        #expect(numbers("USPS 9400 1112 0620 6406 2607 87 is on its way") == [USPS])
        #expect(numbers("ref 1Z-999-AA1-0123-4567-84") == [UPS])
    }

    @Test func lowercaseIsNormalized() {
        #expect(numbers("1z999aa10123456784") == [UPS])
    }

    @Test func keepsTextOrderAndDedupes() {
        #expect(numbers("\(USPS) and \(UPS), again \(USPS)") == [USPS, UPS])
    }

    @Test func prefersTheLongestMatch() {
        // "7234 5678 9012" is a 12-digit low match; the whole 22-digit run wins.
        #expect(numbers("7234 5678 9012 3456 7890 12") == ["7234567890123456789012"])
        #expect(extractor.numbers(in: "7234 5678 9012").first?.candidates.count == 2)
    }

    @Test func doesNotJoinAcrossOtherPunctuation() {
        #expect(numbers("9400111206:206406260787") == [])
        #expect(numbers("9400 1112  0620 6406 2607 87") == [])
    }

    @Test func ignoresTextWithoutNumbers() {
        #expect(numbers("") == [])
        #expect(numbers("Thanks for your order, it ships soon") == [])
        #expect(numbers("Call 650-555-1234 on 2026-11-08") == [])
    }

    @Test func readsURLs() {
        let urls = [
            URL(string: "https://www.ups.com/track?loc=en_US&tracknum=\(UPS)&requester=ST")!,
            URL(string: "https://tools.usps.com/go/TrackConfirmAction?tLabels=\(USPS)")!,
            URL(string: "https://example.com/t/1Z%20999%20AA1%200123%204567%2084")!,
        ]
        #expect(extractor.numbers(inTexts: [], urls: urls).map(\.number) == [UPS, USPS])
    }

    @Test func combinesTextsAndURLs() {
        let found = extractor.numbers(inTexts: ["Track \(UPS)"], urls: [URL(string: "https://x.co/?n=\(USPS)&m=\(UPS)")!])
        #expect(found.map(\.number) == [UPS, USPS])
    }

    @Test func capsTheResults() {
        let many = (0..<30).map { String(format: "1Z999AA1012345%04d", $0) }.joined(separator: ", ")
        #expect(extractor.numbers(in: many).count == SharedTextExtractor.maxResults)
    }

    @Test func handlesNonBreakingSpaces() {
        #expect(numbers("9400\u{00A0}1112\u{00A0}0620\u{00A0}6406\u{00A0}2607\u{00A0}87") == [USPS])
    }
}

@Suite struct ShareSubmitterTests {
    private let ups = SharedNumber(number: UPS, candidates: [Candidate(carrier: .ups, confidence: .high)])
    private let usps = SharedNumber(number: USPS, candidates: [Candidate(carrier: .usps, confidence: .medium)])

    @Test func putsEachNumberWithSourceShare() async {
        let api = BGFakeAPI()
        let ids = ["id-1", "id-2"]
        let counter = BGCounter()
        let submitter = ShareSubmitter(api: api, newId: { ids[counter.next()] })
        let outcomes = await submitter.submit([ups, usps])
        #expect(outcomes == [.added(packageId: "id-1"), .added(packageId: "id-2")])
        let puts = api.packagePuts.withLock { $0 }
        #expect(puts.map(\.0) == ids)
        #expect(puts[0].1 == PackagePutRequest(trackingNumber: UPS, carrier: .ups, source: .share))
        #expect(puts[1].1 == PackagePutRequest(trackingNumber: USPS, carrier: .usps, source: .share))
    }

    @Test func defaultIdsAreLowercaseUUIDs() async throws {
        let api = BGFakeAPI()
        _ = await ShareSubmitter(api: api).submit([ups])
        let id = try #require(api.packagePuts.withLock { $0.first?.0 })
        #expect(UUID(uuidString: id) != nil)
        #expect(id == id.lowercased())
    }

    @Test func mapsErrors() async {
        let api = BGFakeAPI(packageErrors: [
            UPS: serverError(409, .conflict, details: .object(["reason": .string("duplicate"), "existingId": .string("old")])),
            USPS: serverError(401, .unauthorized),
        ])
        #expect(await ShareSubmitter(api: api).submit([ups, usps]) == [.alreadyTracked(packageId: "old"), .failed(.signedOut)])
    }

    @Test func mapsOtherFailures() async {
        func one(_ error: APIError) async -> ShareOutcome? {
            await ShareSubmitter(api: BGFakeAPI(packageErrors: [UPS: error])).submit([ups]).first
        }
        #expect(await one(.network("offline")) == .failed(.offline))
        #expect(await one(serverError(429, .rateLimited)) == .failed(.rateLimited))
        #expect(await one(serverError(500, .internal)) == .failed(.server))
        #expect(await one(.invalidResponse("x")) == .failed(.server))
    }
}

@Suite struct ShareSummaryTests {
    @Test func summarizes() {
        #expect(ShareOutcome.summary([.added(packageId: "a")]) == "Added to Porchlight.")
        #expect(ShareOutcome.summary([.added(packageId: "a"), .added(packageId: "b")]) == "Added 2 packages to Porchlight.")
        #expect(ShareOutcome.summary([.alreadyTracked(packageId: "a")]) == "Porchlight is already tracking this package.")
        #expect(ShareOutcome.summary([.alreadyTracked(packageId: "a"), .alreadyTracked(packageId: "b")])
            == "Porchlight is already tracking these packages.")
        #expect(ShareOutcome.summary([.added(packageId: "a"), .alreadyTracked(packageId: "b")]) == "Added 1. 1 was already tracked.")
        #expect(ShareOutcome.summary([.failed(.signedOut)]) == "Open Porchlight and sign in, then share again.")
        #expect(ShareOutcome.summary([.added(packageId: "a"), .failed(.offline)])
            == "Added 1. Couldn't reach Porchlight. Check your connection and try again.")
        #expect(ShareOutcome.summary([.failed(.rateLimited)]) == "Too many requests. Wait a minute and try again.")
        #expect(ShareOutcome.summary([.failed(.server)]) == "Porchlight couldn't add this right now. Try again later.")
    }

    @Test func isCompleteOnlyWithoutFailures() {
        #expect(ShareOutcome.allSucceeded([.added(packageId: "a"), .alreadyTracked(packageId: "b")]))
        #expect(!ShareOutcome.allSucceeded([.added(packageId: "a"), .failed(.offline)]))
        #expect(!ShareOutcome.allSucceeded([]))
    }
}

/// Hands out 0, 1, 2, ... across concurrent callers.
private final class BGCounter: Sendable {
    private let value = Mutex(0)
    func next() -> Int { value.withLock { v in defer { v += 1 }; return v } }
}
