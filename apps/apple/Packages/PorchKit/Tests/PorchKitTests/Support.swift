import Foundation
@testable import PorchKit

let LA = TimeZone(identifier: "America/Los_Angeles")!
let TOKYO = TimeZone(identifier: "Asia/Tokyo")!
/// Sunday, Nov 8 2026, 10:00 AM in LA (Monday 3 AM in Tokyo). Same clock as apps/web's tests.
let NOW = iso("2026-11-08T18:00:00.000Z")

func iso(_ s: String) -> Date {
    guard let d = WireDate.parse(s) else { fatalError("bad date \(s)") }
    return d
}

func day(_ s: String) -> CalendarDate {
    guard let d = CalendarDate(s) else { fatalError("bad day \(s)") }
    return d
}

func makePackage(
    _ id: String, status: Status = .inTransit, eta: ETA = .none, deliveredAt: String? = nil,
    updatedAt: String = "2026-11-08T17:00:00.000Z"
) -> Package {
    Package(id: id, carrier: .ups, trackingNumber: "1Z999AA10123456784", status: status, eta: eta,
            deliveredAt: deliveredAt.map(iso), updatedAt: iso(updatedAt))
}

func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try WireJSON.decoder().decode(type, from: Data(json.utf8))
}

func encodeObject(_ value: some Encodable) throws -> [String: Any] {
    let data = try WireJSON.encoder().encode(value)
    return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any] ?? [:]
}
