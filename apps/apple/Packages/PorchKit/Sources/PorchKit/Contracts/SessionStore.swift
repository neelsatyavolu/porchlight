import Foundation
import Security
import Synchronization

// CONTRACT: where the signed-in session lives. The app and the share extension
// both read it, so the Keychain item uses the shared access group.

public protocol SessionStore: Sendable {
    /// The saved session, or nil when signed out.
    func load() throws -> Session?
    func save(_ session: Session) throws
    /// Removes the session. Removing when none is saved is not an error.
    func clear() throws
}

/// The Keychain item's coordinates, shared by the app and the extension.
public enum KeychainConfig {
    public static let service = "co.xanom.porchlight.session"
    public static let account = "default"
    /// Must match `keychain-access-groups` in both targets' entitlements
    /// ("$(AppIdentifierPrefix)co.xanom.porchlight").
    public static let accessGroup = "VTQW687WBQ.co.xanom.porchlight"
}

/// Keychain-backed `SessionStore`: one generic-password item (`KeychainConfig`)
/// holding the Session JSON, in the shared access group so the share extension
/// reads the same session. Readable after first unlock so background refresh
/// works, never synced or restored to another device. On macOS it uses the
/// data protection keychain, which is what honors the access group.
public struct KeychainSessionStore: SessionStore {
    public let service: String
    public let account: String
    /// nil uses the app's default group (for unsigned tools; apps pass the shared one).
    public let accessGroup: String?

    public init(service: String = KeychainConfig.service, account: String = KeychainConfig.account, accessGroup: String? = KeychainConfig.accessGroup) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    public func load() throws -> Session? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = result as? Data else { throw KeychainError(status: errSecDecode) }
        do {
            return try WireJSON.decoder().decode(Session.self, from: data)
        } catch {
            // An item from an older build that no longer decodes: treat as signed out.
            try? clear()
            return nil
        }
    }

    public func save(_ session: Session) throws {
        let data = try WireJSON.encoder().encode(session)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }
        let added = SecItemAdd(baseQuery.merging(attributes) { _, new in new } as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    /// The attributes that identify the item.
    var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }
}

/// A Keychain call failed with `status` (an `OSStatus`, such as -34018 when
/// the build lacks the keychain-access-groups entitlement).
public struct KeychainError: Error, Hashable, Sendable {
    public let status: Int32
    public init(status: OSStatus) { self.status = status }
}

/// For tests and previews.
public final class InMemorySessionStore: SessionStore {
    private let value: Mutex<Session?>

    public init(_ session: Session? = nil) { value = Mutex(session) }

    public func load() throws -> Session? { value.withLock { $0 } }
    public func save(_ session: Session) throws { value.withLock { $0 = session } }
    public func clear() throws { value.withLock { $0 = nil } }
}
