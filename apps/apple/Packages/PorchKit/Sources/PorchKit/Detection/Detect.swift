/// Swift twin of detectCarrier in packages/carriers/src/detect.ts.
enum Detection {
    /// No real tracking number is longer than this after normalization.
    static let maxNumberLength = 40

    static func detect(_ number: String) -> [Candidate] {
        let n = NumberNormalizer.normalize(number)
        // JS compares UTF-16 length.
        let length = n.utf16.count
        if length == 0 || length > maxNumberLength { return [] }

        // Best grade per carrier, in the order each carrier first matched (a JS Map).
        var best: [Candidate] = []
        for rule in detectionRules {
            guard let m = rule.pattern.firstMatch(in: n), let conf = rule.grade(m) else { continue }
            if let i = best.firstIndex(where: { $0.carrier == rule.carrier }) {
                if conf < best[i].confidence { best[i] = Candidate(carrier: rule.carrier, confidence: conf) }
            } else {
                best.append(Candidate(carrier: rule.carrier, confidence: conf))
            }
        }
        // Stable sort by confidence: ties keep first-match order, as in TS.
        return best.enumerated()
            .sorted { ($0.element.confidence, $0.offset) < ($1.element.confidence, $1.offset) }
            .map(\.element)
    }
}
