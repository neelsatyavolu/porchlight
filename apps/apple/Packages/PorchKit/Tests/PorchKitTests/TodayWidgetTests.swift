import Foundation
import Synchronization
import Testing
@testable import PorchKit

private let id1 = "00000000-0000-4000-8000-000000000001"
private let id2 = "00000000-0000-4000-8000-000000000002"
private let id3 = "00000000-0000-4000-8000-000000000003"
private let id4 = "00000000-0000-4000-8000-000000000004"
private let id5 = "00000000-0000-4000-8000-000000000005"

private func page(_ packages: [Package], cursor: String = "c", hasMore: Bool = false) -> SyncResponse {
    SyncResponse(packages: packages, events: [], deleted: [], cursor: cursor, hasMore: hasMore)
}

@Suite struct TodayWidgetContentTests {
    @Test func listsTodayThenTodaysDeliveries() {
        var archived = makePackage(id5, status: .outForDelivery)
        archived.archivedAt = NOW
        let packages = [
            makePackage(id1, eta: .day(start: day("2026-11-08"), end: nil)),
            makePackage(id2, status: .outForDelivery),
            makePackage(id3, status: .delivered, deliveredAt: "2026-11-08T16:00:00.000Z"),
            makePackage(id4, status: .delivered, deliveredAt: "2026-11-07T16:00:00.000Z"), // yesterday
            makePackage("tomorrow", eta: .day(start: day("2026-11-09"), end: nil)),
            archived,
        ]
        let content = TodayWidgetContent.make(packages, now: NOW, timeZone: LA)
        #expect(content.rows.map(\.id) == [id2, id1, id3])
        #expect(content.outForDelivery == 1)
        #expect(content.deliveredToday == 1)
        #expect(content.openCount == 2)
        #expect(content.rows[0].phrase == "Today")
        #expect(content.rows[2].phrase == "Delivered 8:00 AM")
        #expect(content.rows[0].url == URL(string: "porchlight://p/\(id2)"))
        #expect(content.summary == "1 out for delivery")
    }

    @Test func lateCountsAsToday() {
        let content = TodayWidgetContent.make([makePackage(id1, eta: .day(start: day("2026-11-03"), end: nil))], now: NOW, timeZone: LA)
        #expect(content.rows.first?.phrase == "Was due Nov 3")
        #expect(content.rows.first?.phraseMuted == true)
        #expect(content.summary == "1 package today")
    }

    @Test(arguments: [
        ([Package](), "Nothing arriving today"),
        ([makePackage(id3, status: .delivered, deliveredAt: "2026-11-08T16:00:00.000Z")], "1 delivered today"),
        ([makePackage(id1, eta: .day(start: day("2026-11-08"), end: nil)), makePackage(id2, eta: .day(start: day("2026-11-08"), end: nil))], "2 packages today"),
    ])
    func summary(_ packages: [Package], _ expected: String) {
        #expect(TodayWidgetContent.make(packages, now: NOW, timeZone: LA).summary == expected)
    }

    @Test func refreshesEvery30MinutesAndAtMidnight() {
        #expect(TodayWidgetPolicy.nextRefresh(after: NOW, timeZone: LA) == NOW.addingTimeInterval(30 * 60))
        // 11:50 PM in LA: midnight comes first.
        let late = iso("2026-11-09T07:50:00.000Z")
        #expect(TodayWidgetPolicy.nextRefresh(after: late, timeZone: LA) == iso("2026-11-09T08:00:00.000Z"))
    }

    @Test func contentRoundTripsThroughJSON() throws {
        let content = TodayWidgetContent.make([makePackage(id2, status: .outForDelivery)], now: NOW, timeZone: LA)
        let data = try WireJSON.encoder().encode(content)
        #expect(try WireJSON.decoder().decode(TodayWidgetContent.self, from: data) == content)
    }
}

@Suite struct TodayWidgetLoaderTests {
    @Test func signedOutWithoutAToken() async {
        let loader = TodayWidgetLoader(token: { nil }, fetchPage: { _ in Issue.record("fetched while signed out"); return page([]) })
        #expect(await loader.load(previous: nil, now: NOW, timeZone: LA) == .signedOut)
    }

