import Foundation

/// Turns an Amazon listing name ("Anker USB C Cable, 240W Type C Fast Charging
/// Cord (1-Pack, 6 ft, Black) | USB 2.0 for iPhone…") into what a person would
/// call it ("Anker USB-C cable"), for package titles. Item lists keep the full name.
public protocol ItemNameShortening: Sendable {
    func shortName(_ name: String) async -> String
}

/// The rule-based shortener: cuts at the first break in the listing (a comma,
/// "|", " - ", "("), then at " for " or " with ", then caps it at six words.
/// Used where Apple's on-device model isn't available, and as its fallback.
public struct RuleItemNames: ItemNameShortening {
    static let maxWords = 6
    /// A part shorter than this before a break isn't a name on its own ("4K, …").
    static let minPrefix = 8

    public init() {}

    public func shortName(_ name: String) async -> String { Self.short(name) }

    public static func short(_ name: String) -> String {
        var s = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if words(s) <= maxWords && !s.contains(where: { ",|(".contains($0) }) { return s }
        s = before(s, any: [",", " | ", "|", " - ", " – ", " — ", " (", "("])
        if words(s) > maxWords { s = before(s, any: [" for ", " with ", " With ", " For "]) }
        let parts = s.split(separator: " ")
        if parts.count > maxWords { s = parts.prefix(maxWords).joined(separator: " ") }
        return s
    }

    private static func words(_ s: String) -> Int { s.split(separator: " ").count }

    /// The text before the earliest separator that leaves a usable name, else all of it.
    private static func before(_ s: String, any separators: [String]) -> String {
        let cuts = separators.compactMap { s.range(of: $0)?.lowerBound }
            .filter { s.distance(from: s.startIndex, to: $0) >= minPrefix }
        guard let cut = cuts.min() else { return s }
        return String(s[..<cut]).trimmingCharacters(in: .whitespaces)
    }
}

extension AmazonImportBuilder {
    /// `title(for:)` with the first item's name shortened.
    public static func shortTitle(for items: [PackageItem], names: any ItemNameShortening) async -> String? {
        guard let first = items.first else { return nil }
        let name = await names.shortName(first.name)
        return items.count == 1 ? name : "\(name) and \(items.count - 1) more"
    }
}
