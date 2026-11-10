import Foundation
import Testing
@testable import PorchKit

private let ID = "6f1c7a52-6b8e-4c1e-9a43-3b0f2d9a7c11"

@Suite struct PushPayloadTests {
    // Shapes from buildPush in services/api/src/lib/apns.ts.
    @Test func readsAVisiblePush() throws {
        let info: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Headphones", "body": "Out for delivery"], "sound": "default"],
            "packageId": ID,
        ]
        let payload = try #require(PushPayload(userInfo: info))
        #expect(payload.kind == .alert)
        #expect(payload.packageId == ID)
        #expect(payload.deepLink == .package(id: ID))
    }

    @Test func readsASilentPush() throws {
        let info: [AnyHashable: Any] = ["aps": ["content-available": 1], "packageId": ID]
        let payload = try #require(PushPayload(userInfo: info))
        #expect(payload.kind == .background)
        #expect(payload.packageId == ID)
    }

    @Test func acceptsContentAvailableAsNSNumber() throws {
        let info: [AnyHashable: Any] = ["aps": ["content-available": NSNumber(value: 1)]]
        #expect(PushPayload(userInfo: info)?.kind == .background)
    }

    @Test func readsTheServersCheckNowWake() throws {
        let wake: [AnyHashable: Any] = ["aps": ["content-available": 1], "wake": "check"]
        #expect(PushPayload(userInfo: wake)?.wantsCheck == true)
        let change: [AnyHashable: Any] = ["aps": ["content-available": 1], "packageId": ID]
        #expect(PushPayload(userInfo: change)?.wantsCheck == false)
    }

    @Test func lowercasesTheId() throws {
        let info: [AnyHashable: Any] = ["aps": ["content-available": 1], "packageId": ID.uppercased()]
        #expect(PushPayload(userInfo: info)?.packageId == ID)
    }

    @Test func dropsAnIdThatIsNotAUUID() throws {
        let info: [AnyHashable: Any] = ["aps": ["alert": "Delivered"], "packageId": "../../etc"]
        let payload = try #require(PushPayload(userInfo: info))
        #expect(payload.kind == .alert)
        #expect(payload.packageId == nil)
        #expect(payload.deepLink == nil)
    }

    @Test func rejectsNonPorchlightPayloads() {
        #expect(PushPayload(userInfo: [:]) == nil)
        #expect(PushPayload(userInfo: ["packageId": ID]) == nil)
        #expect(PushPayload(userInfo: ["aps": ["content-available": 0]]) == nil)
        #expect(PushPayload(userInfo: ["aps": "nope"]) == nil)
    }
}

@Suite struct DeepLinkTests {
    @Test func parsesAPackageLink() {
        #expect(DeepLink(url: URL(string: "porchlight://p/\(ID)")!) == .package(id: ID))
        #expect(DeepLink(url: URL(string: "PORCHLIGHT://p/\(ID.uppercased())")!) == .package(id: ID))
        #expect(DeepLink(url: URL(string: "porchlight://p/\(ID)/")!) == .package(id: ID))
    }

    @Test func rejectsOtherLinks() {
        for s in [
            "https://porchlight.xanom.co/p/\(ID)",
            "porchlight://x/\(ID)",
            "porchlight://p/",
            "porchlight://p/not-a-uuid",
            "porchlight://p/\(ID)/extra",
            "porchlight://",
        ] {
            #expect(DeepLink(url: URL(string: s)!) == nil, "\(s)")
        }
    }

    @Test func buildsTheURLItParses() {
        let link = DeepLink.package(id: ID)
        #expect(link.url.absoluteString == "porchlight://p/\(ID)")
        #expect(DeepLink(url: link.url) == link)
    }
}
