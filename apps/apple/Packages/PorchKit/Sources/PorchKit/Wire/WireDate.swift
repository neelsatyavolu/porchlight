import Foundation

/// ISO 8601 timestamps as the API writes them: UTC with milliseconds
/// ("2026-11-08T17:04:00.000Z"). Parsing also accepts no fractional seconds
/// and numeric offsets, since carrier event times may carry one.
public enum WireDate {
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    public static func format(_ date: Date) -> String {
        withFraction.format(date)
    }

    public static func parse(_ string: String) -> Date? {
        (try? withFraction.parse(string)) ?? (try? plain.parse(string))
    }

    static func parse(_ string: String, codingPath: [any CodingKey]) throws -> Date {
        guard let date = parse(string) else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Expected an ISO 8601 timestamp, got \(string)"))
        }
        return date
    }
}

/// The JSON coders every PorchKit wire type is meant to go through.
public enum WireJSON {
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            return try WireDate.parse(try c.decode(String.self), codingPath: decoder.codingPath)
        }
        return d
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(WireDate.format(date))
        }
        e.outputFormatting = [.sortedKeys]
        return e
    }
}

/// Lowercase UUID strings, as the API requires for client-generated ids.
public enum WireID {
    public static func make() -> String { UUID().uuidString.lowercased() }
}
