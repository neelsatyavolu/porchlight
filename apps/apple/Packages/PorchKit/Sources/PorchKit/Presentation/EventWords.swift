import Foundation

/// Timeline wording for one carrier event: a generic "arrived at an Amazon
/// facility" names the town ("…at the Amazon facility in Haslet, TX"), and
/// places read the way people write them ("Haslet, TX", not "HASLET, TX US").
public enum EventWords {
    public struct Described: Hashable, Sendable {
        public var title: String
        /// The place is already in `title`, so the meta line shows only the time.
        public var placeInTitle: Bool
    }

    /// "an Amazon facility", "a carrier facility", "the USPS facility", …
    nonisolated(unsafe) private static let facility = /\b(?:an?|the) ((?:[A-Za-z]+ ){0,2})facility\b/

    public static func describe(_ description: String, location: String?) -> Described {
        guard let place = place(location),
              let match = description.firstMatch(of: facility) else {
            return Described(title: description, placeInTitle: false)
        }
        var title = description
        title.replaceSubrange(match.range, with: "the \(match.output.1)facility in \(place)")
        return Described(title: title, placeInTitle: true)
    }

    /// "Haslet, TX US" → "Haslet, TX"; "OAKLAND, CA, US" → "Oakland, CA"; UPS's "Palatine, IL, United States"
    /// → "Palatine, IL", and its bare "United States" → nil. Other countries keep their code.
    public static func place(_ location: String?) -> String? {
        guard let location else { return nil }
        var parts = location.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        if let last = parts.last, ["US", "USA", "United States"].contains(where: { last.caseInsensitiveCompare($0) == .orderedSame }) { parts.removeLast() }
        if let last = parts.last, last.hasSuffix(" US") { parts[parts.count - 1] = String(last.dropLast(3)) }
        guard !parts.isEmpty else { return nil }
        // A shouted town name reads better in title case; state and country codes stay as they are.
        if parts[0] == parts[0].uppercased(), parts[0].count > 3 { parts[0] = parts[0].capitalized }
        return parts.joined(separator: ", ")
    }

    /// The stops for the route map: each event's place, oldest first, with a
    /// place that repeats the one before it merged ("Oakland, CA" scanned
    /// three times in a row is one stop). Events without a place are skipped.
    public static func route(_ events: [TrackEvent]) -> [String] {
        let oldestFirst = events.enumerated().sorted {
            $0.element.occurredAt != $1.element.occurredAt
                ? $0.element.occurredAt < $1.element.occurredAt
                : $0.offset > $1.offset // same instant: the list is newest first
        }
        return oldestFirst.compactMap { place($0.element.location) }.reduce(into: []) { stops, place in
            if stops.last?.caseInsensitiveCompare(place) != .orderedSame { stops.append(place) }
        }
    }
}
