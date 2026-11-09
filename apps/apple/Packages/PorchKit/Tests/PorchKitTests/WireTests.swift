import Foundation
import Testing
@testable import PorchKit

/// The sync example from docs/API.md, with `etaDateOnly` added.
private let syncJSON = """
{
  "packages": [ {
    "id": "6f1c7a52-6b8e-4c1e-9a43-3b0f2d9a7c11", "carrier": "ups", "trackingNumber": "1Z999AA10123456784", "title": "Headphones", "merchant": "Best Buy",
    "orderId": null, "source": "flint", "status": "in_transit", "statusDetail": "Departed facility",
    "etaStart": "2026-11-10", "etaEnd": "2026-11-10", "etaDateOnly": true, "deliveredAt": null,
    "lastCheckedAt": "2026-11-08T17:00:00.000Z", "archivedAt": null, "updatedAt": "2026-11-08T17:00:01.000Z",
    "items": [ { "name": "Headphones", "imageUrl": null, "quantity": 1 } ]
  } ],
  "events": [ {
    "id": "0d9e0a1c-0000-4000-8000-000000000001", "packageId": "6f1c7a52-6b8e-4c1e-9a43-3b0f2d9a7c11", "occurredAt": "2026-11-08T09:12:00.000Z", "status": "in_transit",
    "description": "Departed FedEx location", "location": "Oakland, CA, US"
  } ],
  "deleted": ["2b1f0000-0000-4000-8000-000000000002"],
  "cursor": "opaque",
  "hasMore": false
}
"""

