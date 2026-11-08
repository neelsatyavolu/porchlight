import Foundation
import Testing
@testable import PorchKit

private func profile(_ entitlements: [String: Any]) throws -> Data {
    // embedded.mobileprovision is a CMS blob with the plist inside it as plain XML.
    let plist = try PropertyListSerialization.data(fromPropertyList: ["Entitlements": entitlements], format: .xml, options: 0)
    return Data([0x30, 0x82, 0x01, 0x00, 0xFF]) + plist + Data([0x00, 0xA0, 0x82])
}

@Suite struct PushEnvironmentTests {
    @Test func readsTheIOSKey() throws {
        #expect(PushEnvironment.resolve(provisioningProfile: try profile(["aps-environment": "development"]), isDebugBuild: false) == .sandbox)
        #expect(PushEnvironment.resolve(provisioningProfile: try profile(["aps-environment": "production"]), isDebugBuild: true) == .production)
    }

    @Test func readsTheMacKey() throws {
        let data = try profile(["com.apple.developer.aps-environment": "development"])
        #expect(PushEnvironment.resolve(provisioningProfile: data, isDebugBuild: false) == .sandbox)
    }

    @Test func noProfileMeansAppStore() {
        #expect(PushEnvironment.resolve(provisioningProfile: nil, isDebugBuild: true) == .production)
    }

    @Test func unreadableProfileFallsBackToTheBuildType() throws {
        let junk = Data("not a profile".utf8)
        #expect(PushEnvironment.resolve(provisioningProfile: junk, isDebugBuild: true) == .sandbox)
        #expect(PushEnvironment.resolve(provisioningProfile: junk, isDebugBuild: false) == .production)
        let noKey = try profile(["application-identifier": "VTQW687WBQ.co.xanom.porchlight"])
        #expect(PushEnvironment.resolve(provisioningProfile: noKey, isDebugBuild: true) == .sandbox)
    }

    @Test func hexEncodesTheToken() {
        #expect(PushEnvironment.hexToken(Data([0x00, 0x0F, 0xA0, 0xFF])) == "000fa0ff")
        #expect(PushEnvironment.hexToken(Data()) == "")
    }

    @Test func formatsTheAppVersion() {
        #expect(PushEnvironment.appVersion(short: "1.0", build: "12") == "1.0 (12)")
        #expect(PushEnvironment.appVersion(short: "1.0", build: nil) == "1.0")
        #expect(PushEnvironment.appVersion(short: nil, build: nil) == nil)
    }
}

@Suite struct DeviceRegistrarTests {
    private let token = Data([0xAB, 0xCD])

    @Test func sendsTheTokenWhenSignedIn() async throws {
        let api = BGFakeAPI()
        let registrar = DeviceRegistrar(api: api, sessionStore: InMemorySessionStore(SAMPLE_SESSION),
                                        platform: .ios, appVersion: "1.0 (12)", environment: .sandbox)
        let device = try await registrar.setToken(token)
        #expect(device?.id == "dev-1")
        let puts = api.devicePuts.withLock { $0 }
        #expect(puts.count == 1)
        #expect(puts[0].0 == "dev-1")
        #expect(puts[0].1 == DevicePutRequest(platform: .ios, apnsToken: "abcd", appVersion: "1.0 (12)", environment: .sandbox))
    }

    @Test func waitsForSignInThenSends() async throws {
        let api = BGFakeAPI()
        let store = InMemorySessionStore()
        let registrar = DeviceRegistrar(api: api, sessionStore: store, platform: .macos, appVersion: nil, environment: .production)
        #expect(try await registrar.setToken(token) == nil)
        #expect(api.devicePuts.withLock { $0.count } == 0)

        try store.save(SAMPLE_SESSION)
        #expect(try await registrar.registerIfNeeded()?.environment == .production)
        #expect(api.devicePuts.withLock { $0.count } == 1)
    }

    @Test func doesNotResendTheSameToken() async throws {
        let api = BGFakeAPI()
        let registrar = DeviceRegistrar(api: api, sessionStore: InMemorySessionStore(SAMPLE_SESSION),
                                        platform: .ios, appVersion: nil, environment: .sandbox)
        try await registrar.setToken(token)
        #expect(try await registrar.registerIfNeeded() == nil)
        try await registrar.setToken(token)
        #expect(api.devicePuts.withLock { $0.count } == 1)

        try await registrar.setToken(Data([0x01]))
        #expect(api.devicePuts.withLock { $0.count } == 2)
    }

    @Test func resendsAfterReset() async throws {
        let api = BGFakeAPI()
        let registrar = DeviceRegistrar(api: api, sessionStore: InMemorySessionStore(SAMPLE_SESSION),
                                        platform: .ios, appVersion: nil, environment: .sandbox)
        try await registrar.setToken(token)
        await registrar.reset()
        try await registrar.registerIfNeeded()
        #expect(api.devicePuts.withLock { $0.count } == 2)
    }

    @Test func retriesAfterAFailedSend() async throws {
        let failing = BGFakeAPI(deviceError: .network("offline"))
        let registrar = DeviceRegistrar(api: failing, sessionStore: InMemorySessionStore(SAMPLE_SESSION),
                                        platform: .ios, appVersion: nil, environment: .sandbox)
        await #expect(throws: APIError.network("offline")) { try await registrar.setToken(token) }
        await #expect(throws: APIError.network("offline")) { try await registrar.registerIfNeeded() }
        #expect(failing.devicePuts.withLock { $0.count } == 2)
    }

    @Test func doesNothingWithoutAToken() async throws {
        let api = BGFakeAPI()
        let registrar = DeviceRegistrar(api: api, sessionStore: InMemorySessionStore(SAMPLE_SESSION),
                                        platform: .ios, appVersion: nil, environment: .sandbox)
        #expect(try await registrar.registerIfNeeded() == nil)
        #expect(api.devicePuts.withLock { $0.count } == 0)
    }
}

@Suite struct NotificationPromptTests {
    @Test func asksOnlyOnceThereIsAPackageAndTheAppIsInFront() {
        #expect(NotificationPrompt.shouldAsk(authorization: .notDetermined, hasPackages: true, appIsActive: true))
        #expect(!NotificationPrompt.shouldAsk(authorization: .notDetermined, hasPackages: false, appIsActive: true))
        #expect(!NotificationPrompt.shouldAsk(authorization: .notDetermined, hasPackages: true, appIsActive: false))
        for state in [NotificationAuthorization.denied, .authorized, .provisional, .ephemeral] {
            #expect(!NotificationPrompt.shouldAsk(authorization: state, hasPackages: true, appIsActive: true))
        }
    }
}
