import Foundation

/// A tracking number found in shared text, with the carriers it could be.
public struct SharedNumber: Identifiable, Hashable, Sendable {
    /// Normalized (`CarrierDetector.normalize`).
    public var number: String
    /// Highest confidence first; never empty.
    public var candidates: [Candidate]

    public init(number: String, candidates: [Candidate]) {
        self.number = number
        self.candidates = candidates
    }

    public var id: String { number }
    public var carrier: Carrier { candidates.first?.carrier ?? .other }
}

/// Pulls tracking numbers out of text and URLs from the share sheet.
///
/// A regex finds runs of letters and digits joined by single spaces or
/// dashes ("9400 1112 0620 ..."). Inside each run, every window of
/// consecutive groups is tried with the `CarrierDetector`; the longest
/// windows that detect win, without overlapping. Only numbers the detector
/// accepts are returned, in the order they appear.
public struct SharedTextExtractor: Sendable {
    /// Text beyond this is ignored. Shipping emails put the number near the top.
    public static let maxInputLength = 20_000
    public static let maxResults = 10
    /// The detector rejects anything longer (MAX_NUMBER_LENGTH in detect.ts).
    static let maxNumberLength = 40
    static let minNumberLength = 8
    static let minDigits = 4

    private let detector: any CarrierDetector

    public init(detector: any CarrierDetector) {
        self.detector = detector
    }

    /// Texts first, then URLs, deduplicated.
    public func numbers(inTexts texts: [String], urls: [URL] = []) -> [SharedNumber] {
        var seen = Set<String>()
        var found: [SharedNumber] = []
        for text in texts + urls.map(Self.text(of:)) {
            for n in numbers(in: text) where seen.insert(n.number).inserted {
                found.append(n)
                if found.count == Self.maxResults { return found }
            }
        }
        return found
    }

    public func numbers(in text: String) -> [SharedNumber] {
        let cleaned = String(text.prefix(Self.maxInputLength)).replacingOccurrences(of: "\u{00A0}", with: " ")
        var seen = Set<String>()
        var found: [SharedNumber] = []
        for match in cleaned.matches(of: #/[A-Za-z0-9]+(?:[ \-][A-Za-z0-9]+)*/#) {
            for n in numbers(inRun: match.output) where seen.insert(n.number).inserted {
                found.append(n)
                if found.count == Self.maxResults { return found }
            }
        }
        return found
    }

    /// One run of groups, e.g. "Tracking 1Z 999 AA1 0123 4567 84 shipped".
    private func numbers(inRun run: Substring) -> [SharedNumber] {
        let groups = run.split(whereSeparator: { $0 == " " || $0 == "-" }).map(String.init)
        guard groups.joined().count(where: \.isNumber) >= Self.minDigits else { return [] }

        var hits: [(range: Range<Int>, number: SharedNumber)] = []
        for start in groups.indices {
            var joined = ""
            for end in start..<groups.count {
                joined += groups[end]
                if joined.count > Self.maxNumberLength { break }
                guard joined.count >= Self.minNumberLength, joined.count(where: \.isNumber) >= Self.minDigits else { continue }
                let candidates = detector.detect(joined)
                guard !candidates.isEmpty else { continue }
                hits.append((start..<(end + 1), SharedNumber(number: detector.normalize(joined), candidates: candidates)))
            }
        }

        // Longest first, then best confidence, then earliest; keep the ones that don't overlap.
        let ranked = hits.sorted { a, b in
            if a.number.number.count != b.number.number.count { return a.number.number.count > b.number.number.count }
            let ca = a.number.candidates[0].confidence, cb = b.number.candidates[0].confidence
            if ca != cb { return ca < cb }
            return a.range.lowerBound < b.range.lowerBound
        }
        var taken: [(range: Range<Int>, number: SharedNumber)] = []
        for hit in ranked where !taken.contains(where: { $0.range.overlaps(hit.range) }) {
            taken.append(hit)
        }
        return taken.sorted { $0.range.lowerBound < $1.range.lowerBound }.map(\.number)
    }

    /// A URL as text: percent-decoded, with `+` as a space, so query values
    /// and path parts become separate runs.
    static func text(of url: URL) -> String {
        let raw = url.absoluteString.replacingOccurrences(of: "+", with: " ")
        return raw.removingPercentEncoding ?? raw
    }
}
