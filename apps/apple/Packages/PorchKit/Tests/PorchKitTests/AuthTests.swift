import Foundation
import Testing
@testable import PorchKit

@Suite struct AppleNonceTests {
    @Test func hashesWithSHA256HexLikeTheServer() {
        // FIPS 180-2 test vector.
        #expect(AppleNonce.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(AppleNonce(raw: "abc").hashed == AppleNonce.sha256Hex("abc"))
    }

    @Test func makesA64CharacterLowercaseHexNonce() {
        let a = AppleNonce.make()
        let b = AppleNonce.make()
        #expect(a.raw.count == 64)
        #expect(a.raw.allSatisfy { "0123456789abcdef".contains($0) })
        #expect(a != b)
    }
}

@Suite struct AuthServiceTests {
    private func service(_ store: InMemorySessionStore = InMemorySessionStore(), _ handler: @escaping StubURLProtocol.Handler) -> AuthService {
        let (base, session) = StubURLProtocol.register(handler)
        let api = HTTPAPIClient(baseURL: base, transport: session, token: { try? store.load()?.token })
        return AuthService(api: api, store: store, deviceId: "dev-1")
    }

    private let signedIn = okBody(#"{"token":"tok","user":\#(USER_JSON),"created":false}"#)

    @Test func appleSignInSendsTheRawNonceAndSavesTheSession() async throws {
        let store = InMemorySessionStore()
        let recorder = Recorder()
        let auth = service(store) { req, body in
            recorder.add(req, body)
            return (200, [:], self.signedIn)
        }
        let nonce = AppleNonce(raw: "raw-nonce")
        let session = try await auth.signInWithApple(identityToken: Data("eyJ.jwt".utf8), nonce: nonce)
        #expect(session == Session(token: "tok", user: session.user, deviceId: "dev-1"))
        #expect(try store.load() == session)
        let sent = jsonObject(recorder.requests.first?.1)
        #expect(sent["identityToken"] as? String == "eyJ.jwt")
        #expect(sent["nonce"] as? String == "raw-nonce")
        #expect(sent["deviceId"] as? String == "dev-1")
    }

    @Test func appleSignInWithoutATokenFailsBeforeCallingTheServer() async throws {
        let calls = Counter()
        let auth = service { _, _ in calls.bump(); return (200, [:], self.signedIn) }
        await #expect(throws: AuthError.missingIdentityToken) {
            try await auth.signInWithApple(identityToken: nil, nonce: .make())
        }
        #expect(calls.value == 0)
    }

