import Foundation

/// What the Today widget shows.
public enum TodayWidgetState: Hashable, Sendable {
    /// No session in the shared Keychain item, or the server refused it.
    case signedOut
    case loaded(TodayWidgetContent)
    /// The fetch failed; the last content from earlier today is still shown.
    case stale(TodayWidgetContent, failedAt: Date)
    /// The fetch failed and there is nothing from today to show.
    case failed

    public var content: TodayWidgetContent? {
        switch self {
        case let .loaded(c), let .stale(c, _): c
        case .signedOut, .failed: nil
        }
    }
}

/// One timeline entry: what to show from `date` on.
public struct TodayWidgetEntry: Hashable, Sendable {
    public var date: Date
    public var state: TodayWidgetState
}

/// Fetches the Today widget's packages. The widget has no local store (no app
/// group), so it reads the session from the shared Keychain item and pulls a
/// full `GET /v1/sync` snapshot (no cursor) itself.
public struct TodayWidgetLoader: Sendable {
    /// Pages of 200 packages; more than this is far beyond one person's packages,
    /// and the extension's memory is small.
    public static let maxPages = 10

    private let token: @Sendable () -> String?
    private let fetchPage: @Sendable (_ cursor: String?) async throws -> SyncResponse

    public init(
        token: @escaping @Sendable () -> String?,
        fetchPage: @escaping @Sendable (_ cursor: String?) async throws -> SyncResponse
    ) {
        self.token = token
        self.fetchPage = fetchPage
    }

    /// Reads the session from `sessionStore` and calls `api.sync`.
    public init(sessionStore: any SessionStore, api: any APIClient) {
        self.init(token: { (try? sessionStore.load())?.token }, fetchPage: { try await api.sync(since: $0) })
    }

    /// `previous` is the last content the widget showed; it is kept on a failed
    /// fetch only when it is from the same local day.
    public func load(previous: TodayWidgetContent?, now: Date, timeZone: TimeZone) async -> TodayWidgetState {
        await timeline(previous: previous, now: now, timeZone: timeZone)[0].state
    }

    /// The entry for `now`, then one for the next local midnight when it comes
    /// before the next refresh. WidgetKit may run the midnight reload late, so
    /// that entry is worked out now from the same packages: yesterday's
    /// deliveries drop off and what was due yesterday reads as late. Content
    /// that can't be redone (a stale copy) gives way to `.failed` at midnight.
    public func timeline(previous: TodayWidgetContent?, now: Date, timeZone: TimeZone) async -> [TodayWidgetEntry] {
        let first: TodayWidgetState
        var packages: [Package]?
        if token() == nil {
            first = .signedOut
        } else {
            do {
                let all = try await allPackages()
                packages = all
                first = .loaded(TodayWidgetContent.make(all, now: now, timeZone: timeZone))
            } catch {
                if ErrorText.isUnauthorized(error) {
                    first = .signedOut
                } else if let previous, CalendarDate(previous.fetchedAt, in: timeZone) == CalendarDate(now, in: timeZone) {
                    first = .stale(previous, failedAt: now)
                } else {
                    first = .failed
                }
            }
        }
        var entries = [TodayWidgetEntry(date: now, state: first)]
        guard let midnight = TodayWidgetPolicy.nextMidnight(after: now, timeZone: timeZone),
              midnight <= TodayWidgetPolicy.nextRefresh(after: now, timeZone: timeZone) else { return entries }
        switch first {
        case .signedOut, .failed:
            break
        case .loaded:
            if let packages {
                entries.append(TodayWidgetEntry(date: midnight, state: .loaded(TodayWidgetContent.make(packages, now: midnight, timeZone: timeZone))))
            }
        case .stale:
            entries.append(TodayWidgetEntry(date: midnight, state: .failed))
        }
        return entries
    }

    private func allPackages() async throws -> [Package] {
        var packages: [Package] = []
        var cursor: String?
        for _ in 0 ..< Self.maxPages {
            let page = try await fetchPage(cursor)
            packages += page.packages
            guard page.hasMore else { break }
            cursor = page.cursor
        }
        return packages
    }
}

/// The widget's fixed wording (DESIGN.md §7 voice).
public enum TodayWidgetText {
    public static let signedOutTitle = "Sign in to Porchlight"
    public static let signedOutBody = "Open the app to see today's packages here."
    public static let failedTitle = "Couldn't reach Porchlight"
    public static let failedBody = "The widget tries again in 30 min."

    /// "Couldn't refresh. Showing what we had at 9:41 AM."
    public static func staleLine(_ content: TodayWidgetContent, timeZone: TimeZone) -> String {
        "Couldn't refresh. Showing what we had at \(TimeWords.clockTime(content.fetchedAt, timeZone: timeZone))."
    }
}
