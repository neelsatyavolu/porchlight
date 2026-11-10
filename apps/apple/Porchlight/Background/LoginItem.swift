#if os(macOS)
import Foundation
import OSLog
import ServiceManagement

/// Opens Porchlight at login, so the Mac keeps reading Amazon and carrier pages
/// (and posting the changes that become notifications) without being opened.
enum LoginItem {
    private static let defaultedKey = "porchlight.loginItem.defaulted"
    private static let log = Logger(subsystem: "co.xanom.porchlight", category: "loginItem")

    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    /// On the first launch only, turn it on; after that the Settings switch decides.
    static func turnOnOnce(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: defaultedKey) else { return }
        defaults.set(true, forKey: defaultedKey)
        do {
            try set(true)
        } catch {
            log.error("could not add the login item: \(String(describing: error), privacy: .public)")
        }
    }
}
#endif
