import Foundation

/// Swift twin of packages/carriers/src/detect/normalize.ts.
enum NumberNormalizer {
    /// Longest input we bother normalizing; real tracking numbers are at most 40 chars.
    static let maxRawLength = 200

    // LaserShip 1LS7 (18) ends in a meaningful "-1"; drop it and keep the base number.
    private static let laserShipSuffix = JSRegex(#"^(?<base>1LS7[12]\d{2}01[1-4]\d{6})-1$"#)

    static func normalize(_ raw: String) -> String {
        // JS slices UTF-16 code units, so a split surrogate pair is possible;
        // here it decodes as U+FFFD, which no rule matches either.
        let sliced = String(decoding: Array(raw.utf16.prefix(maxRawLength)), as: UTF16.self)
        let compact = filter(sliced.uppercased()) { !isJSWhitespace($0) }
        let base = laserShipSuffix.firstMatch(in: compact)?["base"] ?? compact
        return filter(base) { !isJSWhitespace($0) && !isSeparator($0) }
    }

    private static func filter(_ s: String, _ keep: (Unicode.Scalar) -> Bool) -> String {
        var out = String.UnicodeScalarView()
        out.append(contentsOf: s.unicodeScalars.filter(keep))
        return String(out)
    }

    /// The set JavaScript's `\s` matches (ECMA-262 WhiteSpace + LineTerminator).
    /// U+0085 and U+200B are not in it.
    static func isJSWhitespace(_ c: Unicode.Scalar) -> Bool {
        switch c.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            true
        default:
            false
        }
    }

    /// `-`, `.`, U+2010...U+2015 (hyphens and dashes) and U+2212 (minus).
    private static func isSeparator(_ c: Unicode.Scalar) -> Bool {
        switch c.value {
        case 0x2D, 0x2E, 0x2010...0x2015, 0x2212: true
        default: false
        }
    }
}
