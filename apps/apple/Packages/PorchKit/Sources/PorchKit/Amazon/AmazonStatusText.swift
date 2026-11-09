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
}
