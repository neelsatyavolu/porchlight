import Foundation
import Testing
@testable import PorchKit

@Suite struct HTTPAPIClientTests {
    private func client(
        token: String? = "secret", onUnauthorized: @escaping @Sendable (String) async -> Void = { _ in },
        _ handler: @escaping StubURLProtocol.Handler
    ) -> HTTPAPIClient {
        let (base, session) = StubURLProtocol.register(handler)
        return HTTPAPIClient(baseURL: base, transport: session, token: { token }, onUnauthorized: onUnauthorized)
    }

    @Test func sendsTheBearerTokenAndDecodesTheEnvelope() async throws {
        let recorder = Recorder()
        let api = client { req, body in
            recorder.add(req, body)
            return (200, [:], okBody(#"{"user":\#(USER_JSON)}"#))
        }
        let user = try await api.me()
        #expect(user.id == "u1")
        #expect(user.email == "a@b.c")
        let (req, _) = try #require(recorder.requests.first)
        #expect(req.httpMethod == "GET")
        #expect(req.url?.path() == "/v1/me")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    }

    @Test func signInSendsNoTokenAndPostsTheRawNonce() async throws {
        let recorder = Recorder()
        let api = client { req, body in
            recorder.add(req, body)
            return (200, [:], okBody(#"{"token":"tok","user":\#(USER_JSON),"created":true}"#))
        }
        let response = try await api.signInWithApple(AppleSignInRequest(identityToken: "jwt", nonce: "raw", client: .ios, deviceId: "d1"))
        #expect(response.token == "tok")
        #expect(response.created)
        let (req, body) = try #require(recorder.requests.first)
        #expect(req.value(forHTTPHeaderField: "Authorization") == nil)
        let sent = jsonObject(body)
        #expect(sent["identityToken"] as? String == "jwt")
        #expect(sent["nonce"] as? String == "raw")
        #expect(sent["client"] as? String == "ios")
        #expect(sent["deviceId"] as? String == "d1")
    }

    @Test func putPackageReportsCreatedFrom201() async throws {
        let api = client { req, _ in
            (req.url?.path().hasSuffix("new") == true ? 201 : 200, [:], okBody(PACKAGE_JSON))
        }
        #expect(try await api.putPackage(id: "new", PackagePutRequest(trackingNumber: "1Z")).created)
        #expect(try await !api.putPackage(id: "old", PackagePutRequest(title: .some("x"))).created)
    }

    @Test func mapsAnErrorEnvelopeToAPIErrorServer() async throws {
        let api = client { _, _ in
            (409, [:], errorBody("conflict", "Already tracked", details: #"{"reason":"duplicate","existingId":"p9"}"#))
        }
        do {
            _ = try await api.putPackage(id: "p1", PackagePutRequest(trackingNumber: "1Z"))
            Issue.record("expected a throw")
        } catch let error as APIError {
            #expect(error.code == .conflict)
            #expect(error.conflict == .duplicate(existingId: "p9"))
            guard case let .server(status, body, _) = error else { Issue.record("not .server"); return }
            #expect(status == 409)
            #expect(body.message == "Already tracked")
        }
    }

    @Test func readsRetryAfterOnA429() async throws {
        let api = client { _, _ in (429, ["Retry-After": "95"], errorBody("rate_limited")) }
        do {
            _ = try await api.refreshPackage(id: "p1")
            Issue.record("expected a throw")
        } catch let APIError.server(status, body, retryAfter) {
            #expect(status == 429)
            #expect(body.code == .rateLimited)
            #expect(retryAfter == 95)
        }
    }

    @Test func retryAfterAcceptsAnHTTPDate() throws {
        let now = Date(timeIntervalSince1970: 1_794_000_000)
        let header = { (value: String) in
            HTTPURLResponse(url: URL(string: "https://x")!, statusCode: 429, httpVersion: nil, headerFields: ["Retry-After": value])!
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        #expect(RetryAfter.parse(header(formatter.string(from: now.addingTimeInterval(30))), now: now) == 30)
        #expect(RetryAfter.parse(header("soon"), now: now) == nil)
        #expect(RetryAfter.parse(header("-4"), now: now) == nil)
    }

    @Test func a401WithASessionCallsOnUnauthorized() async throws {
        let calls = Counter()
        let refused = Recorded<String>()
        let api = client(onUnauthorized: { token in calls.bump(); refused.set(token) }) { _, _ in (401, [:], errorBody("unauthorized")) }
        await #expect(throws: APIError.self) { try await api.sync(since: nil) }
        #expect(calls.value == 1)
        #expect(refused.value == "secret")
    }

    @Test func a401OnSignInDoesNotEndTheSession() async throws {
        let calls = Counter()
        let api = client(onUnauthorized: { _ in calls.bump() }) { _, _ in (401, [:], errorBody("unauthorized", "Wrong code")) }
        await #expect(throws: APIError.self) {
            try await api.verifyEmail(.code(email: "a@b.c", code: "000000", deviceId: nil))
        }
        #expect(calls.value == 0)
    }

    @Test func aNonEnvelopeBodyIsInvalidResponse() async throws {
        let api = client { _, _ in (502, [:], Data("<html>Bad gateway</html>".utf8)) }
        do {
            _ = try await api.me()
            Issue.record("expected a throw")
        } catch let error as APIError {
            guard case .invalidResponse = error else { Issue.record("got \(error)"); return }
        }
    }

    @Test func transportFailureIsNetwork() async throws {
        let api = client { _, _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await api.me()
            Issue.record("expected a throw")
        } catch let error as APIError {
            guard case .network = error else { Issue.record("got \(error)"); return }
        }
    }

    @Test func voidEndpointsAcceptTheirAcknowledgements() async throws {
        let api = client { req, _ in
            switch req.url?.path() {
            case "/v1/auth/email/start": (202, [:], okBody(#"{"sent":true}"#))
            case "/v1/auth/signout": (200, [:], okBody(#"{"signedOut":true}"#))
            default: (200, [:], okBody(#"{"deleted":true}"#))
            }
        }
        try await api.startEmailSignIn(EmailStartRequest(email: "a@b.c"))
        try await api.signOut()
        try await api.deleteAccount()
        try await api.deleteToken(id: "t1")
    }

    @Test func putDeviceSendsTheEnvironment() async throws {
        let recorder = Recorder()
        let api = client { req, body in
            recorder.add(req, body)
            return (200, [:], okBody(#"{"id":"d1","platform":"ios","apnsToken":"ab01","appVersion":"1.0 (12)","environment":"sandbox"}"#))
        }
        let device = try await api.putDevice(id: "d1", DevicePutRequest(platform: .ios, apnsToken: "ab01", appVersion: "1.0 (12)", environment: .sandbox))
        #expect(device.environment == .sandbox)
        let (req, body) = try #require(recorder.requests.first)
        #expect(req.httpMethod == "PUT")
        #expect(req.url?.path() == "/v1/devices/d1")
        #expect(jsonObject(body)["environment"] as? String == "sandbox")
    }

    @Test func listsAndDeletesSessions() async throws {
        let api = client { req, _ in
            if req.httpMethod == "GET" {
                return (200, [:], okBody(#"{"sessions":[{"id":"s1","platform":null,"appVersion":null,"createdAt":"2026-11-01T10:00:00.000Z","lastSeenAt":"2026-11-08T17:04:00.000Z","current":true}]}"#))
            }
            return (200, [:], okBody(#"{"deleted":true,"signedOut":true}"#))
        }
        let sessions = try await api.listSessions()
        #expect(sessions.map(\.id) == ["s1"])
        #expect(sessions.first?.platform == nil)
        #expect(try await api.deleteSession(id: "s1").signedOut)
    }
}