    @Test func aWebStyleResponseWithNoTokenIsRejected() async throws {
        let store = InMemorySessionStore()
        let auth = service(store) { _, _ in (200, [:], okBody(#"{"token":null,"user":\#(USER_JSON),"created":false}"#)) }
        await #expect(throws: AuthError.missingSessionToken) {
            try await auth.verifyEmail(linkToken: "t")
        }
        #expect(try store.load() == nil)
    }

    @Test func emailCodeSignIn() async throws {
        let recorder = Recorder()
        let store = InMemorySessionStore()
        let auth = service(store) { req, body in
            recorder.add(req, body)
            if req.url?.path() == "/v1/auth/email/start" { return (202, [:], okBody(#"{"sent":true}"#)) }
            return (200, [:], self.signedIn)
        }
        try await auth.startEmail("  a@b.c ")
        _ = try await auth.verifyEmail(email: "a@b.c", code: "123 456")
        #expect(try store.load()?.token == "tok")
        let bodies = recorder.requests.map { jsonObject($0.1) }
        #expect(bodies[0]["email"] as? String == "a@b.c")
        #expect(bodies[1]["code"] as? String == "123456")
        #expect(bodies[1]["deviceId"] as? String == "dev-1")
    }

    @Test func rejectsMalformedEmailAndCodeLocally() async throws {
        let auth = service { _, _ in Issue.record("should not call the server"); return (500, [:], Data()) }
        await #expect(throws: AuthError.invalidEmail) { try await auth.startEmail("nope") }
        await #expect(throws: AuthError.invalidCode) { _ = try await auth.verifyEmail(email: "a@b.c", code: "12a456") }
        await #expect(throws: AuthError.invalidCode) { _ = try await auth.verifyEmail(email: "a@b.c", code: "12345") }
    }

    @Test func readsTheMagicLinkToken() {
        #expect(AuthService.linkToken(from: URL(string: "https://porchlight.xanom.co/auth/verify?token=abc")!) == "abc")
        #expect(AuthService.linkToken(from: URL(string: "https://porchlight.xanom.co/auth/verify?token=")!) == nil)
        #expect(AuthService.linkToken(from: URL(string: "https://porchlight.xanom.co/packages/1?token=abc")!) == nil)
        #expect(AuthService.linkToken(from: URL(string: "porchlight://x/auth/verify?token=abc")!) == nil)
        #expect(AuthService.linkToken(from: URL(string: "porchlight:///auth/verify?token=abc")!) == nil)
        #expect(AuthService.linkToken(from: URL(string: "https://evil.example/auth/verify?token=abc")!) == nil)
        #expect(AuthService.linkToken(from: URL(string: "http://porchlight.xanom.co/auth/verify?token=abc")!) == nil)
    }

    @Test func signOutClearsLocallyEvenWhenOffline() async throws {
        let store = InMemorySessionStore(Session(token: "tok", user: User(id: "u1", email: nil, hasApple: false, createdAt: NOW), deviceId: "dev-1"))
        let auth = service(store) { _, _ in throw URLError(.notConnectedToInternet) }
        await auth.signOut()
        #expect(try store.load() == nil)
    }

    @Test func deleteAccountKeepsTheSessionWhenTheServerFails() async throws {
        let session = Session(token: "tok", user: User(id: "u1", email: nil, hasApple: false, createdAt: NOW), deviceId: "dev-1")
        let store = InMemorySessionStore(session)
        let auth = service(store) { _, _ in (500, [:], errorBody("internal")) }
        await #expect(throws: APIError.self) { try await auth.deleteAccount() }
        #expect(try store.load() == session)
    }

    @Test func registersTheDeviceWithAHexTokenAndEnvironment() async throws {
        let recorder = Recorder()
        let store = InMemorySessionStore(Session(token: "tok", user: User(id: "u1", email: nil, hasApple: false, createdAt: NOW), deviceId: "dev-1"))
        let auth = service(store) { req, body in
            recorder.add(req, body)
            return (200, [:], okBody(#"{"id":"dev-1","platform":"macos","apnsToken":"00ff10","appVersion":"1.0 (3)","environment":"sandbox"}"#))
        }
        try await auth.registerDevice(apnsToken: Data([0x00, 0xff, 0x10]), appVersion: "1.0 (3)", environment: .sandbox)
        let (req, body) = try #require(recorder.requests.first)
        #expect(req.url?.path() == "/v1/devices/dev-1")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        let sent = jsonObject(body)
        #expect(sent["apnsToken"] as? String == "00ff10")
        #expect(sent["environment"] as? String == "sandbox")
        #expect(sent["appVersion"] as? String == "1.0 (3)")
    }

    @Test func deviceIdIsCreatedOnceAndLowercase() throws {
        let suite = "porchkit-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = DeviceID.load(from: defaults)
        #expect(first == first.lowercased())
        #expect(UUID(uuidString: first) != nil)
        #expect(DeviceID.load(from: defaults) == first)
    }

    @Test func signOutRotatesTheDeviceId() throws {
        let suite = "porchkit-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = DeviceID.load(from: defaults)
        let next = DeviceID.rotate(in: defaults)
        #expect(next != first)
        #expect(UUID(uuidString: next) != nil)
        #expect(DeviceID.load(from: defaults) == next)
    }
}
