import Foundation
import Testing
@testable import PorchKit

@Suite struct EndpointTests {
    private let base = URL(string: "https://porchlight.example/v1")!

    @Test func everyEndpointHasTheContractMethodAndPath() throws {
        let cases: [(Endpoint, String, String, Bool)] = [
            (try Endpoints.signInWithApple(AppleSignInRequest(identityToken: "j", nonce: "n", deviceId: nil)), "POST", "/v1/auth/apple", false),
            (try Endpoints.startEmailSignIn(EmailStartRequest(email: "a@b.c")), "POST", "/v1/auth/email/start", false),
            (try Endpoints.verifyEmail(.token("t", deviceId: nil)), "POST", "/v1/auth/email/verify", false),
            (Endpoints.signOut, "POST", "/v1/auth/signout", true),
            (Endpoints.me, "GET", "/v1/me", true),
            (Endpoints.deleteAccount, "DELETE", "/v1/me", true),
            (try Endpoints.putDevice(id: "d1", DevicePutRequest(apnsToken: nil, appVersion: nil, environment: .sandbox)), "PUT", "/v1/devices/d1", true),
            (Endpoints.listSessions, "GET", "/v1/sessions", true),
            (Endpoints.deleteSession(id: "s1"), "DELETE", "/v1/sessions/s1", true),
            (Endpoints.getPackage(id: "p1"), "GET", "/v1/packages/p1", true),
            (Endpoints.sync(since: nil), "GET", "/v1/sync", true),
            (try Endpoints.putPackage(id: "p1", PackagePutRequest()), "PUT", "/v1/packages/p1", true),
            (Endpoints.deletePackage(id: "p1"), "DELETE", "/v1/packages/p1", true),
            (Endpoints.refreshPackage(id: "p1"), "POST", "/v1/packages/p1/refresh", true),
            (Endpoints.deviceTrackingDue, "GET", "/v1/device-tracking/due", true),
            (try Endpoints.postObserved(packageId: "p1", .withoutData(.failed, observedAt: NOW)), "POST", "/v1/packages/p1/observed", true),
            (try Endpoints.importFlint([]), "POST", "/v1/imports/flint", true),
            (try Endpoints.importAmazon([]), "POST", "/v1/imports/amazon", true),
            (Endpoints.startPairing, "POST", "/v1/pairing/start", true),
            (try Endpoints.claimPairing(PairingClaimRequest(code: "ABCD-EFGH", label: "Flint")), "POST", "/v1/pairing/claim", false),
            (Endpoints.listTokens, "GET", "/v1/tokens", true),
            (Endpoints.deleteToken(id: "t1"), "DELETE", "/v1/tokens/t1", true),
        ]
        for (endpoint, method, path, auth) in cases {
            let request = endpoint.urlRequest(baseURL: base, token: "secret")
            #expect(request.httpMethod == method, "\(path)")
            #expect(request.url?.path() == path)
            #expect((request.value(forHTTPHeaderField: "Authorization") == "Bearer secret") == auth, "\(path)")
            #expect((request.value(forHTTPHeaderField: "Content-Type") == "application/json") == (endpoint.body != nil), "\(path)")
        }
    }

    @Test func syncSendsTheCursorAsQuery() {
        let request = Endpoints.sync(since: "a+b/c=").urlRequest(baseURL: base, token: nil)
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
        #expect(items == [URLQueryItem(name: "since", value: "a+b/c=")])
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }
}
