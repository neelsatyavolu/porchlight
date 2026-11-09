import Foundation

/// The words on the Settings Amazon row (SPEC §6, "Failure is visible").
public enum AmazonStatusText {
    public struct Line: Hashable, Sendable {
        public var text: String
        /// Shown in the warning color.
        public var isProblem: Bool
    }

    /// One line for a connected device: the last import, or what went wrong and when.
    public static func line(_ s: AmazonLocalStatus, now: Date, timeZone: TimeZone) -> Line {
        let last = s.lastImportAt.map { "Last import \(SettingsText.ago($0, now: now, timeZone: timeZone))" }
        switch s.state {
        case .needsSignIn?:
            return Line(text: "Amazon wants you to sign in again." + (last.map { " \($0)." } ?? ""), isProblem: true)
        case .parseFailed?:
            let when = s.lastAttemptAt.map { " Checked \(SettingsText.ago($0, now: now, timeZone: timeZone))." } ?? ""
            return Line(text: "Couldn't read your Amazon orders. An app update may fix it.\(when)", isProblem: true)
        case .ok?:
            let count = s.lastCount.map { $0 == 0 ? " Nothing on the way." : $0 == 1 ? " 1 package." : " \($0) packages." } ?? ""
            if let error = s.lastError, let last { return Line(text: "\(last). The last try failed: \(error)", isProblem: false) }
            return Line(text: (last.map { "\($0)." } ?? "Connected.") + count, isProblem: false)
        case nil:
            if let error = s.lastError { return Line(text: error, isProblem: false) }
            return Line(text: "Connected. The first import starts soon.", isProblem: false)
        }
    }

    /// One line for a device that isn't signed in to Amazon while another one
    /// is (GET /v1/integrations/amazon): its imports reach this device too.
    public static func elsewhere(_ i: AmazonIntegration, now: Date, timeZone: TimeZone) -> Line {
        let device = switch i.platform {
        case .macos?: "your Mac"
        case .ios?: "your iPhone"
        default: "another device"
        }
        switch i.state {
        case .needsSignIn:
            return Line(text: "Amazon wants you to sign in again on \(device).", isProblem: true)
        case .parseFailed:
            return Line(text: "Connected on \(device), but it couldn't read your Amazon orders. An app update may fix it.", isProblem: true)
        case .ok:
            let last = i.lastImportAt.map { " Last import \(SettingsText.ago($0, now: now, timeZone: timeZone))." } ?? ""
            return Line(text: "Connected on \(device).\(last) Its packages show up here too.", isProblem: false)
        }
    }

    /// The package page's line after Refresh on an Amazon package.
    public static func refreshed(_ s: AmazonLocalStatus, now: Date) -> String {
        switch s.state {
        case .needsSignIn?: return "Amazon wants you to sign in again. Open Settings, then Amazon."
        case .parseFailed?: return "Couldn't read your Amazon orders. An app update may fix it."
        default: break
        }
        if let last = s.lastImportAt, now.timeIntervalSince(last) < 3 * 60 { return "Checked Amazon just now." }
        if let error = s.lastError { return error }
        return "Checked Amazon a few minutes ago. Try again in a minute or two."
    }
}
