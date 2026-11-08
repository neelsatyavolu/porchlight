import Foundation

/// A regex written in the JavaScript dialect of packages/carriers, compiled for
/// ICU so it matches the same strings:
/// - `\d` becomes `[0-9]` (ICU's `\d` also matches other scripts' digits).
/// - `$` becomes `\z` (ICU's `$` also matches before a final line break,
///   such as U+0085, which normalization keeps).
/// The patterns never use `$` or `\d` as literals, so a plain swap is safe.
struct JSRegex: Sendable {
    private let regex: NSRegularExpression

    init(_ jsPattern: String) {
        let icu = jsPattern
            .replacingOccurrences(of: #"\d"#, with: "[0-9]")
            .replacingOccurrences(of: "$", with: #"\z"#)
        do {
            regex = try NSRegularExpression(pattern: icu)
        } catch {
            preconditionFailure("bad detection pattern \(jsPattern): \(error)")
        }
    }

    func firstMatch(in s: String) -> Match? {
        let ns = s as NSString
        guard let m = regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return Match(source: ns, result: m)
    }

    struct Match {
        fileprivate let source: NSString
        fileprivate let result: NSTextCheckingResult

        /// UTF-16 length of the whole match, like `m[0].length` in JS.
        var length: Int { result.range.length }

        /// A named group, or nil when it did not take part in the match.
        subscript(_ name: String) -> String? {
            let r = result.range(withName: name)
            return r.location == NSNotFound ? nil : source.substring(with: r)
        }
    }
}
