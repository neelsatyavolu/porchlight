// Check-digit algorithms used by the detection rules. Swift twin of
// packages/carriers/src/detect/checksums.ts, which ports the checksum
// definitions in jkeen/tracking_number_data (MIT, (c) 2017 Jeff Keen),
// pinned at commit 03af203 (v2.0.0). See docs/research/number-formats.md.

enum Checksums {
    /// Digit value; letters use the UPS map (A=2 ... H=9, I=0 ...).
    /// Callers only pass characters a rule's pattern matched ([0-9A-Z]).
    static func charValue(_ c: Unicode.Scalar) -> Int {
        let code = Int(c.value)
        if code >= 48 && code <= 57 { return code - 48 }
        return (code - 3) % 10
    }

    /// jkeen "mod10": positions counted from 0, even positions times evenMul
    /// and odd positions times oddMul, optionally over the reversed sequence.
    static func mod10(_ seq: String, evenMul: Int, oddMul: Int, reverse: Bool = false) -> Int {
        let chars = reverse ? Array(seq.unicodeScalars.reversed()) : Array(seq.unicodeScalars)
        var total = 0
        for (i, c) in chars.enumerated() {
            total += charValue(c) * (i % 2 == 0 ? evenMul : oddMul)
        }
        return (10 - (total % 10)) % 10
    }

    /// jkeen "sum_product_with_weightings_and_modulo" with modulo1 11, modulo2 10.
    static func weighted11(_ seq: String, weights: [Int]) -> Int {
        (weighted(seq, weights) % 11) % 10
    }

    private static let s10Weights = [8, 6, 4, 2, 3, 5, 9, 7]

    /// UPU S10 check digit over the 8-digit serial.
    static func s10(_ serial8: String) -> Int {
        let r = weighted(serial8, s10Weights) % 11
        let c = 11 - r
        if c == 10 { return 0 }
        if c == 11 { return 5 }
        return c
    }

    /// DHL Express: the number before the check digit, mod 7.
    static func mod7(_ seq: String) -> Int {
        var r = 0
        for c in seq.unicodeScalars { r = (r * 10 + charValue(c)) % 7 }
        return r
    }

    /// Weights past the end of `weights` count as 0, as in the TypeScript.
    private static func weighted(_ seq: String, _ weights: [Int]) -> Int {
        var total = 0
        for (i, c) in seq.unicodeScalars.enumerated() {
            total += charValue(c) * (i < weights.count ? weights[i] : 0)
        }
        return total
    }
}
