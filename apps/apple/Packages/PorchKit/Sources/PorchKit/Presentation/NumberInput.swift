import Foundation

// Add by paste or scan (DESIGN.md §7 "Add"). A port of
// apps/web/src/packages/parse.ts and the checks in pages/AddPackage.tsx.

/// One pasted line, normalized, with what the detector made of it.
public struct ParsedNumber: Hashable, Sendable, Identifiable {
    /// No spaces or dashes, uppercase (CarrierDetector.normalize).
    public var number: String
    public var candidates: [Candidate]
    /// Picked without asking: a single high-confidence match.
    public var preselected: Carrier?
    /// The user has to choose between carriers.
    public var ambiguous: Bool
    public var tooLong: Bool
    public var id: String { number }
}

public enum NumberInput {
    /// Matches the server's limit; longer strings are not tracking numbers.
    public static let maxLength = 40

    /// One number per line; blank lines and repeats are dropped.
    public static func parse(_ text: String, detector: any CarrierDetector) -> [ParsedNumber] {
        var seen = Set<String>()
        var out: [ParsedNumber] = []
        for line in text.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let number = detector.normalize(trimmed)
            guard !number.isEmpty, seen.insert(number).inserted else { continue }
            let candidates = detector.detect(number)
            let only = candidates.count == 1 ? candidates.first : nil
            out.append(ParsedNumber(
                number: number,
                candidates: candidates,
                preselected: only?.confidence == .high ? only?.carrier : nil,
                ambiguous: candidates.count > 1,
                tooLong: number.count > maxLength
            ))
        }
        return out
    }

    /// The line under a number while typing.
    public static func hint(_ line: ParsedNumber) -> String? {
        if line.ambiguous { return "This number fits more than one carrier. Pick one." }
        if line.candidates.isEmpty { return "Porchlight doesn't recognize this format. It will still try to track it." }
        return nil
    }

    /// Why a line can't be sent yet, given the carrier picked for it.
    public static func lineError(_ line: ParsedNumber, carrier: Carrier?) -> String? {
        if line.tooLong { return "This is too long to be a tracking number." }
        if line.ambiguous && carrier == nil { return "Pick a carrier for this number." }
        return nil
    }

    public static func formError(_ lines: [ParsedNumber]) -> String? {
        lines.isEmpty ? "Paste a tracking number." : nil
    }

    public static func submitLabel(count: Int) -> String {
        count > 1 ? "Track \(count) packages" : "Track package"
    }

    /// Adds a scanned barcode as its own line, unless that exact line is already there.
    public static func appending(_ scanned: String, to text: String) -> String {
        let value = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        if value.isEmpty || lines.contains(value) { return text }
        let kept = lines.filter { !$0.isEmpty }
        return (kept + [value]).joined(separator: "\n")
    }
}
