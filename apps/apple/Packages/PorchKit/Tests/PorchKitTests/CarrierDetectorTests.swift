import Foundation
import Testing
@testable import PorchKit

// Data-driven from the shared fixtures (packages/carriers/fixtures/numbers.json),
// copied into Tests/Fixtures by apps/apple/scripts/sync-fixtures.sh together with
// detect-expected.json, which holds what the TypeScript detector returns for
// every fixture and for a list of edge-case probes.
//
// Fixture semantics (same as packages/carriers/test/detect.test.ts):
//   valid=true            -> detect(number) includes `carrier`
//   valid=false           -> detect(number) does not include `carrier`
//   carrier=other, valid  -> detect(number) returns no candidates

private struct NumberFixture: Decodable {
    let number: String
    let carrier: String
    let valid: Bool
    let note: String
}

private struct ExpectedEntry: Decodable {
    let input: String
    let normalized: String
    let candidates: [ExpectedCandidate]
}

private struct ExpectedCandidate: Decodable, Equatable, CustomStringConvertible {
    let carrier: String
    let confidence: String
    var description: String { "\(carrier):\(confidence)" }
}

private struct Expected: Decodable {
    let fixtures: [ExpectedEntry]
    let probes: [ExpectedEntry]
}

private enum Paths {
    /// .../Packages/PorchKit/Tests/PorchKitTests/CarrierDetectorTests.swift
    static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static let fixtures = testsDir.appendingPathComponent("Fixtures/numbers.json")
    static let expected = testsDir.appendingPathComponent("Fixtures/detect-expected.json")
    /// The source of truth, present when the tests run inside the porchlight repo.
    static let repoFixtures = testsDir
        .appendingPathComponent("../../../../../packages/carriers/fixtures/numbers.json")
        .standardizedFileURL
}

private func load<T: Decodable>(_ type: T.Type, _ url: URL) throws -> T {
    try JSONDecoder().decode(type, from: Data(contentsOf: url))
}

private let detector = RuleCarrierDetector()
private let rows: [NumberFixture] = (try? load([NumberFixture].self, Paths.fixtures)) ?? []
private let expected: Expected = (try? load(Expected.self, Paths.expected)) ?? Expected(fixtures: [], probes: [])

private func wire(_ cs: [Candidate]) -> [ExpectedCandidate] {
    cs.map { ExpectedCandidate(carrier: $0.carrier.rawValue, confidence: $0.confidence.rawValue) }
}

@Suite struct CarrierDetectorFixtureFiles {
    @Test func copiesLoad() throws {
        #expect(try load([NumberFixture].self, Paths.fixtures).count > 100)
        #expect(try load(Expected.self, Paths.expected).fixtures.count > 100)
    }

    @Test func copyMatchesTheRepoSource() throws {
        guard FileManager.default.fileExists(atPath: Paths.repoFixtures.path) else { return }
        let source = try Data(contentsOf: Paths.repoFixtures)
        let copy = try Data(contentsOf: Paths.fixtures)
        #expect(copy == source, "Tests/Fixtures/numbers.json is stale: run apps/apple/scripts/sync-fixtures.sh")
    }

    @Test func expectedOutputCoversEveryFixtureInOrder() {
        #expect(expected.fixtures.map(\.input) == rows.map(\.number),
                "detect-expected.json is stale: run apps/apple/scripts/sync-fixtures.sh")
    }

    @Test func coversEveryCarrierPorchlightDetects() {
        for carrier in ["usps", "ups", "fedex", "dhl", "dhl_ecommerce", "amazon", "ontrac", "uniuni"] {
            #expect(rows.contains { $0.carrier == carrier && $0.valid }, "\(carrier) valid")
            #expect(rows.contains { $0.carrier == carrier && !$0.valid }, "\(carrier) invalid")
        }
    }
}

@Suite struct CarrierDetectorTests {
    @Test(arguments: rows)
    fileprivate func followsFixtureSemantics(_ row: NumberFixture) {
        let found = detector.detect(row.number).map(\.carrier.rawValue)
        if row.carrier == "other" {
            #expect(found.isEmpty, "\(row.number) (\(row.note))")
        } else if row.valid {
            #expect(found.contains(row.carrier), "\(row.number) (\(row.note))")
        } else {
            #expect(!found.contains(row.carrier), "\(row.number) (\(row.note))")
        }
    }