private func packageJSON(etaStart: String?, etaEnd: String?, dateOnly: Bool?) -> String {
    func q(_ s: String?) -> String { s.map { "\"\($0)\"" } ?? "null" }
    let flag = dateOnly.map { #", "etaDateOnly": \#($0)"# } ?? ""
    return """
    { "id": "a", "carrier": "usps", "trackingNumber": "9400111206206406260787", "title": null, "merchant": null,
      "orderId": null, "source": "manual", "status": "label_created", "statusDetail": null,
      "etaStart": \(q(etaStart)), "etaEnd": \(q(etaEnd))\(flag), "deliveredAt": null, "lastCheckedAt": null,
      "archivedAt": null, "updatedAt": "2026-11-08T17:00:00.000Z", "items": [] }
    """
}

@Suite struct WireTests {
    @Test func decodesTheSyncExample() throws {
        let page = try decode(SyncResponse.self, syncJSON)
        let pkg = try #require(page.packages.first)
        #expect(pkg.carrier == .ups)
        #expect(pkg.source == .flint)
        #expect(pkg.status == .inTransit)
        #expect(pkg.eta == .day(start: day("2026-11-10"), end: day("2026-11-10")))
        #expect(pkg.lastCheckedAt == iso("2026-11-08T17:00:00.000Z"))
        #expect(pkg.items == [PackageItem(name: "Headphones", imageUrl: nil, quantity: 1)])
        #expect(page.events.first?.location == "Oakland, CA, US")
        #expect(page.deleted == ["2b1f0000-0000-4000-8000-000000000002"])
        #expect(page.cursor == "opaque")
        #expect(page.hasMore == false)
    }

    @Test func decodesEachEtaShape() throws {
        #expect(try decode(Package.self, packageJSON(etaStart: nil, etaEnd: nil, dateOnly: false)).eta == .none)
        #expect(try decode(Package.self, packageJSON(etaStart: "2026-11-12", etaEnd: "2026-11-14", dateOnly: true)).eta
            == .day(start: day("2026-11-12"), end: day("2026-11-14")))
        #expect(try decode(Package.self, packageJSON(etaStart: "2026-11-12T22:00:00.000Z", etaEnd: "2026-11-13T02:00:00.000Z", dateOnly: false)).eta
            == .window(start: iso("2026-11-12T22:00:00.000Z"), end: iso("2026-11-13T02:00:00.000Z")))
        // Only etaEnd: kept as a single value so the deciding day is unchanged.
        #expect(try decode(Package.self, packageJSON(etaStart: nil, etaEnd: "2026-11-14", dateOnly: true)).eta
            == .day(start: day("2026-11-14"), end: nil))
        // A server that predates etaDateOnly sends instants and no flag.
        #expect(try decode(Package.self, packageJSON(etaStart: "2026-11-10T00:00:00.000Z", etaEnd: nil, dateOnly: nil)).eta
            == .window(start: iso("2026-11-10T00:00:00.000Z"), end: nil))
    }

    @Test func rejectsAMismatchedEta() {
        #expect(throws: DecodingError.self) { try decode(Package.self, packageJSON(etaStart: "2026-11-10T00:00:00.000Z", etaEnd: nil, dateOnly: true)) }
        #expect(throws: DecodingError.self) { try decode(Package.self, packageJSON(etaStart: "2026-11-10", etaEnd: nil, dateOnly: false)) }
    }

    @Test func packageRoundTripsWithExplicitNulls() throws {
        let page = try decode(SyncResponse.self, syncJSON)
        let pkg = try #require(page.packages.first)
        let object = try encodeObject(pkg)
        #expect(Set(object.keys) == [
            "id", "carrier", "trackingNumber", "title", "merchant", "orderId", "source", "status", "statusDetail",
            "etaStart", "etaEnd", "etaDateOnly", "deliveredAt", "lastCheckedAt", "archivedAt", "updatedAt", "items",
            "dataSource", "attribution",
        ])
        #expect(object["orderId"] is NSNull)
        #expect(object["etaStart"] as? String == "2026-11-10")
        #expect(object["etaDateOnly"] as? Bool == true)
        #expect(object["updatedAt"] as? String == "2026-11-08T17:00:01.000Z")
        let again = try WireJSON.decoder().decode(Package.self, from: WireJSON.encoder().encode(pkg))
        #expect(again == pkg)
    }

    @Test func toleratesUnknownCarrierAndStatus() throws {
        let json = packageJSON(etaStart: nil, etaEnd: nil, dateOnly: false)
            .replacingOccurrences(of: "\"usps\"", with: "\"pigeon\"")
            .replacingOccurrences(of: "\"label_created\"", with: "\"teleported\"")
        let pkg = try decode(Package.self, json)
        #expect(pkg.carrier == .other)
        #expect(pkg.status == .unknown)
    }

    @Test func parsesTimestampsWithOrWithoutMillisAndOffsets() {
        #expect(WireDate.parse("2026-11-08T17:04:00.000Z") == WireDate.parse("2026-11-08T17:04:00Z"))
        #expect(WireDate.parse("2026-11-08T09:04:00-08:00") == WireDate.parse("2026-11-08T17:04:00Z"))
        #expect(WireDate.format(iso("2026-11-08T17:04:00Z")) == "2026-11-08T17:04:00.000Z")
        #expect(WireDate.parse("Nov 8") == nil)
    }

    @Test func putRequestSendsOnlyWhatIsSet() throws {
        #expect(try encodeObject(PackagePutRequest()).isEmpty)
        let create = try encodeObject(PackagePutRequest(trackingNumber: "1Z999AA10123456784", title: .some("Headphones"), source: .share))
        #expect(create as NSDictionary == ["trackingNumber": "1Z999AA10123456784", "title": "Headphones", "source": "share"] as NSDictionary)
        let clear = try encodeObject(PackagePutRequest(title: .some(nil), archived: true))
        #expect(clear["title"] is NSNull)
        #expect(clear["archived"] as? Bool == true)
        #expect(clear["merchant"] == nil)
    }

    @Test func emailVerifyHasTwoShapes() throws {
        let link = try encodeObject(EmailVerifyRequest.token("t", client: .ios, deviceId: nil))
        #expect(link as NSDictionary == ["token": "t", "client": "ios"] as NSDictionary)
        let code = try encodeObject(EmailVerifyRequest.code(email: "a@b.c", code: "123456", client: .macos, deviceId: "d"))
        #expect(code as NSDictionary == ["email": "a@b.c", "code": "123456", "client": "macos", "deviceId": "d"] as NSDictionary)
    }

    @Test func amazonItemCarriesTheEtaFlag() throws {
        let item = AmazonImportItem(orderId: "112-1234567-1234567", shipmentId: "Dxyz", carrier: .amazon, trackingNumber: "TBA123456789012",
                                    title: "USB-C cable", items: [PackageItem(name: "USB-C cable", quantity: 2)],
                                    eta: .day(start: day("2026-11-09"), end: nil), observed: nil)
        let object = try encodeObject(item)
        #expect(object["etaStart"] as? String == "2026-11-09")
        #expect(object["etaEnd"] is NSNull)
        #expect(object["etaDateOnly"] as? Bool == true)
        #expect(object["observed"] == nil)
    }

    @Test func unwrapsSuccessAndErrorEnvelopes() throws {
        let ok = #"{ "ok": true, "data": { "signedOut": true }, "error": null }"#
        #expect(try Envelope<SignOutResponse>.unwrap(Data(ok.utf8), status: 200).signedOut)

        let dup = #"{ "ok": false, "data": null, "error": { "code": "conflict", "message": "Already tracked", "details": { "reason": "duplicate", "existingId": "e1" } } }"#
        do {
            _ = try Envelope<Package>.unwrap(Data(dup.utf8), status: 409)
            Issue.record("expected a throw")
        } catch let error as APIError {
            #expect(error.code == .conflict)
            #expect(error.conflict == .duplicate(existingId: "e1"))
        }

        let limited = #"{ "ok": false, "data": null, "error": { "code": "rate_limited", "message": "Slow down" } }"#
        #expect(throws: APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "Slow down"), retryAfter: 120)) {
            try Envelope<RefreshResponse>.unwrap(Data(limited.utf8), status: 429, retryAfter: 120)
        }

        #expect(throws: APIError.self) { try Envelope<MeResponse>.unwrap(Data("<html>".utf8), status: 502) }
    }

    @Test func devicesAndSessionsMatchTheContract() throws {
        let put = try encodeObject(DevicePutRequest(platform: .ios, apnsToken: nil, appVersion: "1.0 (12)", environment: .sandbox))
        #expect(put as NSDictionary == ["platform": "ios", "apnsToken": NSNull(), "appVersion": "1.0 (12)", "environment": "sandbox"] as NSDictionary)
        let device = try decode(Device.self, #"{ "id": "d", "platform": "macos", "apnsToken": "ab", "appVersion": null, "environment": "production" }"#)
        #expect(device.environment == .production)
        let list = try decode(SessionsResponse.self, #"{ "sessions": [ { "id": "s", "platform": null, "appVersion": null, "createdAt": "2026-11-01T10:00:00.000Z", "lastSeenAt": "2026-11-08T17:04:00.000Z", "current": true } ] }"#)
        #expect(list.sessions.first?.platform == nil)
        #expect(list.sessions.first?.current == true)
    }

    @Test func deletedConflictHasNoId() {
        #expect(PackageConflict(details: .object(["reason": .string("deleted")])) == .deleted)
        #expect(PackageConflict(details: .object(["reason": .string("duplicate")])) == nil)
    }
}
