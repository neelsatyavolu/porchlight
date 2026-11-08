import Foundation
import Security
import Testing
@testable import PorchKit

/// Only the item's coordinates are checked here. A real Keychain round trip
/// needs the signed app's keychain-access-groups entitlement, so it is checked
/// on device, not in `swift test`.
@Suite struct KeychainSessionStoreTests {
    @Test func usesTheSharedServiceAccountAndGroup() {
        let query = KeychainSessionStore().baseQuery
        #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
        #expect(query[kSecAttrService as String] as? String == "co.xanom.porchlight.session")
        #expect(query[kSecAttrAccount as String] as? String == "default")
        #expect(query[kSecAttrAccessGroup as String] as? String == "VTQW687WBQ.co.xanom.porchlight")
        #if os(macOS)
        #expect(query[kSecUseDataProtectionKeychain as String] as? Bool == true)
        #endif
    }

    @Test func leavesTheGroupOutWhenNil() {
        let query = KeychainSessionStore(accessGroup: nil).baseQuery
        #expect(query[kSecAttrAccessGroup as String] == nil)
    }
}
