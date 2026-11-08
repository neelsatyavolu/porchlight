import Foundation

// Wording and checks for Settings and Sign-in (DESIGN.md §7). A port of
// apps/web/src/pages/settings/time.ts and SessionsSection.tsx.

public enum SettingsText {
    public static func platformLabel(_ platform: Platform?) -> String {
        switch platform {
        case .ios: "iPhone"
        case .macos: "Mac"
        case .web: "Web browser"
        case nil: "Unknown device"
        }
    }

    /// "Last active 3 h ago · Version 1.0 (7) · Signed in Nov 2"; the current
    /// session says "This device" instead of when it was last active.
    public static func sessionMeta(_ s: SessionInfo, now: Date, timeZone: TimeZone) -> String {
        var parts = [s.current ? "This device" : "Last active \(ago(s.lastSeenAt, now: now, timeZone: timeZone))"]
        if let version = s.appVersion, !version.isEmpty { parts.append("Version \(version)") }
        parts.append("Signed in \(shortDate(s.createdAt, now: now, timeZone: timeZone))")
        return parts.joined(separator: " · ")
    }

    /// "Last used 14 min ago · Paired Nov 1", or "Not used yet · Paired Nov 1".
    public static func tokenMeta(_ t: APITokenInfo, now: Date, timeZone: TimeZone) -> String {
        let used = t.lastUsedAt.map { "Last used \(ago($0, now: now, timeZone: timeZone))" } ?? "Not used yet"
        return "\(used) · Paired \(shortDate(t.createdAt, now: now, timeZone: timeZone))"
    }

    /// "just now", "5 min ago", "3 h ago", "yesterday", "3 days ago", then "on Nov 3".
    public static func ago(_ date: Date, now: Date, timeZone: TimeZone) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        let minutes = Int(seconds / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) h ago" }
        let days = hours / 24
        if days < 7 { return days == 1 ? "yesterday" : "\(days) days ago" }
        return "on \(shortDate(date, now: now, timeZone: timeZone))"
    }

    /// "Nov 3", with the year when it isn't this year.
    public static func shortDate(_ date: Date, now: Date, timeZone: TimeZone) -> String {
        TimeWords.monthDay(CalendarDate(date, in: timeZone), today: CalendarDate(now, in: timeZone))
    }

    /// Seconds left as "9:05". Never negative.
    public static func countdown(_ secondsLeft: TimeInterval) -> String {
        let total = max(0, Int(secondsLeft.rounded(.up)))
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    /// The word typed to confirm deleting the account.
    public static let deleteWord = "delete"

    public static func confirmsDelete(_ typed: String) -> Bool {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == deleteWord
    }
}

public enum SignInText {
    /// A light check before sending: something@something.tld with no spaces.
    /// The server does the real validation.
    public static func isPlausibleEmail(_ raw: String) -> Bool {
        let email = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.contains(where: \.isWhitespace) else { return false }
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        return domain.count >= 2 && domain.allSatisfy { !$0.isEmpty }
    }

    public static let codeLength = 6

    /// Digits only, at most six: what the code field keeps as the user types or pastes.
    public static func cleanCode(_ raw: String) -> String {
        String(raw.filter { $0.isASCII && $0.isNumber }.prefix(codeLength))
    }

    public static func isCompleteCode(_ code: String) -> Bool {
        code.count == codeLength && code.allSatisfy { $0.isASCII && $0.isNumber }
    }
}
