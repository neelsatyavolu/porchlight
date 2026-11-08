import CryptoKit
import Foundation

/// The nonce for one Sign in with Apple attempt.
///
/// Apple gets `hashed` (put it in `ASAuthorizationAppleIDRequest.nonce`), and
/// `POST /v1/auth/apple` gets `raw`. The server checks that the identity
/// token's `nonce` claim equals the SHA-256 hex of `raw`
/// (services/api/src/lib/apple.ts), the same scheme as apps/web/src/auth/apple.ts.
public struct AppleNonce: Hashable, Sendable {
    public let raw: String
    public var hashed: String { Self.sha256Hex(raw) }

    public init(raw: String) { self.raw = raw }

    /// 32 random bytes as 64 lowercase hex characters.
    public static func make() -> AppleNonce {
        var rng = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &rng) }
        return AppleNonce(raw: hex(bytes))
    }

    public static func sha256Hex(_ value: String) -> String {
        hex(SHA256.hash(data: Data(value.utf8)))
    }

    static func hex(_ bytes: some Sequence<UInt8>) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
