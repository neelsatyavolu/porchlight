import Foundation
import PorchKit
import SwiftUI
import WidgetKit

struct TodayEntry: TimelineEntry {
    let date: Date
    let state: TodayWidgetState
}

/// Fetches on every timeline request; the app also reloads the timeline after
/// each of its syncs (WidgetCenter.reloadAllTimelines).
struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: Date(), state: .loaded(TodaySample.content))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (TodayEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(await Self.load(now: Date())[0]) }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TodayEntry>) -> Void) {
        Task {
            let now = Date()
            let entries = await Self.load(now: now)
            let next = TodayWidgetPolicy.nextRefresh(after: now, timeZone: .current)
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    /// The entry for now and, late in the evening, one for midnight (TodayWidgetLoader.timeline).
    private static func load(now: Date) async -> [TodayEntry] {
        let store = KeychainSessionStore()
        let api = HTTPAPIClient(baseURL: PorchConfig.productionBaseURL, token: { try? store.load()?.token })
        let loader = TodayWidgetLoader(sessionStore: store, api: api)
        let entries = await loader.timeline(previous: LastContent.load(), now: now, timeZone: .current)
        switch entries[0].state {
        case let .loaded(content): LastContent.save(content)
        case .signedOut: LastContent.save(nil)
        case .stale, .failed: break
        }
        return entries.map { TodayEntry(date: $0.date, state: $0.state) }
    }
}

/// The last content shown, kept in the extension's own defaults (there is no
/// app group) so a failed fetch can still show what we had.
private enum LastContent {
    private static let key = "todayWidgetContent"

    static func load() -> TodayWidgetContent? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? WireJSON.decoder().decode(TodayWidgetContent.self, from: data)
    }

    static func save(_ content: TodayWidgetContent?) {
        guard let content, let data = try? WireJSON.encoder().encode(content) else {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        UserDefaults.standard.set(data, forKey: key)
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "co.xanom.porchlight.today", provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("Packages arriving today and out for delivery.")
        .supportedFamilies([
            .systemSmall, .systemMedium, .systemLarge,
            .accessoryRectangular, .accessoryInline, .accessoryCircular,
        ])
    }
}

/// Placeholder and preview content.
enum TodaySample {
    static var content: TodayWidgetContent {
        let now = Date()
        let packages = [
            Package(id: "00000000-0000-4000-8000-000000000001", carrier: .ups, trackingNumber: "1Z999AA10123456784",
                    title: "Headphones", status: .outForDelivery, statusDetail: "On vehicle for delivery", updatedAt: now),
            Package(id: "00000000-0000-4000-8000-000000000002", carrier: .usps, trackingNumber: "9400100000000000000000",
                    title: "Running shoes", status: .inTransit, statusDetail: "Arrived at post office",
                    eta: .day(start: CalendarDate(now, in: .current), end: nil), updatedAt: now),
            Package(id: "00000000-0000-4000-8000-000000000003", carrier: .amazon, trackingNumber: "TBA000000000000",
                    title: "Coffee filters", status: .delivered, deliveredAt: now.addingTimeInterval(-3600), updatedAt: now),
        ]
        return TodayWidgetContent.make(packages, now: now, timeZone: .current)
    }
}
