// CONTRACT: Swift port of detectCarrier / normalizeNumber in
// packages/carriers/src/detect.ts. Both must pass the shared fixtures in
// packages/carriers/fixtures/numbers.json (SPEC §2).

public enum Confidence: String, Sendable, Hashable, Codable, Comparable {
    case high, medium, low

    private var rank: Int {
        switch self {
        case .high: 0
        case .medium: 1
        case .low: 2
        }
    }

    /// `.high < .medium < .low`, so sorting ascending puts the best first.
    public static func < (a: Confidence, b: Confidence) -> Bool { a.rank < b.rank }
}

/// One possible carrier for a tracking number.
public struct Candidate: Hashable, Sendable, Codable {
    public var carrier: Carrier
    public var confidence: Confidence

    public init(carrier: Carrier, confidence: Confidence) {
        self.carrier = carrier
        self.confidence = confidence
    }
}

public protocol CarrierDetector: Sendable {
    /// Canonical form of a pasted number: trims, drops spaces and dashes,
    /// uppercases. Matches normalizeNumber in TypeScript exactly.
    func normalize(_ raw: String) -> String
    /// Every plausible carrier, highest confidence first; [] when none.
    /// Normalizes its input and never throws.
    func detect(_ number: String) -> [Candidate]
}

/// Format + checksum detection, ported rule for rule from packages/carriers
/// (see Detection/). Tests check it against the TypeScript output for every
/// shared fixture.
public struct RuleCarrierDetector: CarrierDetector {
    public init() {}
    public func normalize(_ raw: String) -> String { NumberNormalizer.normalize(raw) }
    public func detect(_ number: String) -> [Candidate] { Detection.detect(number) }
}
