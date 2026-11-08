import Foundation
import Synchronization
@testable import PorchKit

/// Replays canned responses through a real URLSession. Each test registers a
/// handler under its own host, so suites can run in parallel.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, Data?) throws -> (Int, [String: String], Data)

    private static let handlers = Mutex<[String: Handler]>([:])

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host(), let handler = Self.handlers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        do {
            let (status, headers, data) = try handler(request, Self.body(of: request))
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    /// URLSession moves `httpBody` into a stream before a protocol sees it.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    /// A base URL on a fresh host whose requests go to `handler`.
    static func register(_ handler: @escaping Handler) -> (base: URL, session: URLSession) {
        let host = "t\(UUID().uuidString.lowercased().prefix(12)).stub"
        handlers.withLock { $0[host] = handler }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return (URL(string: "https://\(host)/v1")!, URLSession(configuration: config))
    }
}

/// `{ ok: true, data: <json> }`.
func okBody(_ json: String) -> Data { Data(#"{"ok":true,"data":\#(json),"error":null}"#.utf8) }

/// `{ ok: false, error: { code, message, details } }`.
func errorBody(_ code: String, _ message: String = "x", details: String? = nil) -> Data {
    let d = details.map { #","details":\#($0)"# } ?? ""
    return Data(#"{"ok":false,"data":null,"error":{"code":"\#(code)","message":"\#(message)"\#(d)}}"#.utf8)
}

func jsonObject(_ data: Data?) -> [String: Any] {
    guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

/// Records what a stubbed client sent.
final class Recorder: Sendable {
    private let state = Mutex<[(URLRequest, Data?)]>([])
    func add(_ request: URLRequest, _ body: Data?) { state.withLock { $0.append((request, body)) } }
    var requests: [(URLRequest, Data?)] { state.withLock { $0 } }
}

final class Counter: Sendable {
    private let n = Mutex(0)
    func bump() { n.withLock { $0 += 1 } }
    var value: Int { n.withLock { $0 } }
}

final class Recorded<T: Sendable>: Sendable {
    private let box = Mutex<T?>(nil)
    func set(_ value: T) { box.withLock { $0 = value } }
    var value: T? { box.withLock { $0 } }
}

let PACKAGE_JSON = #"""
{"id":"6f1c7a52-6b8e-4c1e-9a43-3b0f2d9a7c11","carrier":"ups","trackingNumber":"1Z999AA10123456784","title":"Headphones",
 "merchant":"Best Buy","orderId":null,"source":"manual","status":"in_transit","statusDetail":"Departed facility",
 "etaStart":"2026-11-10","etaEnd":"2026-11-11","etaDateOnly":true,"deliveredAt":null,
 "lastCheckedAt":"2026-11-08T17:00:00.000Z","archivedAt":null,"updatedAt":"2026-11-08T17:00:01.000Z",
 "items":[{"name":"Headphones","imageUrl":null,"quantity":1}]}
"""#

let USER_JSON = #"{"id":"u1","email":"a@b.c","hasApple":true,"createdAt":"2026-11-01T10:00:00.000Z"}"#
