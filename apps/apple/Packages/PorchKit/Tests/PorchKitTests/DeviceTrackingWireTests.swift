import Foundation
import Testing
@testable import PorchKit

/// Package `dataSource` / `attribution` and the device-tracking bodies in docs/API.md.
@Suite struct DeviceTrackingWireTests {
    private func packageJSON(extra: String) -> String {
        """
        { "id": "a", "carrier": "dhl", "trackingNumber": "1234567890", "title": null, "merchant": null,
          "orderId": null, "source": "manual", "status": "delivered", "statusDetail": null,
          "etaStart": null, "etaEnd": null, "etaDateOnly": false, "deliveredAt": "2026-11-08T17:00:00.000Z",
          "lastCheckedAt": null, "archivedAt": null, "updatedAt": "2026-11-08T17:00:00.000Z", "items": []\(extra) }
        """
    }

    @Test func decodesDataSourceAndAttribution() throws {
        let pkg = try decode(Package.self, packageJSON(extra: #", "dataSource": "api", "attribution": "Delivered by Deutsche Post DHL Group""#))
        #expect(pkg.dataSource == .api)
        #expect(pkg.attribution == "Delivered by Deutsche Post DHL Group")
        let again = try WireJSON.decoder().decode(Package.self, from: WireJSON.encoder().encode(pkg))
        #expect(again == pkg)
    }

    @Test func toleratesMissingOrUnknownDataSource() throws {
        let old = try decode(Package.self, packageJSON(extra: ""))
        #expect(old.dataSource == nil)
        #expect(old.attribution == nil)
        let future = try decode(Package.self, packageJSON(extra: #", "dataSource": "carrier_pigeon", "attribution": null"#))
        #expect(future.dataSource == nil)
        let object = try encodeObject(old)
        #expect(object["dataSource"] is NSNull)
        #expect(object["attribution"] is NSNull)
    }

    @Test func decodesTheDueExample() throws {
        let json = """
        { "jobs": [
          { "packageId": "p1", "carrier": "usps", "trackingNumber": "9400111206206406260787", "reason": "scheduled" },
          { "packageId": "p2", "carrier": "ups", "trackingNumber": "1Z999AA10123456784", "reason": "server_blocked" },
          { "packageId": "p3", "carrier": "fedex", "trackingNumber": "123456789012", "reason": "teleport" }
        ] }
        """
        let jobs = try decode(DeviceJobsResponse.self, json).jobs
        #expect(jobs.map(\.carrier) == [.usps, .ups, .fedex])
        #expect(jobs.map(\.reason) == [.scheduled, .serverBlocked, .scheduled])
        #expect(jobs.allSatisfy { $0.carrier.isDeviceCarrier })
        #expect(!Carrier.dhl.isDeviceCarrier)
    }

    @Test func encodesAnOkObservationWithEveryKey() throws {
        let observation = DeviceObservation(
            observedAt: iso("2026-11-09T14:00:00.000Z"), outcome: .ok, status: .outForDelivery, statusDetail: "Out for Delivery",
            eta: .day(start: day("2026-11-09"), end: day("2026-11-09")), deliveredAt: nil,
            events: [ObservedEvent(occurredAt: iso("2026-11-09T13:05:00.000Z"), status: .outForDelivery,
                                   description: "Out for Delivery", location: "San Jose, CA 95112")])
        let object = try encodeObject(observation)
        #expect(Set(object.keys) == [
            "observedAt", "source", "outcome", "status", "statusDetail", "etaStart", "etaEnd", "etaDateOnly", "deliveredAt", "events",
        ])
        #expect(object["source"] as? String == "device")
        #expect(object["outcome"] as? String == "ok")
        #expect(object["status"] as? String == "out_for_delivery")
        #expect(object["observedAt"] as? String == "2026-11-09T14:00:00.000Z")
        #expect(object["etaStart"] as? String == "2026-11-09")
        #expect(object["etaDateOnly"] as? Bool == true)
        #expect(object["deliveredAt"] is NSNull)
        let event = try #require((object["events"] as? [[String: Any]])?.first)
        #expect(event["occurredAt"] as? String == "2026-11-09T13:05:00.000Z")
        #expect(event["location"] as? String == "San Jose, CA 95112")
    }

    @Test func encodesAReadWithoutData() throws {
        let object = try encodeObject(DeviceObservation.withoutData(.challenged, observedAt: NOW))
        #expect(object["outcome"] as? String == "challenged")
        #expect(object["status"] as? String == "unknown")
        #expect(object["statusDetail"] is NSNull)
        #expect(object["etaStart"] is NSNull)
        #expect(object["etaEnd"] is NSNull)
        #expect(object["etaDateOnly"] as? Bool == false)
        #expect((object["events"] as? [Any])?.isEmpty == true)
        #expect(try encodeObject(DeviceObservation.withoutData(.notFound, observedAt: NOW))["outcome"] as? String == "not_found")
    }

    @Test func decodesTheObservedReply() throws {
        let later = try decode(DeviceObservedResponse.self, #"{ "applied": false, "deviceNeededAt": "2026-11-09T15:00:00.000Z" }"#)
        #expect(later == DeviceObservedResponse(applied: false, deviceNeededAt: iso("2026-11-09T15:00:00.000Z")))
        let done = try decode(DeviceObservedResponse.self, #"{ "applied": true, "deviceNeededAt": null }"#)
        #expect(done == DeviceObservedResponse(applied: true, deviceNeededAt: nil))
    }
}