    @Test(arguments: expected.fixtures + expected.probes)
    fileprivate func matchesTypeScriptExactly(_ entry: ExpectedEntry) {
        let label = String(entry.input.prefix(48)).debugDescription
        #expect(detector.normalize(entry.input) == entry.normalized, "normalize \(label)")
        #expect(wire(detector.detect(entry.input)) == entry.candidates, "detect \(label)")
    }

    @Test func returnsWellFormedCandidates() {
        for row in rows {
            let cs = detector.detect(row.number)
            let carriers = cs.map(\.carrier)
            #expect(Set(carriers).count == carriers.count, "\(row.number)")
            #expect(!carriers.contains(.other), "\(row.number)")
            #expect(cs.map(\.confidence) == cs.map(\.confidence).sorted(), "\(row.number)")
        }
    }
}

@Suite struct CarrierDetectorConfidenceTests {
    private func top(_ n: String) -> Candidate? { detector.detect(n).first }

    @Test func highForUniquePrefixWithPassingCheckDigit() {
        #expect(top("1Z5R89390357567127") == Candidate(carrier: .ups, confidence: .high))
        #expect(top("9400111206206406260787") == Candidate(carrier: .usps, confidence: .high))
        #expect(top("TBA000000000000") == Candidate(carrier: .amazon, confidence: .high))
        #expect(top("C11031500001879") == Candidate(carrier: .ontrac, confidence: .high))
        #expect(top("9611020987654312345672") == Candidate(carrier: .fedex, confidence: .high))
        #expect(top("RB123456785US") == Candidate(carrier: .usps, confidence: .high))
    }

    @Test func fedEx12CheckDigitBoostsButDoesNotFilter() {
        #expect(detector.detect("986578788855") == [Candidate(carrier: .fedex, confidence: .medium)])
        #expect(detector.detect("996578788855") == [Candidate(carrier: .fedex, confidence: .low)])
    }

    @Test func dhlExpress10DigitStaysLow() {
        #expect(detector.detect("3318810025") == [Candidate(carrier: .dhl, confidence: .low)])
    }

    @Test func prefersUSPSFor420PrefixedIMpb() {
        #expect(top("4201002334249200190132607600833457") == Candidate(carrier: .usps, confidence: .high))
    }

    @Test func inboundS10IsUSPSMedium() {
        #expect(top("RB123456785GB") == Candidate(carrier: .usps, confidence: .medium))
    }
}

@Suite struct NormalizeNumberTests {
    @Test func uppercasesAndDropsSeparators() {
        #expect(detector.normalize(" 1z 999-aa1.0123456784\n") == "1Z999AA10123456784")
        #expect(detector.normalize("9400 1112\t0108") == "940011120108")
    }

    @Test func stripsLaserShipSuffixOnly() {
        #expect(detector.normalize("1LS7119013618127-1") == "1LS7119013618127")
        #expect(detector.normalize("1LS7119013618127-2") == "1LS71190136181272")
    }

    @Test func isIdempotent() {
        for row in rows {
            let once = detector.normalize(row.number)
            #expect(detector.normalize(once) == once, "\(row.number)")
        }
    }

    @Test func junkNeverMatches() {
        for junk in ["", "\u{0}", "😀📦", String(repeating: "1Z", count: 5000), String(repeating: "9", count: 10_000)] {
            #expect(detector.detect(junk) == [])
        }
    }
}

@Suite struct ChecksumTests {
    @Test func charValueUsesTheUPSLetterMap() {
        #expect(Checksums.charValue("0") == 0)
        #expect(Checksums.charValue("9") == 9)
        #expect(Checksums.charValue("A") == 2)
        #expect(Checksums.charValue("H") == 9)
        #expect(Checksums.charValue("I") == 0)
        #expect(Checksums.charValue("Z") == 7)
    }

    @Test func knownCheckDigits() {
        // 1Z5R89390357567127: serial 5R8939035756712, check 7
        #expect(Checksums.mod10("5R8939035756712", evenMul: 1, oddMul: 2) == 7)
        #expect(Checksums.s10("12345678") == 5)
        #expect(Checksums.mod7("331881002") == 5)
        #expect(Checksums.weighted11("98657878885", weights: [3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1]) == 5)
    }
}