    @Test func followsPagesUntilDone() async {
        let cursors = Mutex<[String?]>([])
        let loader = TodayWidgetLoader(token: { "t" }, fetchPage: { cursor in
            cursors.withLock { $0.append(cursor) }
            return cursor == nil
                ? page([makePackage(id1, status: .outForDelivery)], cursor: "p2", hasMore: true)
                : page([makePackage(id2, eta: .day(start: day("2026-11-08"), end: nil))])
        })
        let state = await loader.load(previous: nil, now: NOW, timeZone: LA)
        #expect(cursors.withLock { $0 } == [nil, "p2"])
        #expect(state.content?.rows.map(\.id) == [id1, id2])
    }

    @Test func stopsAfterMaxPages() async {
        let calls = Mutex(0)
        let loader = TodayWidgetLoader(token: { "t" }, fetchPage: { _ in
            calls.withLock { $0 += 1 }
            return page([], hasMore: true)
        })
        _ = await loader.load(previous: nil, now: NOW, timeZone: LA)
        #expect(calls.withLock { $0 } == TodayWidgetLoader.maxPages)
    }

    @Test func unauthorizedIsSignedOut() async {
        let loader = TodayWidgetLoader(token: { "t" }, fetchPage: { _ in
            throw APIError.server(status: 401, body: APIErrorBody(code: .unauthorized, message: "no"), retryAfter: nil)
        })
        #expect(await loader.load(previous: nil, now: NOW, timeZone: LA) == .signedOut)
    }

    @Test func failureKeepsContentFromToday() async {
        let loader = TodayWidgetLoader(token: { "t" }, fetchPage: { _ in throw APIError.network("offline") })
        let earlier = TodayWidgetContent(rows: [], outForDelivery: 0, deliveredToday: 0, fetchedAt: NOW.addingTimeInterval(-3600))
        #expect(await loader.load(previous: earlier, now: NOW, timeZone: LA) == .stale(earlier, failedAt: NOW))

        let yesterday = TodayWidgetContent(rows: [], outForDelivery: 0, deliveredToday: 0, fetchedAt: NOW.addingTimeInterval(-86_400))
        #expect(await loader.load(previous: yesterday, now: NOW, timeZone: LA) == .failed)
        #expect(await loader.load(previous: nil, now: NOW, timeZone: LA) == .failed)
    }

    @Test func addsAMidnightEntryWorkedOutForTheNewDay() async {
        // 11:50 PM in LA on Nov 8: one delivery today, one package due today.
        let late = iso("2026-11-09T07:50:00.000Z")
        let midnight = iso("2026-11-09T08:00:00.000Z")
        let loader = TodayWidgetLoader(token: { "t" }, fetchPage: { _ in
            page([
                makePackage(id1, eta: .day(start: day("2026-11-08"), end: nil)),
                makePackage(id3, status: .delivered, deliveredAt: "2026-11-08T16:00:00.000Z"),
            ])
        })
        let entries = await loader.timeline(previous: nil, now: late, timeZone: LA)
        #expect(entries.map(\.date) == [late, midnight])
        #expect(entries[0].state.content?.rows.map(\.id) == [id1, id3])
        let after = entries[1].state.content
        #expect(after?.rows.map(\.id) == [id1])
        #expect(after?.deliveredToday == 0)
        #expect(after?.rows.first?.phrase == "Was due Nov 8")

        // Midday: the next refresh comes first, so one entry.
        #expect(await loader.timeline(previous: nil, now: NOW, timeZone: LA).count == 1)
    }

    @Test func staleContentGivesWayAtMidnight() async {
        let late = iso("2026-11-09T07:50:00.000Z")
        let loader = TodayWidgetLoader(token: { "t" }, fetchPage: { _ in throw APIError.network("offline") })
        let earlier = TodayWidgetContent(rows: [], outForDelivery: 0, deliveredToday: 0, fetchedAt: late.addingTimeInterval(-600))
        let entries = await loader.timeline(previous: earlier, now: late, timeZone: LA)
        #expect(entries.map(\.state) == [.stale(earlier, failedAt: late), .failed])
    }

    @Test func staleLine() {
        let content = TodayWidgetContent(rows: [], outForDelivery: 0, deliveredToday: 0, fetchedAt: iso("2026-11-08T17:41:00.000Z"))
        #expect(TodayWidgetText.staleLine(content, timeZone: LA) == "Couldn't refresh. Showing what we had at 9:41 AM.")
    }
}
